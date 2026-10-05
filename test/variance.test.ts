import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOnHand, periodVariance, varianceReport, type Movement, type ProductCount, type VarianceInput } from '../src/core/variance.ts';
import { RecipeBook, type Product, type Recipe } from '../src/core/recipes.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const products: Product[] = [
  { id: 'prosciutto', name: 'Prosciutto', baseUnit: 'lb', cost: { price: 20, per: { amount: 1, unit: 'lb' } } },
  { id: 'mozz', name: 'Mozzarella', baseUnit: 'lb', cost: { price: 6, per: { amount: 1, unit: 'lb' } } },
  { id: 'basil', name: 'Basil', baseUnit: 'lb', cost: { price: 12, per: { amount: 1, unit: 'lb' } } },
  { id: 'feta', name: 'Feta', baseUnit: 'lb', cost: { price: 4, per: { amount: 1, unit: 'lb' } } },
];
const p = (id: string, amount: number, unit: string) => ({ item: { kind: 'product' as const, id }, quantity: { amount, unit } });
const recipes: Recipe[] = [
  { id: 'parma', name: 'Parma', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [p('mozz', 2.5, 'oz'), p('prosciutto', 2, 'oz')] },
  { id: 'special', name: 'Prosciutto special', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [p('prosciutto', 4, 'oz')] },
  { id: 'marg', name: 'Margherita', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [p('mozz', 3, 'oz'), p('basil', 0.01, 'lb')] },
];
const book = new RecipeBook(products, recipes);

const m = (productId: string, date: string, amount: number): Movement => ({ productId, date, amount });
const count = (productId: string, date: string, amount: number, estimate = false): ProductCount => ({ productId, date, amount, ...(estimate ? { estimate } : {}) });

const input: VarianceInput = {
  counts: [
    count('prosciutto', '2026-09-01', 10),
    count('prosciutto', '2026-09-08', 6, true), // skipped: filled in by estimate
    count('prosciutto', '2026-09-15', 4),
    count('mozz', '2026-09-01', 20),
    count('mozz', '2026-09-15', 30),
    count('basil', '2026-09-01', 1),
    count('basil', '2026-09-15', 1.02),
    count('feta', '2026-09-01', 10),
    count('feta', '2026-09-15', 2),
  ],
  purchases: [m('prosciutto', '2026-09-05', 15), m('prosciutto', '2026-09-12', 15), m('mozz', '2026-09-04', 40), m('basil', '2026-09-04', 1), m('feta', '2026-09-04', 5)],
  expectedUse: [
    m('prosciutto', '2026-09-03', 8),
    m('prosciutto', '2026-09-07', 8),
    m('prosciutto', '2026-09-10', 7),
    m('prosciutto', '2026-09-14', 7),
    m('mozz', '2026-09-10', 32),
    m('basil', '2026-09-10', 1),
    m('feta', '2026-09-10', 8),
  ],
  waste: [m('prosciutto', '2026-09-10', 1)],
};

test('between counts the app keeps a running estimate of what is on hand', () => {
  const est = estimateOnHand(input, 'prosciutto', '2026-09-10')!;
  // Last real count 10 lb (Sept 1) + 15 bought − 23 expected − 1 wasted. The skipped count is ignored.
  close(est.amount, 1);
  assert.equal(est.lastCount.date, '2026-09-01');
  assert.equal(estimateOnHand(input, 'prosciutto', '2026-08-31'), undefined);
});

test('variance closes the whole period since the last real count', () => {
  const v = periodVariance(input, 'prosciutto', input.counts[0]!, input.counts[2]!);
  close(v.actualUse, 10 + 30 - 4);
  close(v.expectedUse, 30);
  close(v.wasted, 1);
  close(v.variance, 5); // 5 lb that sales and waste don't explain
  close(v.share, 5 / 31);
});

test('the report ranks gaps by dollars and says where to look', () => {
  const report = varianceReport(book, input);
  assert.deepEqual(report.map((l) => [l.name, l.direction, +l.variance.toFixed(2), +(l.value ?? 0).toFixed(2), l.recount]), [
    ['Prosciutto', 'over', 5, 100, false],
    ['Feta', 'over', 5, 20, true], // 62% over on today's count: recount before anything else
    ['Mozzarella', 'under', -2, -12, false],
    // Basil: 0.02 lb under, inside the 5% tolerance and worth pennies.
  ]);
  assert.equal(report[0]!.message, '5 lb more Prosciutto went out than sales and waste explain ($100.00). Check portioning on Prosciutto special and Parma, look for unlogged waste, or recount.');
  assert.equal(report[2]!.message, "2 lb less Mozzarella was used than sales say ($12.00). A recipe may overstate it, or a delivery wasn't recorded.");
});
