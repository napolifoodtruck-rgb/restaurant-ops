import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importMarginEdge, latestPrices, type MarginEdgeExport } from '../src/connectors/marginedge.ts';
import { packNameStructure, parseReportUnit, readPack, sizeInItemName, sizeInPackName, unitWord } from '../src/connectors/marginedgeUnits.ts';
import { RecipeBook } from '../src/core/recipes.ts';
import { convert } from '../src/core/units.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

// ---------------------------------------------------------------- reading MarginEdge's units (real examples)

test('unit words', () => {
  assert.equal(unitWord('Pounds'), 'lb');
  assert.equal(unitWord('Fluid Ounces'), 'floz');
  assert.equal(unitWord('Milliliters'), 'ml');
  assert.equal(unitWord('Bottles'), 'bottle');
  assert.equal(unitWord('Boxes'), 'box');
  assert.equal(unitWord('Other'), undefined);
});

test('report-by units from the real export', () => {
  assert.deepEqual(parseReportUnit('Pound'), { baseUnit: 'lb', priceCovers: 1, conversions: {} });
  assert.deepEqual(parseReportUnit('100 Each'), { baseUnit: 'each', priceCovers: 100, conversions: {} });
  assert.deepEqual(parseReportUnit('4 Gallons'), { baseUnit: 'gal', priceCovers: 4, conversions: {} });
  assert.deepEqual(parseReportUnit('Bottle (750 Milliliters)'), { baseUnit: 'bottle', priceCovers: 1, conversions: { customUnits: { bottle: { amount: 750, unit: 'ml' } } } });
  assert.deepEqual(parseReportUnit('Can (12 Fluid Ounces)').conversions, { customUnits: { can: { amount: 12, unit: 'floz' } } });
  assert.deepEqual(parseReportUnit('Bottle (Liter)').conversions, { customUnits: { bottle: { amount: 1, unit: 'l' } } });
  assert.deepEqual(parseReportUnit('Keg (1/6BBL) 5.16GAL').conversions, { customUnits: { keg: { amount: 5.16, unit: 'gal' } } });
  assert.deepEqual(parseReportUnit('Case (35 Pounds)').conversions, { customUnits: { case: { amount: 35, unit: 'lb' } } });
  assert.equal(parseReportUnit('Almonds, Sliced (Pound)').baseUnit, 'lb');
  assert.deepEqual(parseReportUnit(' (9 Each)'), { baseUnit: 'each', priceCovers: 9, conversions: {} });
  assert.equal(parseReportUnit('Bunch').baseUnit, 'bunch');
  assert.equal(parseReportUnit('Other').baseUnit, undefined);
  assert.equal(parseReportUnit('').baseUnit, undefined);
});

test('pack names', () => {
  assert.deepEqual(sizeInPackName('Case/12/750ML Btl', 'bottle'), { amount: 750, unit: 'ml' });
  assert.deepEqual(sizeInPackName('17.5OZ Btl', 'bottle'), { amount: 17.5, unit: 'floz' }); // ounces on a bottle are fluid
  assert.deepEqual(sizeInPackName('EA/500GM', 'each'), { amount: 500, unit: 'g' });
  assert.deepEqual(packNameStructure('Case/6/1KG'), { outer: 'case', count: 6, itemSize: { amount: 1, unit: 'kg' } });
  assert.deepEqual(packNameStructure('EA/2LB'), { outer: 'each', count: 1, itemSize: { amount: 2, unit: 'lb' } });
  assert.deepEqual(packNameStructure('LB'), { count: 1 });
});

