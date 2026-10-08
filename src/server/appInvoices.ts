/**
 * Invoices saved in the app (typed in, the garden, or checked from a photo), into the one
 * invoice store (supplier_invoices). An ingredient's price is the average of everything that came
 * in over the last 60 days: garden basil at $0 beside bought basil at $12 a pound makes $6 a
 * pound, and back to $12 when the garden stops.
 *
 *   GET    /api/invoices              the app's invoices (newest first), photos to check, vendors to pick from
 *   POST   /api/invoices              add one: { vendor: { key } | { id } | { name, kind }, date, number?, note?, lines: [{ productId, quantity, unit, total }] }
 *   DELETE /api/invoices/:id          take one back out
 *   GET    /api/invoices/compare      ours against MarginEdge's reading of the same invoices, while both run
 *
 * Managers and up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, invalidate } from './model.ts';
import type { PurchasedProduct } from '../core/purchasing.ts';
import { withPackSize, packSize } from '../core/packSizes.ts';
import { convert } from '../core/units.ts';

/** How much of a product's base unit one of `unit` is, or undefined when they don't convert. */
export function baseOf(product: PurchasedProduct, unit: string): number | undefined {
  if (!product.baseUnit) return undefined;
  try {
    const n = convert({ amount: 1, unit }, product.baseUnit, withPackSize(product.conversions, product.baseUnit, packSize(product.name, product.categoryType, product.baseUnit)));
    return n > 0 ? n : undefined;
  } catch { return undefined; }
}

export async function invoiceRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/invoices' && !path.startsWith('/api/invoices/')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');

  if (method === 'GET' && path === '/api/invoices') {
    const model = await getModel(db, who.restaurantId, today);
    const ours = (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND active ORDER BY kind DESC, name', [who.restaurantId])).rows;
    const name = (id: string) => model.book.products.get(id)?.name ?? id;
    // The app's own (MarginEdge's are in the store too, but listed in MarginEdge).
    const rows = (await db.query<{ id: string; vendor_name: string; kind: string | null; day: string; number: string | null; source: string; created_at: string }>(
      `SELECT i.id, i.vendor_name, v.kind, i.invoice_date::text AS day, i.number, i.source, i.created_at::text AS created_at FROM supplier_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
        WHERE i.restaurant_id = $1 AND i.source <> 'marginedge' ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 100`, [who.restaurantId])).rows;
    const lineRows = rows.length ? (await db.query<{ invoice_id: string; line_number: number; product_id: string | null; description: string; quantity: string; unit: string; total: string }>(
      "SELECT invoice_id, line_number, product_id, description, quantity, unit, total FROM supplier_invoice_lines WHERE invoice_id = ANY(string_to_array($1, ',')::uuid[]) ORDER BY line_number", [rows.map((r) => r.id).join(',')])).rows : [];
    const invoices = rows.map((r) => ({ id: r.id, vendorName: r.vendor_name, kind: r.kind === 'garden' ? 'garden' : 'vendor', source: r.source, date: r.day, number: r.number, createdAt: r.created_at,
      lines: lineRows.filter((l) => l.invoice_id === r.id).map((l) => ({ lineNumber: Number(l.line_number), productId: l.product_id, description: l.description, quantity: Number(l.quantity), unit: l.unit, total: Number(l.total) })) }));
    // Photos still being read or waiting for a check.
    const scans = (await db.query<{ id: string; status: string; error: string | null; vendor: string | null; created_at: string }>(
      "SELECT id, status, error, result->>'vendor' AS vendor, created_at::text AS created_at FROM invoice_scans WHERE restaurant_id = $1 AND status IN ('reading', 'read', 'failed') AND created_at > now() - interval '30 days' ORDER BY created_at DESC", [who.restaurantId])).rows;
    return send(res, 200, {
      scans: scans.map((x) => ({ id: x.id, status: x.status, error: x.error, vendor: x.vendor, createdAt: x.created_at })),
      readerConnected: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      vendors: ours.map((v) => ({ id: v.id, name: v.name, kind: v.kind })),
      invoices: invoices.map((i) => ({ ...i, total: Math.round(i.lines.reduce((a, l) => a + l.total, 0) * 100) / 100, lines: i.lines.map((l) => ({ ...l, name: l.productId ? name(l.productId) : l.description })) })),
    }), true;
  }

  if (method === 'POST' && path === '/api/invoices') {
    const b = await body(req);
    const model = await getModel(db, who.restaurantId, today);
    const id = await createAppInvoice(db, who, model, today, b);
    invalidate(who.restaurantId);
    return send(res, 200, { ok: true, id }), true;
  }

  if (method === 'GET' && path === '/api/invoices/compare') {
    const model = await getModel(db, who.restaurantId, today);
    const rows = (await db.query<{ me_invoice_id: string; invoice_id: string; result: any; lines: number; matching: number; totals_match: boolean; compared_at: string; vendor_name: string; day: string; number: string | null; source: string }>(
      `SELECT c.me_invoice_id, c.invoice_id, c.result, c.lines, c.matching, c.totals_match, c.compared_at::text AS compared_at, i.vendor_name, i.invoice_date::text AS day, i.number, i.source
         FROM invoice_comparisons c JOIN supplier_invoices i ON i.id = c.invoice_id WHERE c.restaurant_id = $1 ORDER BY i.invoice_date DESC`, [who.restaurantId])).rows;
    const name = (id?: string) => (id ? model.book.products.get(id)?.name ?? id : undefined);
    const lines = rows.reduce((a, r) => a + r.lines, 0), matching = rows.reduce((a, r) => a + r.matching, 0);
    return send(res, 200, {
      invoices: rows.length, lines, matching, totalsMatching: rows.filter((r) => r.totals_match).length,
      list: rows.map((r) => { const c = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
        return { invoiceId: r.invoice_id, vendor: r.vendor_name, date: r.day, number: r.number, source: r.source, lines: r.lines, matching: r.matching, totalsMatch: r.totals_match, oursTotal: c.oursTotal, theirsTotal: c.theirsTotal,
          detail: c.lines.filter((l: any) => l.match !== 'same').map((l: any) => ({ ...l, name: name(l.productId) ?? l.description })) }; }),
    }), true;
  }

  const one = path.match(/^\/api\/invoices\/([0-9a-f-]{36})$/);
  if (method === 'DELETE' && one) {
    const gone = await db.query("DELETE FROM supplier_invoices WHERE restaurant_id = $1 AND id = $2 AND source <> 'marginedge' RETURNING id", [who.restaurantId, one[1]]);
    if (!gone.rows.length) throw new HttpError(404, 'No invoice by that id.');
    invalidate(who.restaurantId);
    return send(res, 200, { ok: true }), true;
  }
  throw new HttpError(404, 'Not found.');
}

