import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appImport, baseOf, type AppInvoiceRow } from '../src/server/appInvoices.ts';
import { blendedPrices, packBaseOf, type ImportedProduct, type PricePoint } from '../src/connectors/marginedge.ts';

const basil: ImportedProduct = { externalId: 'p-basil', name: 'Basil, Fresh', baseUnit: 'lb', conversions: {}, categoryType: 'FOOD' };
const bought: PricePoint = { productExternalId: 'p-basil', vendorExternalId: 'v-produce', invoiceExternalId: 'inv-1', lineNumber: 1, date: '2026-09-20', price: 12, per: { amount: 1, unit: 'lb' }, perBaseUnit: 12, quantity: 1, source: 'pack' };
const row = (over: Partial<AppInvoiceRow>): AppInvoiceRow => ({ id: 'a1', vendorId: 'g1', meVendorId: null, vendorName: 'Our garden', kind: 'garden', date: '2026-09-25', number: null, note: null, createdAt: '', lines: [{ lineNumber: 1, productId: 'p-basil', description: 'Basil', quantity: 16, unit: 'oz', total: 0 }], ...over });

test('a garden harvest is a $0 invoice that still counts what came in', () => {
  const typed = appImport([row({})], [basil]);
  assert.deepEqual([...typed.garden], ['app:g1']);
  assert.deepEqual(typed.vendors, [{ externalId: 'app:g1', name: 'Our garden' }]);
  const pt = typed.prices[0]!;
  assert.deepEqual([pt.price, pt.perBaseUnit, pt.perBase, packBaseOf(pt) * pt.quantity], [0, 0, 0.0625, 1]); // 16 oz is a pound
  // A pound from the garden beside a pound bought at $12: $6 a pound, while both are in the 60 days.
  assert.equal(blendedPrices([bought, pt], '2026-10-01').get('p-basil'), 6);
  // Once the garden stops, back to the invoice price.
  assert.equal(blendedPrices([bought, { ...bought, date: '2026-12-01', invoiceExternalId: 'inv-2' }, pt], '2026-12-10').get('p-basil'), 12);
});

test('a typed cash buy prices like an invoice; a MarginEdge vendor keeps its own id', () => {
  const typed = appImport([row({ kind: 'vendor', vendorId: null, meVendorId: 'v-produce', vendorName: 'Produce Co', lines: [{ lineNumber: 1, productId: 'p-basil', description: 'Basil', quantity: 2, unit: 'lb', total: 30 }] })], [basil]);
  assert.deepEqual([typed.vendors, [...typed.garden], typed.invoices[0]!.vendorExternalId, typed.invoices[0]!.total], [[], [], 'v-produce', 30]);
  assert.equal(typed.prices[0]!.perBaseUnit, 15);
});

test('units that won’t convert are left out', () => {
  assert.equal(baseOf(basil, 'oz'), 0.0625);
  assert.equal(baseOf(basil, 'floz'), undefined);
  assert.equal(appImport([row({ lines: [{ lineNumber: 1, productId: 'p-basil', description: 'Basil', quantity: 2, unit: 'floz', total: 0 }] })], [basil]).prices.length, 0);
});

test('an invoice saved here and read later by MarginEdge counts once', async () => {
  const { sameInvoices } = await import('../src/server/model.ts');
  const inv = (externalId: string, vendor: string, number: string | undefined, date: string, total: number) => ({ externalId, vendorExternalId: vendor, ...(number ? { invoiceNumber: number } : {}), invoiceDate: date, total, isCredit: false, lines: [], unexplainedDifference: 0 });
  const me = [inv('me-1', 'v-sysco', '889214', '2026-10-07', 243.53), inv('me-2', 'v-sysco', '889300', '2026-10-09', 100), inv('me-3', 'v-farm', undefined, '2026-10-07', 40)];
  const app = [inv('app:a', 'v-sysco', '0889214', '2026-10-07', 243.53), inv('app:b', 'v-farm', undefined, '2026-10-07', 40), inv('app:c', 'app:garden', undefined, '2026-10-07', 0)];
  assert.deepEqual([...sameInvoices(me, app)], [['me-1', 'app:a'], ['me-3', 'app:b']]);
});
