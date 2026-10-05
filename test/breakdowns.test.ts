import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBreakdown, costBreakdown, inputNeeded, withBreakdownPrices, yieldReport, type Breakdown } from '../src/core/breakdowns.ts';
import { RecipeBook, type Product } from '../src/core/recipes.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const products: Product[] = [
  { id: 'snapper', name: 'Snapper, whole', baseUnit: 'lb', cost: { price: 8, per: { amount: 1, unit: 'lb' } } },
  { id: 'fillet', name: 'Snapper fillet', baseUnit: 'lb' },
  { id: 'trim', name: 'Snapper trim', baseUnit: 'lb' },
  { id: 'bones', name: 'Snapper bones', baseUnit: 'lb' },
  { id: 'shoulder', name: 'Pork shoulder', baseUnit: 'lb', cost: { price: 5, per: { amount: 1, unit: 'lb' } } },
];
const book = new RecipeBook(products, []);
const p = (id: string) => ({ kind: 'product' as const, id });

const snapper: Breakdown = {
  id: 'snapper-breakdown',
  name: 'Snapper breakdown',
  input: { item: p('snapper'), quantity: { amount: 10, unit: 'lb' } },
  outputs: [
    { name: 'Fillets', item: p('fillet'), share: 0.45, valuation: { method: 'main' } },
    { name: 'Trim', item: p('trim'), share: 0.1, valuation: { method: 'fixed', price: 4, per: { amount: 1, unit: 'lb' } } },
    { name: 'Bones & heads', item: p('bones'), share: 0.25, valuation: { method: 'fixed', price: 0, per: { amount: 1, unit: 'lb' } } },
    { name: 'Waste', share: 0.2, valuation: { method: 'waste' } },
  ],
};

test('by-products are valued first and the main cut carries the rest', () => {
  const c = costBreakdown(book, snapper);
  assert.deepEqual(c.problems, []);
  close(c.inputCost, 80);
  const by = Object.fromEntries(c.outputs.map((o) => [o.name, o]));
  // $80 of fish, $4 of it is trim, bones are free: fillets carry $76 over 4.5 lb.
  close(by['Fillets']!.cost, 76);
  close(by['Fillets']!.perUnit, 76 / 4.5);
  close(by['Trim']!.perUnit, 4);
  close(by['Bones & heads']!.perUnit, 0);
  assert.equal(by['Waste']!.perUnit, undefined);
  close(by['Waste']!.quantity.amount, 2); // 2 lb thrown away, in plain sight
  close(c.unaccounted, 0);
});

test('several main cuts share the cost by weight × relative value', () => {
  const shoulder: Breakdown = {
    id: 'shoulder',
    name: 'Pork shoulder breakdown',
    input: { item: p('shoulder'), quantity: { amount: 20, unit: 'lb' } },
    outputs: [
      { name: 'Steaks', share: 0.3, valuation: { method: 'main', relativeValue: 3 } },
      { name: 'Grind', share: 0.5, valuation: { method: 'main' } },
      { name: 'Fat', share: 0.1, valuation: { method: 'fixed', price: 0.5, per: { amount: 1, unit: 'lb' } } },
      { name: 'Waste', share: 0.05, valuation: { method: 'waste' } },
    ],
  };
  const c = costBreakdown(book, shoulder);
  const by = Object.fromEntries(c.outputs.map((o) => [o.name, o]));
  // $100 − $1 of fat = $99, split 6 lb × 3 : 10 lb × 1.
  close(by['Steaks']!.cost, (99 * 18) / 28);
  close(by['Grind']!.cost, (99 * 10) / 28);
  close(by['Steaks']!.perUnit! / by['Grind']!.perUnit!, 3);
  close(c.unaccounted, 0.05); // 1 lb lost to trimming and moisture
});

test('dishes using a breakdown output cost at its share of the input', () => {
  const priced = withBreakdownPrices(products, book, [snapper]);
  const withFillets = new RecipeBook(priced, [
    { id: 'fish-dish', name: 'Grilled snapper', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [{ item: p('fillet'), quantity: { amount: 6, unit: 'oz' } }] },
  ]);
  close(withFillets.portionCost('fish-dish').total, (6 / 16) * (76 / 4.5));
});

test('main cuts drive how much to break down; by-products come along', () => {
  const need = inputNeeded(snapper, new Map([['Fillets', { amount: 9, unit: 'lb' }], ['Bones & heads', { amount: 6, unit: 'lb' }]]));
  close(need.input.amount, 20); // 9 lb of fillets at 45%
  const bones = need.byProducts.find((b) => b.name === 'Bones & heads')!;
  close(bones.produced.amount, 5);
  close(bones.short?.amount, 1); // buy a pound of bones or make less stock
});

test('logged breakdowns show the real yield and what the fillets really cost', () => {
  const report = yieldReport(book, snapper, [
    { input: { amount: 12, unit: 'lb' }, outputs: { Fillets: { amount: 4.6, unit: 'lb' }, Waste: { amount: 2.5, unit: 'lb' } } },
    { input: { amount: 10, unit: 'lb' }, outputs: { Fillets: { amount: 60.8, unit: 'oz' } } },
  ]);
  const fillets = report.lines.find((l) => l.name === 'Fillets')!;
  close(fillets.actual, 8.4 / 22);
  close(fillets.deviation, 8.4 / 22 / 0.45 - 1);
  assert.equal(fillets.low, true); // about 15% under standard
  const waste = report.lines.find((l) => l.name === 'Waste')!;
  close(waste.actual, 2.5 / 12); // only the breakdown that weighed waste counts
  assert.equal(report.lines.find((l) => l.name === 'Trim')!.actual, undefined);
  // At the real yield the same $76 is spread over less fillet.
  close(report.actualMainCost?.[0]?.perUnit, 76 / (10 * (8.4 / 22)));
});

test('shape checks', () => {
  assert.deepEqual(checkBreakdown({ ...snapper, outputs: [...snapper.outputs, { name: 'Roe', share: 0.1, valuation: { method: 'waste' } }] }), ['Outputs add up to 110.0% of the input.']);
  assert.deepEqual(checkBreakdown({ ...snapper, outputs: snapper.outputs.filter((o) => o.valuation.method !== 'main') }), ['No main cut to carry the cost.']);
});