/**
 * Saves one typed (or read) invoice: { vendor: { id } | { meId } | { name, kind }, date, number?,
 * note?, lines: [{ productId, quantity, unit, total, description? }] }. Returns its id. Checks
 * everything before writing; a new vendor is only added once the lines check out.
 */
export async function createAppInvoice(db: Db, who: SignedIn, model: Awaited<ReturnType<typeof getModel>>, today: string, b: Record<string, unknown>, scanId?: string): Promise<string> {
  const date = String(b.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'Pick the day it came in (not a day still to come).');
  const v = (b.vendor ?? {}) as { key?: string; id?: string; meId?: string; name?: string; kind?: string };
  let vendorId: string | null = null, vendorName = '', kind = 'vendor';
  // A vendor of ours, by its id or its key (the MarginEdge id one carries while both run).
  const ref = v.id ?? v.key ?? v.meId;
  if (ref) {
    const row = (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND (id::text = $2 OR me_vendor_id = $2) LIMIT 1', [who.restaurantId, ref])).rows[0];
    if (!row) throw new HttpError(400, 'Pick the vendor from the list.');
    vendorId = row.id; vendorName = row.name; kind = row.kind;
  } else {
    vendorName = String(v.name ?? '').replace(/\s+/g, ' ').trim();
    kind = v.kind === 'garden' ? 'garden' : 'vendor';
    if (!vendorName) throw new HttpError(400, 'Who is it from?');
    // One of ours by that name already, or a new one (added once the lines check out).
    const row = (await db.query<{ id: string; kind: string }>('SELECT id, kind FROM vendors WHERE restaurant_id = $1 AND lower(name) = lower($2) LIMIT 1', [who.restaurantId, vendorName])).rows[0];
    if (row) { vendorId = row.id; kind = row.kind; }
  }
  const clean = cleanLines(model, b.lines, kind === 'garden');
  if (!vendorId) vendorId = (await db.query<{ id: string }>("INSERT INTO vendors (restaurant_id, name, kind, ordering_method) VALUES ($1, $2, $3, 'other') RETURNING id", [who.restaurantId, vendorName, kind])).rows[0]!.id;
  const source = scanId ? 'photo' : kind === 'garden' ? 'garden' : 'typed';
  const total = num(b.total) ?? clean.reduce((a, l) => a + l.total, 0);
  const inv = (await db.query<{ id: string }>(
    'INSERT INTO supplier_invoices (restaurant_id, vendor_id, vendor_name, invoice_date, number, note, created_by, scan_id, source, tax, delivery, other_charges, total) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id',
    [who.restaurantId, vendorId, vendorName, date, b.number ? String(b.number).slice(0, 60) : null, b.note ? String(b.note).slice(0, 500) : null, who.staffId, scanId ?? null, source,
      num(b.tax) ?? 0, num(b.delivery) ?? 0, num(b.otherCharges) ?? 0, Math.round(total * 100) / 100])).rows[0]!;
  await insertLines(db, inv.id, clean);
  return inv.id;
}

/** Lines as sent, checked: an ingredient from the list, an amount, a cost, a unit that converts. */
function cleanLines(model: Awaited<ReturnType<typeof getModel>>, raw: unknown, free: boolean, from = 1) {
  const lines = Array.isArray(raw) ? (raw as any[]) : [];
  if (!lines.length) throw new HttpError(400, 'Add at least one line.');
  return lines.map((l, i) => {
    const product = model.purchasing.products.find((p) => p.externalId === String(l?.productId ?? '')) ?? undefined;
    const quantity = Number(l?.quantity), total = free ? 0 : Number(l?.total), unit = String(l?.unit ?? '').trim();
    if (!product) throw new HttpError(400, `Line ${i + 1}: pick the ingredient from the list.`);
    if (!(quantity > 0)) throw new HttpError(400, `Line ${i + 1}: how much came in?`);
    if (!(total >= 0)) throw new HttpError(400, `Line ${i + 1}: what did it cost?`);
    if (!unit || baseOf(product, unit) === undefined) throw new HttpError(400, `Line ${i + 1}: ${product.name} is counted in ${product.baseUnit ?? 'its own unit'}; ${unit || 'that'} won’t convert. Try ${product.baseUnit}.`);
    return { lineNumber: from + i, productId: product.externalId, description: String(l?.description ?? product.name).slice(0, 200), quantity, unit, total, code: typeof l?.code === 'string' && l.code ? l.code.slice(0, 60) : null };
  });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Lines as the store keeps them: what came in, in the unit given (one of it is one of it). */
async function insertLines(db: Db, invoiceId: string, lines: ReturnType<typeof cleanLines>) {
  for (const l of lines) {
    await db.query('INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, code, description, quantity, unit, total, per_amount, per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $7)',
      [invoiceId, l.lineNumber, l.productId, l.code, l.description, l.quantity, l.unit, l.total]);
  }
}

/** More lines on an invoice already saved: the rest of its pages, photographed later. */
export async function appendAppInvoiceLines(db: Db, who: SignedIn, model: Awaited<ReturnType<typeof getModel>>, invoiceId: string, raw: unknown): Promise<number> {
  const inv = (await db.query<{ id: string; kind: string | null; next: string }>(
    "SELECT i.id, v.kind, (SELECT coalesce(max(line_number), 0) + 1 FROM supplier_invoice_lines WHERE invoice_id = i.id)::text AS next FROM supplier_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.restaurant_id = $1 AND i.id = $2 AND i.source <> 'marginedge'", [who.restaurantId, invoiceId])).rows[0];
  if (!inv) throw new HttpError(404, 'No invoice by that id.');
  if (!Array.isArray(raw) || !raw.length) return 0;
  const clean = cleanLines(model, raw, inv.kind === 'garden', Number(inv.next));
  await insertLines(db, inv.id, clean);
  await db.query('UPDATE supplier_invoices SET total = coalesce(total, 0) + $2, updated_at = now() WHERE id = $1', [inv.id, clean.reduce((a, l) => a + l.total, 0)]);
  return clean.length;
}
