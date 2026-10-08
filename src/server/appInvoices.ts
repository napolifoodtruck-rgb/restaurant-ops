/**
 * Invoices typed into the app: a garden harvest (at $0), a farmers-market or cash buy, a vendor
 * that isn't on MarginEdge. They join the invoices read from MarginEdge, so an ingredient's price
 * is the average of everything that came in over the last 60 days: garden basil at $0 beside
 * bought basil at $12 a pound makes $6 a pound, and back to $12 when the garden stops.
 *
 *   GET    /api/invoices              typed invoices (newest first), and the vendors to pick from
 *   POST   /api/invoices              add one: { vendor: { id } | { meId } | { name, kind }, date, number?, note?, lines: [{ productId, quantity, unit, total }] }
 *   DELETE /api/invoices/:id          take one back out
 *
 * Managers and up. Typed by hand for now; a photo of an invoice read into the same lines later.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, invalidate } from './model.ts';
import type { ImportedInvoice, ImportedProduct, ImportedVendor, PricePoint } from '../connectors/marginedge.ts';
import { withPackSize, packSize } from '../core/packSizes.ts';
import { convert } from '../core/units.ts';

export interface AppInvoiceRow {
  id: string; vendorId: string | null; meVendorId: string | null; vendorName: string; kind: 'vendor' | 'garden';
  date: string; number: string | null; note: string | null; createdAt: string;
  lines: { lineNumber: number; productId: string; description: string; quantity: number; unit: string; total: number }[];
}

/** Every typed invoice for a restaurant, with its lines. */
export async function loadAppInvoices(db: Db, restaurantId: string): Promise<AppInvoiceRow[]> {
  const invoices = (await db.query<{ id: string; vendor_id: string | null; me_vendor_id: string | null; vendor_name: string; kind: string | null; day: string; number: string | null; note: string | null; created_at: string }>(
    `SELECT i.id, i.vendor_id, i.me_vendor_id, i.vendor_name, v.kind, i.invoice_date::text AS day, i.number, i.note, i.created_at::text AS created_at
       FROM app_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.restaurant_id = $1 ORDER BY i.invoice_date DESC, i.created_at DESC`, [restaurantId])).rows;
  if (!invoices.length) return [];
  const lines = (await db.query<{ invoice_id: string; line_number: number; product_id: string; description: string; quantity: string; unit: string; total: string }>(
    'SELECT l.* FROM app_invoice_lines l JOIN app_invoices i ON i.id = l.invoice_id WHERE i.restaurant_id = $1 ORDER BY l.invoice_id, l.line_number', [restaurantId])).rows;
  return invoices.map((i) => ({
    id: i.id, vendorId: i.vendor_id, meVendorId: i.me_vendor_id, vendorName: i.vendor_name, kind: i.kind === 'garden' ? 'garden' : 'vendor',
    date: i.day, number: i.number, note: i.note, createdAt: i.created_at,
    lines: lines.filter((l) => l.invoice_id === i.id).map((l) => ({ lineNumber: Number(l.line_number), productId: l.product_id, description: l.description, quantity: Number(l.quantity), unit: l.unit, total: Number(l.total) })),
  }));
}

/** A stamp that changes whenever a typed invoice does, for the model's cache. */
export async function appInvoicesStamp(db: Db, restaurantId: string): Promise<string> {
  const r = (await db.query<{ n: string; t: string | null }>('SELECT count(*)::text AS n, max(updated_at)::text AS t FROM app_invoices WHERE restaurant_id = $1', [restaurantId])).rows[0];
  return `${r?.n ?? 0}:${r?.t ?? ''}`;
}

/** How much of a product's base unit one of `unit` is, or undefined when they don't convert. */
export function baseOf(product: ImportedProduct, unit: string): number | undefined {
  if (!product.baseUnit) return undefined;
  try {
    const n = convert({ amount: 1, unit }, product.baseUnit, withPackSize(product.conversions, product.baseUnit, packSize(product.name, product.categoryType, product.baseUnit)));
    return n > 0 ? n : undefined;
  } catch { return undefined; }
}

/**
 * Typed invoices in the shapes the MarginEdge import uses, to be added to it: vendors, invoices
 * and price points. A point carries `perBase` (base units in one purchased unit), so a $0 garden
 * line still counts what came in. Vendor ids: a MarginEdge vendor's own, or app:<uuid>.
 */
export function appImport(rows: readonly AppInvoiceRow[], products: readonly ImportedProduct[]) {
  const byId = new Map(products.map((p) => [p.externalId, p]));
  const vendors = new Map<string, ImportedVendor>();
  const garden = new Set<string>();
  const invoices: ImportedInvoice[] = [];
  const prices: PricePoint[] = [];
  for (const r of rows) {
    const vendorId = r.meVendorId ?? `app:${r.vendorId}`;
    if (!r.meVendorId) vendors.set(vendorId, { externalId: vendorId, name: r.vendorName });
    if (r.kind === 'garden') garden.add(vendorId);
    const invoiceId = `app:${r.id}`;
    invoices.push({
      externalId: invoiceId, vendorExternalId: vendorId, vendorName: r.vendorName, ...(r.number ? { invoiceNumber: r.number } : {}), invoiceDate: r.date,
      total: r.lines.reduce((a, l) => a + l.total, 0), isCredit: false, unexplainedDifference: 0,
      lines: r.lines.map((l) => ({ lineNumber: l.lineNumber, description: l.description, quantity: l.quantity, unitPrice: l.total / l.quantity, lineTotal: l.total, productExternalId: l.productId, mathChecks: true })),
    });
    for (const l of r.lines) {
      const p = byId.get(l.productId);
      const per = p ? baseOf(p, l.unit) : undefined;
      if (!p || per === undefined) continue;
      const price = l.total / l.quantity;
      prices.push({ productExternalId: l.productId, vendorExternalId: vendorId, invoiceExternalId: invoiceId, lineNumber: l.lineNumber, date: r.date, price, per: { amount: 1, unit: l.unit }, perBaseUnit: price / per, perBase: per, quantity: l.quantity, source: 'manager' });
    }
  }
  return { vendors: [...vendors.values()], invoices, prices, garden };
}