test('what one pack holds', () => {
  assert.deepEqual(readPack({ unit: 'BOTTLE', quantity: 12, packagingName: 'Case/12/750ML Btl' }).candidates, [
    { amount: 9000, unit: 'ml' }, { amount: 12, unit: 'bottle' }, { amount: 1, unit: 'case' }, { amount: 12, unit: 'each' },
  ]);
  const puree = readPack({ unit: 'KILOGRAM', quantity: 6, packagingName: 'Case/6/1KG' });
  assert.deepEqual(puree.candidates, [{ amount: 6, unit: 'kg' }, { amount: 1, unit: 'case' }, { amount: 6, unit: 'each' }]);
  assert.equal(puree.teaches.gramsPerEach, 1000);
  assert.deepEqual(readPack({ unit: 'KEG_ONE_SIXTH', quantity: 1, packagingName: 'Keg(1/6BBL)' }).candidates[0], { amount: 5.16, unit: 'gal' });
  assert.equal(readPack({ unit: 'OTHER', quantity: 1 }).unknownUnit, 'OTHER');
});

test('sizes in item names, for vendors without pack data', () => {
  assert.deepEqual(sizeInItemName('Limes 40LB'), { amount: 40, unit: 'lb' });
  assert.deepEqual(sizeInItemName('Lettuce, Local Lettuce Salad Blend - 3#'), { amount: 3, unit: 'lb' });
  assert.deepEqual(sizeInItemName('Beet, Baby Gold W/Top 24Ct'), { amount: 24, unit: 'each' });
  assert.equal(sizeInItemName('Arugula, Baby (21 1/2lb bags)'), undefined); // a fraction: better unread than misread
  assert.equal(sizeInItemName('Herb, Sage'), undefined);
});

// ---------------------------------------------------------------- the import

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

test('prices come from pack data, calibration, item names, or the product unit, whichever checks out', () => {
  const result = importMarginEdge(sample);
  const point = (productId: string) => result.prices.find((p) => p.productExternalId === productId);

  // Pack data (numeric id on the line, text id on the pack): a 750 ml bottle.
  assert.equal(point('aperol')?.source, 'pack');
  close(point('aperol')?.perBaseUnit, 29.95);
  // Calibrated: the latest $29.75 limes line is a clean 40× MarginEdge's $0.74/lb, a 40 lb case.
  assert.equal(point('limes')?.source, 'calibrated');
  assert.deepEqual(point('limes')?.per, { amount: 40, unit: 'lb' });
  // Calibrated: $9 sage against $36/lb is a quarter-pound bunch.
  assert.deepEqual(point('sage')?.per, { amount: 0.25, unit: 'lb' });
  close(point('sage')?.perBaseUnit, 36);
  // Item name: "Garlic, Peeled 5 Lb" at $20.50 is $4.10/lb.
  assert.equal(point('garlic')?.source, 'itemName');
  close(point('garlic')?.perBaseUnit, 4.1);
  // Product unit: basil at $12 a pound.
  assert.equal(point('basil')?.source, 'productUnit');
  close(point('basil')?.perBaseUnit, 12);
});

test('a price that fits no reading becomes a question, not a cost', () => {
  const result = importMarginEdge(sample);
  // $16.50 for a "4lb bag" of spinach against MarginEdge's $5.92 each: no clean pack size explains it.
  assert.equal(result.prices.some((p) => p.productExternalId === 'spinach'), false);
  const spinach = result.flags.find((f) => f.type === 'priceUnclear' && f.productExternalId === 'spinach');
  assert.deepEqual(spinach, {
    type: 'priceUnclear', invoiceExternalId: 'o1', lineNumber: 5, vendorName: 'Blue Sky Farms', description: 'Spinach, Baby Trimmed 4lb (bag)',
    productExternalId: 'spinach', price: 16.5, impliedPerUnit: 16.5, referencePerUnit: 5.92, unit: 'each',
  });
});

test('the other self-checks', () => {
  const flags = importMarginEdge(sample).flags;
  assert.deepEqual(flags.map((f) => f.type).sort(), ['invoiceTotal', 'invoiceTotal', 'lineMath', 'missingDetail', 'priceUnclear', 'unknownUnit']);
  // o3: total 130 but the lines say 59.90. o4: line says 2 × 29.95 but totals 65.
  assert.ok(flags.some((f) => f.type === 'invoiceTotal' && f.invoiceExternalId === 'o3' && f.difference === 70.1));
  assert.ok(flags.some((f) => f.type === 'lineMath' && f.invoiceExternalId === 'o4' && f.expected === 59.9 && f.actual === 65));
  assert.ok(flags.some((f) => f.type === 'unknownUnit' && f.rawUnit === 'Other'));
});

