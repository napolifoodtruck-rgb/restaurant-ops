import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { blendedPrices, importMarginEdge, type MarginEdgeExport } from '../src/connectors/marginedge.ts';
import { migrate } from '../src/server/db.ts';
import { getModel, invalidate } from '../src/server/model.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

const sample: MarginEdgeExport = {
  categories: [{ categoryId: '1450', categoryName: 'Produce', categoryType: 'FOOD' }, { categoryId: '1456', categoryName: 'Wine', categoryType: 'WINE' }],
  products: [
    { companyConceptProductId: 'garlic', productName: 'Garlic, Peeled', reportByUnit: 'Pound', latestPrice: 4.1, categories: [{ categoryId: '1450', percentAllocation: 100 }] },
    { companyConceptProductId: 'limes', productName: 'Limes, Fresh', reportByUnit: 'Pound', latestPrice: 0.74 },
    { companyConceptProductId: 'sage', productName: 'Herb, Sage', reportByUnit: 'Pound', latestPrice: 36 },
    { companyConceptProductId: 'spinach', productName: 'Spinach, Baby', reportByUnit: 'Each', latestPrice: 5.92 },
    { companyConceptProductId: 'basil', productName: 'Basil, Fresh', reportByUnit: 'Pound', latestPrice: 12 },
    { companyConceptProductId: 'aperol', productName: 'Aperol Aperitivo', reportByUnit: 'Bottle (750 Milliliters)', latestPrice: 29.95, categories: [{ categoryId: '1456', percentAllocation: 100 }] },
    { companyConceptProductId: 'mystery', productName: 'Misc', reportByUnit: 'Other' },
  ],
  vendors: [{ vendorId: 1, vendorName: 'Blue Sky Farms' }, { vendorId: 2, vendorName: 'Empire Distributors' }],
  vendorItems: [
    { vendorItemCode: 'APE750', vendorId: 2, companyConceptProductId: 'aperol', packagings: [{ packagingId: '92132', packagingName: '750ML Btl', quantity: 1, unit: 'BOTTLE' }] },
  ],
  invoices: [
    {
      orderId: 'o1', invoiceNumber: 'BS-1', invoiceDate: '2026-09-28', vendorId: 1, vendorName: 'Blue Sky Farms', orderTotal: 76.25, isCredit: false,
      lineItems: [
        { vendorItemCode: '', vendorItemName: 'Garlic, Peeled 5 Lb', quantity: 1, unitPrice: 20.5, linePrice: 20.5, companyConceptProductId: 'garlic', packagingId: 63619 },
        { vendorItemCode: '', vendorItemName: 'Limes 40LB', quantity: 1, unitPrice: 29.75, linePrice: 29.75, companyConceptProductId: 'limes', packagingId: 63620 },
        { vendorItemCode: '', vendorItemName: 'Herb, Sage', quantity: 1, unitPrice: 9, linePrice: 9, companyConceptProductId: 'sage', packagingId: 63621 },
        { vendorItemCode: '', vendorItemName: 'Charity', quantity: 1, unitPrice: 0.5, linePrice: 0.5, companyConceptProductId: 'mystery', packagingId: 63622 },
        { vendorItemCode: '', vendorItemName: 'Spinach, Baby Trimmed 4lb (bag)', quantity: 1, unitPrice: 16.5, linePrice: 16.5, companyConceptProductId: 'spinach', packagingId: 63623 },
      ],
    },
    {
      orderId: 'o2', invoiceNumber: 'BS-2', invoiceDate: '2026-10-02', vendorId: 1, vendorName: 'Blue Sky Farms', orderTotal: 28.1,
      lineItems: [
        { vendorItemCode: '', vendorItemName: 'Basil', quantity: 2, unitPrice: 12, linePrice: 24, companyConceptProductId: 'basil', packagingId: 1 },
        // The latest garlic purchase is by the pound, so nothing to calibrate and the 5 lb bag reads from its name.
        { vendorItemCode: '', vendorItemName: 'Garlic, Peeled', quantity: 1, unitPrice: 4.1, linePrice: 4.1, companyConceptProductId: 'garlic', packagingId: 2 },
      ],
    },
    {
      orderId: 'o3', invoiceNumber: 'E-9', invoiceDate: '2026-09-26', vendorId: 2, vendorName: 'Empire Distributors', orderTotal: 130,
      lineItems: [{ vendorItemCode: 'APE750', vendorItemName: 'Aperol F', quantity: 2, unitPrice: 29.95, linePrice: 59.9, companyConceptProductId: 'aperol', packagingId: 92132 }], // numeric id, like the real export
    },
    {
      orderId: 'o4', invoiceNumber: 'E-10', invoiceDate: '2026-09-27', vendorId: 2, vendorName: 'Empire Distributors', orderTotal: 60,
      lineItems: [{ vendorItemCode: 'APE750', vendorItemName: 'Aperol F', quantity: 2, unitPrice: 29.95, linePrice: 65, companyConceptProductId: 'aperol', packagingId: 92132 }],
    },
    { orderId: 'o5', invoiceNumber: 'X', vendorId: 2, detailError: 'MarginEdge returned 500' },
  ],
};

