/**
 * Every invoice the restaurant has, whatever brought it in (a photo, typed in, the garden, or
 * MarginEdge's importer while it runs), read from supplier_invoices / supplier_invoice_lines into
 * the shapes the rest of the app works with: vendors, invoices with lines, and price points.
 *
 * Ids the rest of the app keys on stay stable: a vendor is its MarginEdge id if it has one, else
 * its own; an invoice from MarginEdge keeps MarginEdge's id, any other is its own.
 */

import type { Db } from './db.ts';
import type { SupplierInvoice, PurchasedProduct, Supplier, PricePoint } from '../core/purchasing.ts';
import { withPackSize, packSize } from '../core/packSizes.ts';
import { convert, type Quantity } from '../core/units.ts';

export type InvoiceSource = 'typed' | 'garden' | 'photo' | 'marginedge';

export interface Store {
  vendors: Supplier[];
  invoices: SupplierInvoice[];
  prices: PricePoint[];
  /** Vendor keys that are the restaurant's own garden. */
  garden: Set<string>;
  /** Where each invoice came from, by its id. */
  sources: Map<string, InvoiceSource>;
}

/** Base units in `per` of a product, or undefined when they don't convert. */
export function baseIn(product: PurchasedProduct, per: Quantity): number | undefined {
  if (!product.baseUnit) return undefined;
  try {
    const n = convert(per, product.baseUnit, withPackSize(product.conversions, product.baseUnit, packSize(product.name, product.categoryType, product.baseUnit)));
    return n > 0 ? n : undefined;
  } catch { return undefined; }
}

/** A stamp that changes whenever an invoice does, for the model's cache. */
export async function storeStamp(db: Db, restaurantId: string): Promise<string> {
  const r = (await db.query<{ n: string; t: string | null }>('SELECT count(*)::text AS n, max(updated_at)::text AS t FROM supplier_invoices WHERE restaurant_id = $1', [restaurantId])).rows[0];
  return `${r?.n ?? 0}:${r?.t ?? ''}`;
}

const mathChecks = (quantity: number, unitPrice: number | null, total: number) => unitPrice === null || Math.abs(quantity * unitPrice - total) <= Math.max(0.02, Math.abs(total) * 0.005);

export async function loadStore(db: Db, restaurantId: string, products: readonly PurchasedProduct[]): Promise<Store> {
  const vendorRows = (await db.query<{ id: string; name: string; kind: string; me_vendor_id: string | null }>(
    'SELECT id, name, kind, me_vendor_id FROM vendors WHERE restaurant_id = $1', [restaurantId])).rows;
  const keyOf = new Map(vendorRows.map((v) => [v.id, v.me_vendor_id ?? v.id]));
  const vendors = vendorRows.map((v) => ({ externalId: keyOf.get(v.id)!, name: v.name }));
  const garden = new Set(vendorRows.filter((v) => v.kind === 'garden').map((v) => keyOf.get(v.id)!));

  const invoiceRows = (await db.query<{ id: string; me_invoice_id: string | null; vendor_id: string | null; me_vendor_id: string | null; vendor_name: string; day: string; number: string | null; source: InvoiceSource;
    tax: string; delivery: string; other_charges: string; credit: string; total: string | null; is_credit: boolean }>(
    `SELECT id, me_invoice_id, vendor_id, me_vendor_id, vendor_name, invoice_date::text AS day, number, source, tax, delivery, other_charges, credit, total, is_credit
       FROM supplier_invoices WHERE restaurant_id = $1 ORDER BY invoice_date`, [restaurantId])).rows;
  const lineRows = (await db.query<{ invoice_id: string; line_number: number; product_id: string | null; code: string | null; description: string; quantity: string; unit: string; unit_price: string | null; total: string;
    per_amount: string; per_unit: string | null; per_base: string | null; priced: boolean; pack_source: string | null }>(
    `SELECT l.invoice_id, l.line_number, l.product_id, l.code, l.description, l.quantity, l.unit, l.unit_price, l.total, l.per_amount, l.per_unit, l.per_base, l.priced, l.pack_source
       FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id WHERE i.restaurant_id = $1 ORDER BY l.invoice_id, l.line_number`, [restaurantId])).rows;
  const linesOf = new Map<string, typeof lineRows>();
  for (const l of lineRows) linesOf.set(l.invoice_id, [...(linesOf.get(l.invoice_id) ?? []), l]);
  const byId = new Map(products.map((p) => [p.externalId, p]));

  const invoices: SupplierInvoice[] = [];
  const prices: PricePoint[] = [];
  const sources = new Map<string, InvoiceSource>();
  for (const i of invoiceRows) {
    const externalId = i.me_invoice_id ?? i.id;
    const vendorKey = (i.vendor_id ? keyOf.get(i.vendor_id) : undefined) ?? i.me_vendor_id ?? undefined;
    sources.set(externalId, i.source);
    const lines = (linesOf.get(i.id) ?? []).map((l) => {
      const quantity = Number(l.quantity), total = Number(l.total), unitPrice = l.unit_price === null ? null : Number(l.unit_price);
      return { row: l, quantity, total, unitPrice, line: {
        lineNumber: Number(l.line_number), ...(l.code ? { vendorItemCode: l.code } : {}), description: l.description, quantity,
        unitPrice: unitPrice ?? (quantity ? total / quantity : 0), lineTotal: total, ...(l.product_id ? { productExternalId: l.product_id } : {}), mathChecks: mathChecks(quantity, unitPrice, total),
      } };
    });
    const linesTotal = lines.reduce((a, l) => a + l.total, 0);
    const total = i.total === null ? linesTotal : Number(i.total);
    const explained = linesTotal + Number(i.tax) + Number(i.delivery) + Number(i.other_charges) - Number(i.credit);
    invoices.push({
      externalId, ...(vendorKey ? { vendorExternalId: vendorKey } : {}), vendorName: i.vendor_name, ...(i.number ? { invoiceNumber: i.number } : {}), invoiceDate: i.day,
      total, isCredit: i.is_credit, lines: lines.map((l) => l.line), unexplainedDifference: Math.round((total - explained) * 100) / 100,
    });
    // A price from every line that counts: what one purchased unit cost, and what it held.
    if (i.is_credit) continue;
    for (const l of lines) {
      const p = l.row.product_id ? byId.get(l.row.product_id) : undefined;
      if (!p || !l.row.priced || !l.line.mathChecks) continue;
      const per = { amount: Number(l.row.per_amount), unit: l.row.per_unit ?? l.row.unit };
      // As the importer worked it out, else from the ingredient's units now.
      const perBase = l.row.per_base !== null ? Number(l.row.per_base) : baseIn(p, per);
      if (perBase === undefined || !(perBase > 0)) continue;
      const price = l.unitPrice ?? l.total / l.quantity;
      if (!(price >= 0)) continue;
      prices.push({
        productExternalId: p.externalId, ...(vendorKey ? { vendorExternalId: vendorKey } : {}), invoiceExternalId: externalId, lineNumber: l.line.lineNumber, date: i.day,
        price, per, perBaseUnit: price / perBase, perBase, quantity: l.quantity, source: (l.row.pack_source as PricePoint['source']) ?? 'manager',
      });
    }
  }
  prices.sort((a, b) => a.date.localeCompare(b.date));
  return { vendors, invoices, prices, garden, sources };
}
