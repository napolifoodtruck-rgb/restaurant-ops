/**
 * Invoices from a photo: the pages are kept, Claude reads them in the background, and a manager
 * checks the lines beside the photo before anything is priced.
 *
 *   POST /api/invoices/scan                 { pages: [{ mediaType, data (base64) }] } → { id }; reading starts
 *   GET  /api/invoices/scan/:id             status, and when read: the lines matched to ingredients, with flags
 *   GET  /api/invoices/scan/:id/page/:n     a page, as taken
 *   POST /api/invoices/scan/:id/save        the checked invoice (as POST /api/invoices takes it, lines also
 *                                           carrying itemKey and perQuantity to learn from); a duplicate of one
 *                                           MarginEdge already has is kept as a check only
 *   POST /api/invoices/scan/:id/discard
 *   POST /api/invoices/scan/:id/retry       read it again (after a failure)
 *
 * Managers and up. Needs ANTHROPIC_API_KEY.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, invalidate, type Model } from './model.ts';
import { appendAppInvoiceLines, baseOf, createAppInvoice } from './appInvoices.ts';
import { replaceMarginEdgeCopy } from './meImport.ts';
import { readInvoice, ReaderError, type ReadInvoice, type ReadPage } from '../connectors/claudeInvoices.ts';
import { autoCountable, itemKey, matchInvoice, vendorKey, type Learned, type PastLine } from '../core/invoiceMatch.ts';
import { localNow } from './online.ts';
import { packBaseOf } from '../core/purchasing.ts';
import { claudeSettings } from '../connectors/claude.ts';

/** Where the reader's key and model come from; tests swap in a pretend fetch (shared with every Claude reader). */
export const scanSettings = claudeSettings;

const MAX_PAGES = 8;
/** bytea as a Buffer (the test database hands it back as "\\x…" text). */
const bytes = (d: unknown) => (Buffer.isBuffer(d) ? d : Buffer.from(String(d).replace(/^\\x/, ''), 'hex'));
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