test('one invoice store: MarginEdge imported once, ours compared, the garden counted', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  const rid = (await db!.query<{ id: string }>("INSERT INTO restaurants (name) VALUES ('Napoli') RETURNING id")).rows[0]!.id;
  for (const part of ['categories', 'products', 'vendors', 'vendorItems', 'invoices'] as const) {
    await db!.query('INSERT INTO marginedge_data (restaurant_id, part, data) VALUES ($1, $2, $3)', [rid, part, JSON.stringify(sample[part])]);
  }
  await db!.query("INSERT INTO sync_runs (restaurant_id, source, status, finished_at) VALUES ($1, 'marginedge', 'ok', now() - interval '1 hour')", [rid]);

  // First read: everything MarginEdge has is in the app's own tables, and prices read the same.
  const before = importMarginEdge(sample);
  const m1 = await getModel(db!, rid, '2026-10-05');
  assert.equal(Number((await db!.query<{ n: string }>('SELECT count(*)::text AS n FROM ingredients WHERE restaurant_id = $1', [rid])).rows[0]!.n), before.products.length);
  assert.deepEqual((await db!.query<{ me_vendor_id: string }>('SELECT me_vendor_id FROM vendors WHERE restaurant_id = $1 ORDER BY me_vendor_id', [rid])).rows.map((r) => r.me_vendor_id), ['1', '2']);
  assert.equal(Number((await db!.query<{ n: string }>("SELECT count(*)::text AS n FROM supplier_invoices WHERE restaurant_id = $1 AND source = 'marginedge'", [rid])).rows[0]!.n), before.invoices.length);
  const old = blendedPrices(before.prices, '2026-10-05'), now = blendedPrices(m1.imported.prices, '2026-10-05');
  for (const [id, p] of old) assert.ok(Math.abs((now.get(id) ?? NaN) - p) < 1e-9, `${id}: ${now.get(id)} vs ${p}`);
  assert.equal(m1.imported.prices.length, before.prices.length);

  // A photo of BS-2, saved in the app: MarginEdge's copy is compared with it, and only ours counts.
  const blueSky = (await db!.query<{ id: string }>("SELECT id FROM vendors WHERE restaurant_id = $1 AND me_vendor_id = '1'", [rid])).rows[0]!.id;
  const ours = (await db!.query<{ id: string }>("INSERT INTO supplier_invoices (restaurant_id, vendor_id, vendor_name, invoice_date, number, source, total) VALUES ($1, $2, 'Blue Sky Farms', '2026-10-02', 'BS-2', 'photo', 28.1) RETURNING id", [rid, blueSky])).rows[0]!.id;
  await db!.query("INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, total, per_amount, per_unit) VALUES ($1, 1, 'basil', 'Basil', 2, 'lb', 24, 1, 'lb'), ($1, 2, 'garlic', 'Garlic, Peeled', 1, 'lb', 4.5, 1, 'lb')", [ours]);
  await db!.query("INSERT INTO sync_runs (restaurant_id, source, status, finished_at) VALUES ($1, 'marginedge', 'ok', now())", [rid]); // the next sync
  const m2 = await getModel(db!, rid, '2026-10-05');
  const cmp = (await db!.query<{ invoice_id: string; lines: number; matching: number; totals_match: boolean; result: any }>('SELECT invoice_id, lines, matching, totals_match, result FROM invoice_comparisons WHERE restaurant_id = $1', [rid])).rows;
  assert.deepEqual(cmp.map((c) => [c.invoice_id, c.lines, c.matching, c.totals_match]), [[ours, 2, 1, false]]);
  const result = typeof cmp[0]!.result === 'string' ? JSON.parse(cmp[0]!.result) : cmp[0]!.result;
  assert.deepEqual(result.lines.map((l: any) => [l.productId, l.match]), [['basil', 'same'], ['garlic', 'total']]);
  assert.equal(m2.imported.invoices.filter((i) => i.invoiceNumber === 'BS-2').length, 1);
  assert.equal(m2.invoiceSources.get(ours), 'photo');

  // The garden: free basil beside bought basil brings its price down.
  const garden = (await db!.query<{ id: string }>("INSERT INTO vendors (restaurant_id, name, kind, ordering_method) VALUES ($1, 'Our garden', 'garden', 'other') RETURNING id", [rid])).rows[0]!.id;
  const harvest = (await db!.query<{ id: string }>("INSERT INTO supplier_invoices (restaurant_id, vendor_id, vendor_name, invoice_date, source, total) VALUES ($1, $2, 'Our garden', '2026-10-03', 'garden', 0) RETURNING id", [rid, garden])).rows[0]!.id;
  await db!.query("INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, total, per_amount, per_unit) VALUES ($1, 1, 'basil', 'Basil', 2, 'lb', 0, 1, 'lb')", [harvest]);
  invalidate(rid); // what saving one in the app does
  const m3 = await getModel(db!, rid, '2026-10-05');
  assert.equal(blendedPrices(m3.imported.prices, '2026-10-05').get('basil'), 6);
  assert.ok(m3.gardenVendors.has(garden));

  // Without MarginEdge: its sync gone, its data gone; everything stays (ingredients, vendors, invoices).
  await db!.query('DELETE FROM marginedge_data WHERE restaurant_id = $1', [rid]);
  await db!.query("INSERT INTO sync_runs (restaurant_id, source, status, finished_at) VALUES ($1, 'square', 'ok', now())", [rid]);
  const m4 = await getModel(db!, rid, '2026-10-05');
  assert.equal(m4.imported.products.length, before.products.length);
  assert.equal(blendedPrices(m4.imported.prices, '2026-10-05').get('basil'), 6);
});
