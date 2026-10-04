import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importMarginEdge, latestPrices, mapUnit, type MarginEdgeExport } from '../src/connectors/marginedge.ts';
import { RecipeBook } from '../src/core/recipes.ts';

const sample: MarginEdgeExport = {
  categories: [{ categoryId: 'c1', categoryName: 'Produce' }, { categoryId: 'c2', categoryName: 'Dairy' }],
  products: [
    { companyConceptProductId: 'pr-garlic', productName: 'Garlic, peeled', reportByUnit: 'POUND', categories: [{ categoryId: 'c1', percentAllocation: 100 }] },
    { companyConceptProductId: 'pr-cream', productName: 'Heavy cream', reportByUnit: 'QUART', categories: [{ categoryId: 'c2', percentAllocation: 100 }] },
    { companyConceptProductId: 'pr-herbs', productName: 'Micro herbs', reportByUnit: 'CLAMSHELL' },
  ],
  vendors: [{ vendorId: 'v1', vendorName: 'Produce Co' }, { vendorId: 'v2', vendorName: 'Dairy Co' }],
  vendorItems: [
    { vendorItemCode: 'GAR5', vendorId: 'v1', companyConceptProductId: 'pr-garlic', packagings: [{ packagingId: 'pk-gar5', packagingName: 'Case', quantity: 5, unit: 'POUND' }] },
    { vendorItemCode: 'CRM12', vendorId: 'v2', companyConceptProductId: 'pr-cream', packagings: [{ packagingId: 'pk-crm12', packagingName: 'Case', quantity: 12, unit: 'QUART' }] },
    { vendorItemCode: 'HERB1', vendorId: 'v1', companyConceptProductId: 'pr-herbs', packagings: [{ packagingId: 'pk-herb', packagingName: 'Flat', quantity: 6, unit: 'CLAMSHELL' }] },
  ],
  invoices: [
    {
      orderId: 'o1', invoiceNumber: 'P-100', invoiceDate: '2026-08-01', vendorId: 'v1', vendorName: 'Produce Co',
      orderTotal: 75, tax: 0, deliveryCharges: 5,
      lineItems: [
        { vendorItemCode: 'GAR5', vendorItemName: 'GARLIC PEELED 5#', quantity: 2, unitPrice: 30, linePrice: 60, companyConceptProductId: 'pr-garlic', packagingId: 'pk-gar5' },
        { vendorItemCode: 'HERB1', vendorItemName: 'MICRO HERB MIX', quantity: 1, unitPrice: 10, linePrice: 10, companyConceptProductId: 'pr-herbs', packagingId: 'pk-herb' },
      ],
    },
    {
      orderId: 'o2', invoiceNumber: 'P-131', invoiceDate: '2026-09-05', vendorId: 'v1', vendorName: 'Produce Co',
      orderTotal: 95, // lines say 32.50; a misread total
      lineItems: [
        { vendorItemCode: 'GAR5', vendorItemName: 'GARLIC PEELD 5LB', quantity: 1, unitPrice: 32.5, linePrice: 32.5, companyConceptProductId: 'pr-garlic', packagingId: 'pk-gar5' },
      ],
    },
    {
      orderId: 'o3', invoiceNumber: 'D-77', invoiceDate: '2026-09-10', vendorId: 'v2', vendorName: 'Dairy Co',
      orderTotal: 120,
      lineItems: [
        { vendorItemCode: 'CRM12', vendorItemName: 'CREAM HVY 40% 12/QT', quantity: 2, unitPrice: 54, linePrice: 120, companyConceptProductId: 'pr-cream', packagingId: 'pk-crm12' }, // 2 × 54 ≠ 120
      ],
    },
    { orderId: 'o4', invoiceNumber: 'P-140', vendorId: 'v1', detailError: 'MarginEdge returned 500' },
  ],
};

test('MarginEdge units map to ours', () => {
  assert.equal(mapUnit('POUND'), 'lb');
  assert.equal(mapUnit('Quarts'), 'qt');
  assert.equal(mapUnit('FLUID_OUNCE'), 'floz');
  assert.equal(mapUnit('lbs'), 'lb');
  assert.equal(mapUnit('CLAMSHELL'), undefined);
  assert.equal(mapUnit(undefined), undefined);
});

test('products, vendors and pack sizes come across', () => {
  const result = importMarginEdge(sample);
  assert.equal(result.vendors.length, 2);
  assert.deepEqual(result.products.map((p) => [p.name, p.baseUnit, p.category]), [
    ['Garlic, peeled', 'lb', 'Produce'],
    ['Heavy cream', 'qt', 'Dairy'],
    ['Micro herbs', undefined, undefined],
  ]);
  const garlic = result.vendorItems.find((item) => item.code === 'GAR5');
  assert.deepEqual(garlic?.packs[0]?.contents, { amount: 5, unit: 'lb' });
  // The vendor's different spellings are kept for matching.
  assert.deepEqual(garlic?.descriptions, ['GARLIC PEELED 5#', 'GARLIC PEELD 5LB']);
});

test('price history comes only from lines that check out', () => {
  const result = importMarginEdge(sample);
  assert.deepEqual(result.prices.map((p) => [p.productExternalId, p.date, p.price, p.per]), [
    ['pr-garlic', '2026-08-01', 30, { amount: 5, unit: 'lb' }],
    ['pr-garlic', '2026-09-05', 32.5, { amount: 5, unit: 'lb' }],
  ]);
  const latest = latestPrices(result.prices);
  assert.equal(latest.get('pr-garlic')?.price, 32.5);
  assert.equal(latest.has('pr-cream'), false); // its only line failed the math check
});

test('self-checks flag only what needs a look', () => {
  const flags = importMarginEdge(sample).flags;
  const summary = flags.map((flag) => flag.type).sort();
  assert.deepEqual(summary, ['invoiceTotal', 'lineMath', 'missingDetail', 'noPackSize', 'unknownUnit', 'unknownUnit']);

  const lineMath = flags.find((flag) => flag.type === 'lineMath');
  assert.deepEqual(lineMath, { type: 'lineMath', invoiceExternalId: 'o3', lineNumber: 1, description: 'CREAM HVY 40% 12/QT', expected: 108, actual: 120 });

  const total = flags.find((flag) => flag.type === 'invoiceTotal');
  assert.equal(total?.type === 'invoiceTotal' && total.difference, 62.5);

  // The first invoice adds up once delivery is included: 60 + 10 + 5 = 75. No flag for it.
  assert.equal(flags.some((flag) => 'invoiceExternalId' in flag && flag.invoiceExternalId === 'o1' && flag.type === 'invoiceTotal'), false);
});

test('imported prices cost recipes directly', () => {
  const result = importMarginEdge(sample);
  const latest = latestPrices(result.prices);
  const products = result.products
    .filter((p) => p.baseUnit)
    .map((p) => {
      const price = latest.get(p.externalId);
      return { id: p.externalId, name: p.name, baseUnit: p.baseUnit!, cost: price && { price: price.price, per: price.per } };
    });
  const book = new RecipeBook(products, [
    { id: 'chopped', name: 'Chopped garlic', kind: 'prep', yield: { amount: 1, unit: 'cup' }, ingredients: [{ item: { kind: 'product', id: 'pr-garlic' }, quantity: { amount: 0.5, unit: 'lb' } }] },
  ]);
  // $32.50 per 5 lb = $6.50/lb; half a pound = $3.25.
  const cost = book.costOf({ kind: 'recipe', id: 'chopped' }, { amount: 1, unit: 'cup' });
  assert.equal(cost.complete, true);
  assert.ok(Math.abs(cost.total - 3.25) < 1e-9);
});
