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
import { baseOf, createAppInvoice } from './appInvoices.ts';
import { readInvoice, ReaderError, type ReadInvoice, type ReadPage } from '../connectors/claudeInvoices.ts';
import { itemKey, matchInvoice, vendorKey, type Learned, type PastLine } from '../core/invoiceMatch.ts';
import { packBaseOf } from '../connectors/marginedge.ts';

/** Where the reader's key and model come from; tests swap in a pretend fetch. */
export const scanSettings = {
  apiKey: (): string | undefined => process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  model: (): string | undefined => process.env.ANTHROPIC_MODEL?.trim() || undefined,
  baseUrl: (): string | undefined => process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

const MAX_PAGES = 8;
/** bytea as a Buffer (the test database hands it back as "\\x…" text). */
const bytes = (d: unknown) => (Buffer.isBuffer(d) ? d : Buffer.from(String(d).replace(/^\\x/, ''), 'hex'));
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

async function ourVendors(db: Db, restaurantId: string) {
  return (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND active', [restaurantId])).rows;
}

/** Reads a scan's pages and stores what came back (or why it couldn't). */
export async function readScan(db: Db, restaurantId: string, scanId: string): Promise<void> {
  const apiKey = scanSettings.apiKey();
  try {
    if (!apiKey) throw new ReaderError('The invoice reader isn’t connected yet (ANTHROPIC_API_KEY in Render).');
    const pages = (await db.query<{ media_type: ReadPage['mediaType']; data: Buffer }>('SELECT media_type, data FROM invoice_scan_pages WHERE scan_id = $1 ORDER BY page', [scanId])).rows;
    const model = await getModel(db, restaurantId, new Date().toISOString().slice(0, 10)).catch(() => undefined);
    const vendors = [...new Set([...(model?.imported.vendors ?? []).map((v) => v.name), ...(await ourVendors(db, restaurantId)).map((v) => v.name)])].slice(0, 200);
    const model_ = scanSettings.model(), baseUrl = scanSettings.baseUrl();
    const r = await readInvoice(pages.map((p) => ({ mediaType: p.media_type, data: bytes(p.data) })), { apiKey, vendors, fetch: scanSettings.fetch as typeof fetch, ...(model_ ? { model: model_ } : {}), ...(baseUrl ? { baseUrl } : {}) });
    await db.query("UPDATE invoice_scans SET status = 'read', result = $2, usage = $3, error = NULL, updated_at = now() WHERE id = $1", [scanId, JSON.stringify(r.invoice), JSON.stringify({ ...r.usage, model: r.model })]);
  } catch (err) {
    const message = err instanceof ReaderError ? err.message : 'Couldn’t read it. Try again, or type it in.';
    if (!(err instanceof ReaderError)) console.error(`[invoice scan ${scanId}]`, err);
    await db.query("UPDATE invoice_scans SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [scanId, message]);
  }
}

/** What the reader saw, matched against what we know: vendors, past lines, learned answers, prices. */
async function matched(db: Db, restaurantId: string, model: Model, read: ReadInvoice) {
  const ours = await ourVendors(db, restaurantId);
  const vendors = [
    ...model.imported.vendors.filter((v) => !v.externalId.startsWith('app:')).map((v) => ({ key: v.externalId, name: v.name })),
    ...ours.map((v) => ({ key: `app:${v.id}`, name: v.name })),
  ];
  const perOf = new Map(model.imported.prices.map((p) => [`${p.invoiceExternalId}|${p.lineNumber}`, packBaseOf(p)]));
  const history: PastLine[] = [];
  for (const inv of model.imported.invoices) {
    if (!inv.vendorExternalId) continue;
    for (const l of inv.lines) {
      const per = perOf.get(`${inv.externalId}|${l.lineNumber}`);
      if (!l.productExternalId || !per) continue;
      history.push({ vendorKey: inv.vendorExternalId, ...(l.vendorItemCode ? { code: l.vendorItemCode } : {}), description: l.description, productId: l.productExternalId, perQuantity: per, unitPrice: l.unitPrice, date: inv.invoiceDate ?? '' });
    }
  }
  const learned = new Map<string, Learned>((await db.query<{ vendor_key: string; item_key: string; product_id: string; per: string }>(
    'SELECT vendor_key, item_key, product_id, per FROM vendor_item_matches WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [`${r.vendor_key}|${r.item_key}`, { productId: r.product_id, per: Number(r.per) }]));
  const products = model.imported.products.filter((p) => p.baseUnit);
  const byId = new Map(products.map((p) => [p.externalId, p]));
  const m = matchInvoice({
    read, vendors, history, learned,
    products: products.map((p) => ({ id: p.externalId, name: p.name, baseUnit: p.baseUnit! })),
    baseOf: (id, unit) => { const p = byId.get(id); return p ? baseOf(p, unit) : undefined; },
    priceNow: (id) => model.book.unitCost(id),
    // Already in, from MarginEdge or saved here before (the same photo taken twice).
    invoices: model.imported.invoices.map((i) => ({ externalId: i.externalId, ...(i.vendorExternalId ? { vendorKey: i.vendorExternalId } : {}), ...(i.invoiceNumber ? { number: i.invoiceNumber } : {}), ...(i.invoiceDate ? { date: i.invoiceDate } : {}), total: i.total })),
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

  const m = path.match(/^\/api\/invoices\/scan\/([0-9a-f-]{36})(?:\/(page)\/(\d+)|\/(save|discard|retry))?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const scan = (await db.query<{ id: string; status: string; result: any; error: string | null; usage: any; app_invoice_id: string | null; created_at: string; pages: string }>(
    'SELECT s.id, s.status, s.result, s.error, s.usage, s.app_invoice_id, s.created_at::text AS created_at, (SELECT count(*) FROM invoice_scan_pages p WHERE p.scan_id = s.id)::text AS pages FROM invoice_scans s WHERE s.restaurant_id = $1 AND s.id = $2', [who.restaurantId, m[1]])).rows[0];
  if (!scan) throw new HttpError(404, 'No invoice photo by that id.');
  const result: ReadInvoice | null = scan.result ? (typeof scan.result === 'string' ? JSON.parse(scan.result) : scan.result) : null;

  if (method === 'GET' && m[2] === 'page') {
    const page = (await db.query<{ media_type: string; data: Buffer }>('SELECT media_type, data FROM invoice_scan_pages WHERE scan_id = $1 AND page = $2', [scan.id, Number(m[3])])).rows[0];
    if (!page) throw new HttpError(404, 'No such page.');
    res.writeHead(200, { 'content-type': page.media_type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    res.end(bytes(page.data));
    return true;
  }

  if (method === 'GET' && !m[4]) {
    const model = scan.status === 'read' && result ? await getModel(db, who.restaurantId, today) : undefined;
    return send(res, 200, {
      id: scan.id, status: scan.status, error: scan.error, pages: Number(scan.pages), createdAt: scan.created_at,
      ...(scan.app_invoice_id ? { invoiceId: scan.app_invoice_id } : {}),
      ...(result ? { read: result } : {}),
      ...(model && result ? { matched: await matched(db, who.restaurantId, model, result) } : {}),
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
    // The same invoice MarginEdge already has: kept as a check of the reading, not counted twice.
    const check = await matched(db, who.restaurantId, model, result);
    let invoiceId: string | null = null;
    if (!check.duplicateOf || b.countAnyway === true) invoiceId = await createAppInvoice(db, who, model, today, b, scan.id);
    // Learn each confirmed line: this vendor's item is this ingredient, one of them holds this much.
    const vName = String((b.vendor as any)?.name ?? '') || (await (async () => {
      const v = b.vendor as any;
      if (v?.id) return (await db.query<{ name: string }>('SELECT name FROM vendors WHERE id = $1', [v.id])).rows[0]?.name ?? '';
      if (v?.meId) return model.imported.vendors.find((x) => x.externalId === v.meId)?.name ?? '';
      return result.vendor;
    })());
    for (const l of Array.isArray(b.lines) ? (b.lines as any[]) : []) {
      const key = typeof l?.itemKey === 'string' && l.itemKey ? l.itemKey : itemKey({ description: String(l?.description ?? '') });
      const per = Number(l?.perQuantity);
      if (!l?.productId || !(per > 0) || !key) continue;
      await db.query(`INSERT INTO vendor_item_matches (restaurant_id, vendor_key, item_key, product_id, unit, per) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (restaurant_id, vendor_key, item_key) DO UPDATE SET product_id = EXCLUDED.product_id, unit = EXCLUDED.unit, per = EXCLUDED.per, confirmed_at = now()`,
        [who.restaurantId, vendorKey(vName), key, String(l.productId), String(l.unit ?? ''), per]);
    }
    await db.query("UPDATE invoice_scans SET status = 'saved', app_invoice_id = $2, updated_at = now() WHERE id = $1", [scan.id, invoiceId]);
    if (invoiceId) invalidate(who.restaurantId);
    return send(res, 200, { ok: true, invoiceId, checkOnly: !invoiceId }), true;
  }
  throw new HttpError(404, 'Not found.');
}
