/**
 * MarginEdge, as one more way invoices come in, for as long as it runs. Whenever its sync brings
 * something new (or a manager's import answer changes how its export reads), its export is read
 * and stored in the app's own tables:
 *
 *   ingredients   its products join the list (same ids); details kept current
 *   vendors       its vendors, by their MarginEdge id
 *   invoices      each of its invoices, unless the app already has that invoice (a photo or one
 *                 typed in, same vendor and number, or same day and total): then the two are
 *                 compared line by line (invoice_comparisons) and only the app's counts
 *
 * Taking MarginEdge out later is deleting this file, its sync and the comparisons. Nothing else
 * reads MarginEdge.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { importMarginEdge, type ImportAnswers, type ImportedInvoice, type ImportedProduct, type PricePoint } from '../connectors/marginedge.ts';
import { storedMarginEdge } from './marginedgeSync.ts';
import { syncIngredients } from './ingredients.ts';
import { insertMany } from './squareSync.ts';
import { inTurn } from './turns.ts';
import { compareInvoices, type OurLine } from '../core/invoiceCompare.ts';

const num = (n?: string | null) => (n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The same paper: same vendor, and the same number or the same day and total. */
export function sameInvoice(a: { vendorKey?: string; number?: string | null; date?: string | null; total: number }, b: { vendorKey?: string; number?: string | null; date?: string | null; total: number }): boolean {
  if (!a.vendorKey || a.vendorKey !== b.vendorKey) return false;
  if (num(a.number) && num(a.number) === num(b.number)) return true;
  return Boolean(a.date && a.date === b.date && Math.abs(a.total - b.total) < 0.01);
}

/** Runs the import if MarginEdge's data or the answers changed since the last one. */
export async function ensureMarginEdgeImported(db: Db, restaurantId: string, answers: ImportAnswers & { offInvoiceProducts?: ImportedProduct[] }): Promise<void> {
  return inTurn(`me-import:${restaurantId}`, async () => {
    const synced = (await db.query<{ stamp: string | null }>("SELECT max(finished_at)::text AS stamp FROM sync_runs WHERE restaurant_id = $1 AND source = 'marginedge' AND status = 'ok'", [restaurantId])).rows[0]?.stamp ?? '';
    const told = createHash('sha1').update(JSON.stringify([answers.packs ?? [], answers.conversions ?? {}, answers.merges ?? [], answers.offInvoiceProducts ?? []])).digest('hex');
    const stamp = `${synced}|${told}|v1`;
    const last = (await db.query<{ stamp: string }>("SELECT stamp FROM importer_state WHERE restaurant_id = $1 AND source = 'marginedge'", [restaurantId])).rows[0]?.stamp;
    if (last === stamp) return;
    const raw = await storedMarginEdge(db, restaurantId);
    if (raw) await importInto(db, restaurantId, importMarginEdge(raw, answers), answers);
    await db.query(`INSERT INTO importer_state (restaurant_id, source, stamp) VALUES ($1, 'marginedge', $2)
      ON CONFLICT (restaurant_id, source) DO UPDATE SET stamp = EXCLUDED.stamp, ran_at = now()`, [restaurantId, stamp]);
  });
}