test('when a pack size changes, the pack bought last says what a bottle is', () => {
  // The vendor used to sell saba in 250 ml bottles and now sells 750 ml.
  const data: MarginEdgeExport = {
    restaurantUnit: { id: 1, name: 'Test' },
    categories: [{ categoryId: 'c', categoryName: 'Grocery', categoryType: 'FOOD' }],
    products: [{ companyConceptProductId: 'saba', productName: 'Vinegar, Saba', reportByUnit: 'Bottle', latestPrice: 11.09, categories: [{ categoryId: 'c' }] }],
    vendors: [{ vendorId: 'v', vendorName: 'Gourmet' }],
    vendorItems: [
      { vendorId: 'v', vendorItemCode: 'old', vendorItemName: 'Saba 250ML', companyConceptProductId: 'saba', packagings: [{ packagingId: 1, packagingName: '250ML Btl', unit: 'BOTTLE', quantity: 1 }] },
      { vendorId: 'v', vendorItemCode: 'new', vendorItemName: 'Saba 750ml', companyConceptProductId: 'saba', packagings: [{ packagingId: 2, packagingName: '750ML Btl', unit: 'BOTTLE', quantity: 1 }] },
    ],
    invoices: [
      { orderId: 'a', vendorId: 'v', invoiceDate: '2025-06-01', orderTotal: 11, lineItems: [{ vendorItemCode: 'old', vendorItemName: 'Saba 250ML', companyConceptProductId: 'saba', packagingId: 1, unitPrice: 11, quantity: 1, linePrice: 11 }] },
      { orderId: 'b', vendorId: 'v', invoiceDate: '2026-09-28', orderTotal: 33.27, lineItems: [{ vendorItemCode: 'new', vendorItemName: 'Saba 750ml', companyConceptProductId: 'saba', packagingId: 2, unitPrice: 33.27, quantity: 1, linePrice: 33.27 }] },
    ],
  } as unknown as MarginEdgeExport;
  const result = importMarginEdge(data);
  assert.deepEqual(result.products[0]?.conversions.customUnits?.bottle, { amount: 750, unit: 'ml' });
  // Either way the price per ml is the invoice's: $33.27 for 750 ml.
  const latest = latestPrices(result.prices).get('saba');
  close(latest!.price / convert(latest!.per, 'ml', result.products[0]!.conversions), 33.27 / 750);
});

test('products carry their conversions and categories', () => {
  const aperol = importMarginEdge(sample).products.find((p) => p.externalId === 'aperol')!;
  assert.equal(aperol.baseUnit, 'bottle');
  assert.equal(aperol.categoryType, 'WINE');
  close(convert({ amount: 1.5, unit: 'floz' }, 'bottle', aperol.conversions), 1.5 * 29.5735295625 / 750); // one pour
});

test('imported prices cost recipes directly', () => {
  const result = importMarginEdge(sample);
  const latest = latestPrices(result.prices);
  const products = result.products.filter((p) => p.baseUnit).map((p) => {
    const price = latest.get(p.externalId);
    return { id: p.externalId, name: p.name, baseUnit: p.baseUnit!, conversions: p.conversions, cost: price && { price: price.price, per: price.per } };
  });
  const book = new RecipeBook(products, [
    { id: 'spritz', name: 'Aperol spritz', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [{ item: { kind: 'product', id: 'aperol' }, quantity: { amount: 2, unit: 'floz' } }] },
  ]);
  // 2 fl oz of a $29.95, 750 ml bottle.
  close(book.portionCost('spritz').total, 29.95 * (2 * 29.5735295625) / 750);
});