export async function invoiceRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/invoices' && !path.startsWith('/api/invoices/')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');

  if (method === 'GET' && path === '/api/invoices') {
    const model = await getModel(db, who.restaurantId, today);
    const ours = (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND active ORDER BY kind DESC, name', [who.restaurantId])).rows;
    const fromMe = model.imported.vendors.filter((v) => !v.externalId.startsWith('app:')).map((v) => ({ meId: v.externalId, name: v.name })).sort((a, b) => a.name.localeCompare(b.name));
    const name = (id: string) => model.book.products.get(id)?.name ?? id;
    const invoices = await loadAppInvoices(db, who.restaurantId);
    return send(res, 200, {
      vendors: [...ours.map((v) => ({ id: v.id, name: v.name, kind: v.kind })), ...fromMe],
      invoices: invoices.slice(0, 100).map((i) => ({ ...i, total: Math.round(i.lines.reduce((a, l) => a + l.total, 0) * 100) / 100, lines: i.lines.map((l) => ({ ...l, name: name(l.productId) })) })),
    }), true;
  }

  if (method === 'POST' && path === '/api/invoices') {
    const b = await body(req);
    const model = await getModel(db, who.restaurantId, today);
    const date = String(b.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'Pick the day it came in (not a day still to come).');
    const v = (b.vendor ?? {}) as { id?: string; meId?: string; name?: string; kind?: string };
    let vendorId: string | null = null, meVendorId: string | null = null, vendorName = '', kind = 'vendor';
    if (v.id) {
      const row = (await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM vendors WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, v.id])).rows[0];
      if (!row) throw new HttpError(400, 'Pick the vendor from the list.');
      vendorId = row.id; vendorName = row.name; kind = row.kind;
    } else if (v.meId) {
      const me = model.imported.vendors.find((x) => x.externalId === v.meId && !x.externalId.startsWith('app:'));
      if (!me) throw new HttpError(400, 'Pick the vendor from the list.');
      meVendorId = me.externalId; vendorName = me.name;
    } else {
      vendorName = String(v.name ?? '').replace(/\s+/g, ' ').trim();
      kind = v.kind === 'garden' ? 'garden' : 'vendor';
      if (!vendorName) throw new HttpError(400, 'Who is it from?');
      // One of ours by that name already, or a new one (added once the lines check out).
      const row = (await db.query<{ id: string; kind: string }>('SELECT id, kind FROM vendors WHERE restaurant_id = $1 AND lower(name) = lower($2) LIMIT 1', [who.restaurantId, vendorName])).rows[0];
      if (row) { vendorId = row.id; kind = row.kind; }
    }
    const lines = Array.isArray(b.lines) ? (b.lines as any[]) : [];
    if (!lines.length) throw new HttpError(400, 'Add at least one line.');
    const clean = lines.map((l, i) => {
      const product = model.imported.products.find((p) => p.externalId === String(l?.productId ?? '')) ?? undefined;
      const quantity = Number(l?.quantity), total = kind === 'garden' ? 0 : Number(l?.total), unit = String(l?.unit ?? '').trim();
      if (!product) throw new HttpError(400, `Line ${i + 1}: pick the ingredient from the list.`);
      if (!(quantity > 0)) throw new HttpError(400, `Line ${i + 1}: how much came in?`);
      if (!(total >= 0)) throw new HttpError(400, `Line ${i + 1}: what did it cost?`);
      if (!unit || baseOf(product, unit) === undefined) throw new HttpError(400, `Line ${i + 1}: ${product.name} is counted in ${product.baseUnit ?? 'its own unit'}; ${unit || 'that'} won’t convert. Try ${product.baseUnit}.`);
      return { lineNumber: i + 1, productId: product.externalId, description: String(l?.description ?? product.name).slice(0, 200), quantity, unit, total };
    });
    if (!vendorId && !meVendorId) vendorId = (await db.query<{ id: string }>("INSERT INTO vendors (restaurant_id, name, kind, ordering_method) VALUES ($1, $2, $3, 'other') RETURNING id", [who.restaurantId, vendorName, kind])).rows[0]!.id;
    const inv = (await db.query<{ id: string }>(
      'INSERT INTO app_invoices (restaurant_id, vendor_id, me_vendor_id, vendor_name, invoice_date, number, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [who.restaurantId, vendorId, meVendorId, vendorName, date, b.number ? String(b.number).slice(0, 60) : null, b.note ? String(b.note).slice(0, 500) : null, who.staffId])).rows[0]!;
    for (const l of clean) {
      await db.query('INSERT INTO app_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, total) VALUES ($1, $2, $3, $4, $5, $6, $7)', [inv.id, l.lineNumber, l.productId, l.description, l.quantity, l.unit, l.total]);
    }
    invalidate(who.restaurantId);
    return send(res, 200, { ok: true, id: inv.id }), true;
  }

  const one = path.match(/^\/api\/invoices\/([0-9a-f-]{36})$/);
  if (method === 'DELETE' && one) {
    const gone = await db.query('DELETE FROM app_invoices WHERE restaurant_id = $1 AND id = $2 RETURNING id', [who.restaurantId, one[1]]);
    if (!gone.rows.length) throw new HttpError(404, 'No invoice by that id.');
    invalidate(who.restaurantId);
    return send(res, 200, { ok: true }), true;
  }
  throw new HttpError(404, 'Not found.');
}