async function importInto(db: Db, restaurantId: string, read: ReturnType<typeof importMarginEdge>, answers: ImportAnswers & { offInvoiceProducts?: ImportedProduct[] }) {
  // Ingredients: MarginEdge's join the list; merged-away ones come off it.
  const mergedAway = new Set((answers.merges ?? []).flatMap((m) => m.from.filter((f) => f !== m.into)));
  await syncIngredients(db, restaurantId, read.products, answers.offInvoiceProducts ?? [], mergedAway);

  // Vendors, by their MarginEdge id.
  const vendorRows = (await db.query<{ id: string; me_vendor_id: string | null; name: string }>('SELECT id, me_vendor_id, name FROM vendors WHERE restaurant_id = $1', [restaurantId])).rows;
  const ourVendor = new Map(vendorRows.filter((v) => v.me_vendor_id).map((v) => [v.me_vendor_id!, v]));
  for (const v of read.vendors) {
    const have = ourVendor.get(v.externalId);
    if (!have) {
      const id = randomUUID();
      await db.query("INSERT INTO vendors (id, restaurant_id, name, me_vendor_id, ordering_method) VALUES ($1, $2, $3, $4, 'other')", [id, restaurantId, v.name, v.externalId]);
      ourVendor.set(v.externalId, { id, me_vendor_id: v.externalId, name: v.name });
    } else if (have.name !== v.name) await db.query('UPDATE vendors SET name = $2 WHERE id = $1', [have.id, v.name]);
  }

  // The app's own invoices (photos, typed): an invoice MarginEdge also has is compared, not added.
  const ours = (await db.query<{ id: string; vendor_key: string | null; number: string | null; day: string; total: string }>(
    `SELECT i.id, coalesce(v.me_vendor_id, i.me_vendor_id, v.id::text) AS vendor_key, i.number, i.invoice_date::text AS day,
            coalesce(i.total, (SELECT sum(total) FROM supplier_invoice_lines WHERE invoice_id = i.id), 0)::text AS total
       FROM supplier_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.restaurant_id = $1 AND i.source <> 'marginedge'`, [restaurantId])).rows
    .map((o) => ({ id: o.id, vendorKey: o.vendor_key ?? undefined, number: o.number, date: o.day, total: Number(o.total) }));
  const pointOf = new Map(read.prices.map((p) => [`${p.invoiceExternalId}|${p.lineNumber}`, p]));
  const products = new Map(read.products.map((p) => [p.externalId, p]));

  // MarginEdge's invoices are re-stored whole each time (an answer can change how they read).
  await db.query("DELETE FROM supplier_invoices WHERE restaurant_id = $1 AND source = 'marginedge'", [restaurantId]);
  const invoiceRows: unknown[][] = [], lineRows: unknown[][] = [];
  for (const inv of read.invoices) {
    if (!inv.invoiceDate) continue;
    const twin = ours.find((o) => sameInvoice(o, { vendorKey: inv.vendorExternalId, number: inv.invoiceNumber ?? null, date: inv.invoiceDate ?? null, total: inv.total }));
    if (twin) { await compareWithOurs(db, restaurantId, twin.id, inv, pointOf, products); continue; }
    const id = randomUUID();
    const vendor = inv.vendorExternalId ? ourVendor.get(inv.vendorExternalId) : undefined;
    const charges = inv.charges ?? { tax: 0, delivery: 0, other: 0, credit: 0 };
    invoiceRows.push([id, restaurantId, vendor?.id ?? null, inv.vendorExternalId ?? null, inv.vendorName ?? vendor?.name ?? 'MarginEdge vendor', inv.invoiceDate.slice(0, 10), inv.invoiceNumber ?? null,
      'marginedge', inv.externalId, charges.tax, charges.delivery, charges.other, charges.credit, inv.total, inv.isCredit]);
    for (const l of inv.lines) {
      const pt = pointOf.get(`${inv.externalId}|${l.lineNumber}`);
      lineRows.push([id, l.lineNumber, l.productExternalId ?? null, l.vendorItemCode ?? null, l.description, l.quantity, pt?.per.unit ?? 'each', l.unitPrice, l.lineTotal,
        pt?.per.amount ?? 1, pt?.per.unit ?? null, pt && pt.perBaseUnit > 0 ? pt.price / pt.perBaseUnit : null, Boolean(pt), pt?.source ?? null]);
    }
  }
  await insertMany(db, 'supplier_invoices', ['id', 'restaurant_id', 'vendor_id', 'me_vendor_id', 'vendor_name', 'invoice_date', 'number', 'source', 'me_invoice_id', 'tax', 'delivery', 'other_charges', 'credit', 'total', 'is_credit'], invoiceRows);
  await insertMany(db, 'supplier_invoice_lines', ['invoice_id', 'line_number', 'product_id', 'code', 'description', 'quantity', 'unit', 'unit_price', 'total', 'per_amount', 'per_unit', 'per_base', 'priced', 'pack_source'], lineRows);
}

/** Ours against MarginEdge's reading of the same invoice, kept in invoice_comparisons. */
async function compareWithOurs(db: Db, restaurantId: string, ourId: string, theirs: ImportedInvoice, pointOf: Map<string, PricePoint>, products: Map<string, ImportedProduct>) {
  const ourLines: OurLine[] = (await db.query<{ product_id: string | null; description: string; quantity: string; unit: string; total: string; per_amount: string; per_unit: string | null }>(
    'SELECT product_id, description, quantity, unit, total, per_amount, per_unit FROM supplier_invoice_lines WHERE invoice_id = $1 ORDER BY line_number', [ourId])).rows
    .map((l) => ({ productId: l.product_id ?? undefined, description: l.description, quantity: Number(l.quantity) * Number(l.per_amount), unit: l.per_unit ?? l.unit, total: Number(l.total) }));
  const c = compareInvoices(ourLines, theirs, pointOf, products);
  await db.query(`INSERT INTO invoice_comparisons (restaurant_id, me_invoice_id, invoice_id, result, lines, matching, totals_match) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (restaurant_id, me_invoice_id) DO UPDATE SET invoice_id = EXCLUDED.invoice_id, result = EXCLUDED.result, lines = EXCLUDED.lines, matching = EXCLUDED.matching, totals_match = EXCLUDED.totals_match, compared_at = now()`,
    [restaurantId, theirs.externalId, ourId, JSON.stringify(c), c.lines.length, c.lines.filter((l) => l.match === 'same').length, c.totalsMatch]);
}

/**
 * Just saved one of ours that MarginEdge already has: compare the two now, and take MarginEdge's
 * copy out so the invoice counts once (as ours).
 */
export async function replaceMarginEdgeCopy(db: Db, restaurantId: string, ourId: string, meInvoiceId: string, theirs: ImportedInvoice, pointOf: Map<string, PricePoint>, products: Map<string, ImportedProduct>) {
  await compareWithOurs(db, restaurantId, ourId, theirs, pointOf, products);
  await db.query("DELETE FROM supplier_invoices WHERE restaurant_id = $1 AND source = 'marginedge' AND me_invoice_id = $2", [restaurantId, meInvoiceId]);
}