async function ourVendors(db: Db, restaurantId: string) {
  return (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND active', [restaurantId])).rows;
}

/** Reads a scan's pages and stores what came back (or why it couldn't). */
export async function readScan(db: Db, restaurantId: string, scanId: string, after?: () => Promise<unknown>): Promise<void> {
  const apiKey = scanSettings.apiKey();
  try {
    if (!apiKey) throw new ReaderError('The invoice reader isn’t connected yet (ANTHROPIC_API_KEY in Render).');
    const pages = (await db.query<{ media_type: ReadPage['mediaType']; data: Buffer }>('SELECT media_type, data FROM invoice_scan_pages WHERE scan_id = $1 ORDER BY page', [scanId])).rows;
    const model = await getModel(db, restaurantId, new Date().toISOString().slice(0, 10)).catch(() => undefined);
    const vendors = [...new Set([...(model?.purchasing.vendors ?? []).map((v) => v.name), ...(await ourVendors(db, restaurantId)).map((v) => v.name)])].slice(0, 200);
    const model_ = scanSettings.model(), baseUrl = scanSettings.baseUrl();
    const r = await readInvoice(pages.map((p) => ({ mediaType: p.media_type, data: bytes(p.data) })), { apiKey, vendors, fetch: scanSettings.fetch as typeof fetch, ...(model_ ? { model: model_ } : {}), ...(baseUrl ? { baseUrl } : {}) });
    await db.query("UPDATE invoice_scans SET status = 'read', result = $2, usage = $3, error = NULL, updated_at = now() WHERE id = $1", [scanId, JSON.stringify(r.invoice), JSON.stringify({ ...r.usage, model: r.model })]);
  } catch (err) {
    after = undefined;
    const message = err instanceof ReaderError ? err.message : 'Couldn’t read it. Try again, or type it in.';
    if (!(err instanceof ReaderError)) console.error(`[invoice scan ${scanId}]`, err);
    await db.query("UPDATE invoice_scans SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [scanId, message]);
  }
  await after?.().catch((err) => console.error(`[invoice scan ${scanId}] after reading`, err));
}

/** What the reader saw, matched against what we know: vendors, past lines, learned answers, prices. */
async function matched(db: Db, restaurantId: string, model: Model, read: ReadInvoice) {
  const vendors = model.purchasing.vendors.map((v) => ({ key: v.externalId, name: v.name }));
  const perOf = new Map(model.purchasing.prices.map((p) => [`${p.invoiceExternalId}|${p.lineNumber}`, packBaseOf(p)]));
  const history: PastLine[] = [];
  for (const inv of model.purchasing.invoices) {
    if (!inv.vendorExternalId) continue;
    for (const l of inv.lines) {
      const per = perOf.get(`${inv.externalId}|${l.lineNumber}`);
      if (!l.productExternalId || !per) continue;
      history.push({ vendorKey: inv.vendorExternalId, ...(l.vendorItemCode ? { code: l.vendorItemCode } : {}), description: l.description, productId: l.productExternalId, perQuantity: per, unitPrice: l.unitPrice, date: inv.invoiceDate ?? '' });
    }
  }
  // Learned per vendor, under the same key the vendors above carry.
  const learned = new Map<string, Learned>((await db.query<{ vendor_key: string; item_key: string; product_id: string; per: string }>(
    `SELECT coalesce(v.me_vendor_id, v.id::text) AS vendor_key, m.item_key, m.product_id, m.per
       FROM vendor_item_matches m JOIN vendors v ON v.id = m.vendor_id WHERE m.restaurant_id = $1`, [restaurantId])).rows
    .map((r) => [`${r.vendor_key}|${r.item_key}`, { productId: r.product_id, per: Number(r.per) }]));
  const products = model.purchasing.products.filter((p) => p.baseUnit);
  const byId = new Map(products.map((p) => [p.externalId, p]));
  const m = matchInvoice({
    read, vendors, history, learned,
    products: products.map((p) => ({ id: p.externalId, name: p.name, baseUnit: p.baseUnit! })),
    baseOf: (id, unit) => { const p = byId.get(id); return p ? baseOf(p, unit) : undefined; },
    priceNow: (id) => model.book.unitCost(id),
    // Already in, from MarginEdge or saved here before (the same photo taken twice).
    invoices: model.purchasing.invoices.map((i) => {
      const source = model.invoiceSources.get(i.externalId) === 'marginedge' ? 'marginedge' as const : 'app' as const;
      return { externalId: i.externalId, source, ...(i.vendorExternalId ? { vendorKey: i.vendorExternalId } : {}), ...(i.invoiceNumber ? { number: i.invoiceNumber } : {}), ...(i.invoiceDate ? { date: i.invoiceDate } : {}), total: i.total,
        ...(source === 'app' ? { lines: i.lines.map((l) => ({ description: l.description, total: l.lineTotal })) } : {}) };
    }),
  });
  return { ...m, lines: m.lines.map((l) => ({ ...l, ...(l.productId ? { productName: byId.get(l.productId)?.name ?? l.productId } : {}) })) };
}

export async function scanRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/invoices/scan')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');

  if (method === 'POST' && path === '/api/invoices/scan') {
    const b = await body(req, 20 * 1024 * 1024);
    const pages = Array.isArray(b.pages) ? (b.pages as any[]) : [];
    if (!pages.length) throw new HttpError(400, 'Add a photo of the invoice.');
    if (pages.length > MAX_PAGES) throw new HttpError(400, `Up to ${MAX_PAGES} pages at a time.`);
    const clean = pages.map((p, i) => {
      const mediaType = String(p?.mediaType ?? '');
      const data = Buffer.from(String(p?.data ?? ''), 'base64');
      if (!MEDIA.has(mediaType)) throw new HttpError(400, `Page ${i + 1}: a photo (JPEG, PNG) or a PDF.`);
      if (data.length < 100 || data.length > 8 * 1024 * 1024) throw new HttpError(400, `Page ${i + 1} is too ${data.length < 100 ? 'small' : 'big'}.`);
      return { mediaType, data };
    });
    const id = (await db.query<{ id: string }>('INSERT INTO invoice_scans (restaurant_id, created_by) VALUES ($1, $2) RETURNING id', [who.restaurantId, who.staffId])).rows[0]!.id;
    for (const [i, p] of clean.entries()) await db.query('INSERT INTO invoice_scan_pages (scan_id, page, media_type, data) VALUES ($1, $2, $3, $4)', [id, i + 1, p.mediaType, p.data]);
    // Read in the background; the page asks how it's going.
    void readScan(db, who.restaurantId, id);
    return send(res, 200, { id, connected: Boolean(scanSettings.apiKey()) }), true;
  }

  const m = path.match(/^\/api\/invoices\/scan\/([0-9a-f-]{36})(?:\/(page)\/(\d+)|\/(save|discard|retry|join))?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const scan = (await db.query<{ id: string; status: string; result: any; error: string | null; usage: any; invoice_id: string | null; created_at: string; pages: string }>(
    'SELECT s.id, s.status, s.result, s.error, s.usage, s.invoice_id, s.created_at::text AS created_at, (SELECT count(*) FROM invoice_scan_pages p WHERE p.scan_id = s.id)::text AS pages FROM invoice_scans s WHERE s.restaurant_id = $1 AND s.id = $2', [who.restaurantId, m[1]])).rows[0];
  if (!scan) throw new HttpError(404, 'No invoice photo by that id.');
  const result: ReadInvoice | null = scan.result ? (typeof scan.result === 'string' ? JSON.parse(scan.result) : scan.result) : null;

  if (method === 'GET' && m[2] === 'page') {
    const page = (await db.query<{ media_type: string; data: Buffer }>('SELECT media_type, data FROM invoice_scan_pages WHERE scan_id = $1 AND page = $2', [scan.id, Number(m[3])])).rows[0];
    if (!page) throw new HttpError(404, 'No such page.');
    res.writeHead(200, { 'content-type': page.media_type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    res.end(bytes(page.data));
    return true;
  }

  if (method === 'POST' && m[4] === 'join') {
    // This photo is more pages of another one not yet saved: its pages go on the end, read again.
    const b = await body(req);
    const into = String(b.into ?? '');
    const other = (await db.query<{ id: string; status: string }>('SELECT id, status FROM invoice_scans WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, into])).rows[0];
    if (!other || other.id === scan.id || !['read', 'failed'].includes(other.status) || scan.status === 'saved') throw new HttpError(409, 'Those can’t be joined.');
    await db.query('UPDATE invoice_scan_pages SET scan_id = $1, page = page + (SELECT coalesce(max(page), 0) FROM invoice_scan_pages WHERE scan_id = $1) WHERE scan_id = $2', [other.id, scan.id]);
    await db.query("UPDATE invoice_scans SET status = 'discarded', updated_at = now() WHERE id = $1", [scan.id]);
    await db.query("UPDATE invoice_scans SET status = 'reading', error = NULL, updated_at = now() WHERE id = $1", [other.id]);
    void readScan(db, who.restaurantId, other.id);
    return send(res, 200, { ok: true, id: other.id }), true;
  }

  if (method === 'GET' && !m[4]) {
    const model = scan.status === 'read' && result ? await getModel(db, who.restaurantId, today) : undefined;
    // Another photo, not saved yet, of the same invoice (same vendor and number): likely its other pages.
    const samePaper = result?.invoiceNumber ? (await db.query<{ id: string; pages: string; created_at: string; vendor: string; number: string }>(
      `SELECT s.id, (SELECT count(*) FROM invoice_scan_pages p WHERE p.scan_id = s.id)::text AS pages, s.created_at::text AS created_at, s.result->>'vendor' AS vendor, s.result->>'invoiceNumber' AS number
         FROM invoice_scans s WHERE s.restaurant_id = $1 AND s.id <> $2 AND s.status = 'read' AND s.created_at > now() - interval '14 days'`, [who.restaurantId, scan.id])).rows
      .filter((o) => vendorKey(o.vendor ?? '') === vendorKey(result.vendor) && (o.number ?? '').replace(/\W/g, '').toLowerCase() === result.invoiceNumber!.replace(/\W/g, '').toLowerCase())
      .map((o) => ({ id: o.id, pages: Number(o.pages), createdAt: o.created_at })) : [];
    const pageTypes = (await db.query<{ media_type: string }>('SELECT media_type FROM invoice_scan_pages WHERE scan_id = $1 ORDER BY page', [scan.id])).rows.map((p) => p.media_type);
    return send(res, 200, {
      id: scan.id, status: scan.status, error: scan.error, pages: Number(scan.pages), pageTypes, createdAt: scan.created_at,
      ...(scan.invoice_id ? { invoiceId: scan.invoice_id } : {}),
      ...(result ? { read: result } : {}),
      ...(model && result ? { matched: await matched(db, who.restaurantId, model, result) } : {}),
      ...(samePaper.length ? { samePaper } : {}),
    }), true;
  }

  if (method === 'POST' && m[4] === 'discard') {
    await db.query("UPDATE invoice_scans SET status = 'discarded', updated_at = now() WHERE id = $1 AND status <> 'saved'", [scan.id]);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && m[4] === 'retry') {
    if (scan.status === 'saved') throw new HttpError(409, 'Already saved.');
    await db.query("UPDATE invoice_scans SET status = 'reading', error = NULL, updated_at = now() WHERE id = $1", [scan.id]);
    void readScan(db, who.restaurantId, scan.id);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && m[4] === 'save') {
    if (scan.status === 'saved') throw new HttpError(409, 'Already saved.');
    if (scan.status !== 'read' || !result) throw new HttpError(409, 'Still reading.');
    const b = await body(req, 256 * 1024);
    const model = await getModel(db, who.restaurantId, today);
    const invoiceId = await saveScan(db, who, scan.id, model, result, b, today);
    return send(res, 200, { ok: true, invoiceId }), true;
  }
  throw new HttpError(404, 'Not found.');
}

/**
 * A read invoice, saved: a new one of ours (compared with MarginEdge's copy when it has one), or the
 * rest of one saved before. Each line confirmed is learned for next time.
 */
async function saveScan(db: Db, who: Pick<SignedIn, 'restaurantId'> & { staffId: string | null }, scanId: string, model: Model, result: ReadInvoice, b: Record<string, unknown>, today: string): Promise<string> {
  {
    // The same invoice MarginEdge already has: kept as a check of the reading, not counted twice.
    const check = await matched(db, who.restaurantId, model, result);
    let invoiceId: string;
    if (check.duplicateOf?.source === 'app') {
      // Saved here before (another photo of it): the lines it didn't have go onto it.
      invoiceId = check.duplicateOf.externalId;
      await appendAppInvoiceLines(db, who as SignedIn, model, invoiceId, b.lines);
    } else {
      invoiceId = await createAppInvoice(db, who as SignedIn, model, today, b, scanId);
      // MarginEdge has it too: the two are compared, and ours (checked) is the one that counts.
      const theirs = check.duplicateOf ? model.purchasing.invoices.find((i) => i.externalId === check.duplicateOf!.externalId) : undefined;
      if (theirs) await replaceMarginEdgeCopy(db, who.restaurantId, invoiceId, theirs.externalId, theirs,
        new Map(model.purchasing.prices.map((p) => [`${p.invoiceExternalId}|${p.lineNumber}`, p])), new Map(model.purchasing.products.map((p) => [p.externalId, p])));
    }
    // Learn each confirmed line: this vendor's item is this ingredient, one of them holds this much.
    const vendorId = (await db.query<{ vendor_id: string | null }>('SELECT vendor_id FROM supplier_invoices WHERE id = $1', [invoiceId])).rows[0]?.vendor_id;
    for (const l of vendorId && Array.isArray(b.lines) ? (b.lines as any[]) : []) {
      const key = typeof l?.itemKey === 'string' && l.itemKey ? l.itemKey : itemKey({ description: String(l?.description ?? '') });
      const per = Number(l?.perQuantity);
      if (!l?.productId || !(per > 0) || !key) continue;
      await db.query(`INSERT INTO vendor_item_matches (restaurant_id, vendor_id, item_key, product_id, unit, per) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (restaurant_id, vendor_id, item_key) DO UPDATE SET product_id = EXCLUDED.product_id, unit = EXCLUDED.unit, per = EXCLUDED.per, confirmed_at = now()`,
        [who.restaurantId, vendorId, key, String(l.productId), String(l.unit ?? ''), per]);
    }
    await db.query("UPDATE invoice_scans SET status = 'saved', invoice_id = $2, updated_at = now() WHERE id = $1", [scanId, invoiceId]);
    invalidate(who.restaurantId);
    return invoiceId;
  }
}

/**
 * An emailed invoice from a vendor we already buy from, every line one we've matched before and
 * nothing odd on it: counted without anyone checking it. Otherwise it waits with the others to
 * check, and says why.
 */
export async function autoCount(db: Db, restaurantId: string, scanId: string): Promise<{ counted: boolean; why?: string; invoiceId?: string }> {
  const scan = (await db.query<{ status: string; result: any; tz: string; received: string }>(
    `SELECT s.status, s.result, r.timezone AS tz, s.created_at::text AS received FROM invoice_scans s JOIN restaurants r ON r.id = s.restaurant_id WHERE s.id = $1 AND s.restaurant_id = $2`, [scanId, restaurantId])).rows[0];
  if (!scan || scan.status !== 'read' || !scan.result) return { counted: false, why: 'Not read.' };
  const result: ReadInvoice = typeof scan.result === 'string' ? JSON.parse(scan.result) : scan.result;
  const today = localNow(scan.tz).date;
  const model = await getModel(db, restaurantId, today);
  const mt = await matched(db, restaurantId, model, result);
  const verdict = autoCountable(mt);
  if (!verdict.ok) return { counted: false, why: verdict.why };
  const date = mt.date && mt.date <= today ? mt.date : today;
  const invoiceId = await saveScan(db, { restaurantId, staffId: null }, scanId, model, result, {
    vendor: { key: mt.vendor.key }, date, ...(mt.number ? { number: mt.number } : {}), note: 'Counted automatically from an email.',
    lines: verdict.lines.map((l) => ({ productId: l.productId, quantity: l.baseQuantity, unit: l.baseUnit, total: l.read.total, description: l.read.description, itemKey: l.itemKey,
      ...(l.read.code ? { code: l.read.code } : {}), ...(l.perQuantity ? { perQuantity: l.perQuantity } : {}) })),
  }, today);
  return { counted: true, invoiceId };
}
