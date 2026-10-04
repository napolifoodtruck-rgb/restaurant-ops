import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeBook, type Recipe } from '../src/core/recipes.ts';
import { theoreticalUsage } from '../src/core/sales.ts';
import { book, links, products, recipes } from './fixtures.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

/*
 * Worked by hand:
 *   Vodka sauce, one 4 qt batch:
 *     chopped garlic 0.25 cup → 0.25 batches × 0.5 lb garlic = 0.125 lb × $6   = $0.75
 *     crushed tomatoes 2 cans × $6                                              = $12.00
 *     cream 1 qt × $5                                                           = $5.00
 *     vodka 1 cup = 0.2365882365 l × $15                                        = $3.5488235475
 *     batch total                                                               = $21.2988235475
 *   Rigatoni alla vodka, one portion:
 *     vodka sauce 1 cup = 1/16 of a 4 qt batch → $21.2988235475 / 16           = $1.33117647171875
 *     rigatoni 0.25 lb × $2                                                     = $0.50
 *     parmesan 1 oz = 0.0625 lb × $12                                           = $0.75
 *     portion total                                                             = $2.58117647171875
 */

test('the sample recipe book is valid', () => {
  assert.deepEqual(book().validate(), []);
});

test('cost rolls up through nested prep recipes', () => {
  const sauce = book().costOf({ kind: 'recipe', id: 'vodka-sauce' }, { amount: 4, unit: 'qt' });
  assert.equal(sauce.complete, true);
  close(sauce.total, 21.2988235475);

  const portion = book().portionCost('rigatoni-vodka');
  assert.equal(portion.complete, true);
  close(portion.total, 2.58117647171875);
  // Most expensive ingredient first.
  const costs = portion.lines.map((line) => line.cost ?? 0);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a));
  close(costs[0], 0.75); // parmesan and tomatoes tie at $0.75
});

test('food cost share against menu price', () => {
  const { share } = book().foodCostShare('rigatoni-vodka', 18);
  close(share, 2.58117647171875 / 18); // about 14.3%
});

test('one portion breaks down to raw products', () => {
  const usage = book().explode({ kind: 'recipe', id: 'rigatoni-vodka' }, { amount: 1, unit: 'each' });
  close(usage.products.get('garlic'), 0.125 / 16);
  close(usage.products.get('crushed-tomatoes'), 2 / 16);
  close(usage.products.get('cream'), 1 / 16);
  close(usage.products.get('vodka'), 0.2365882365 / 16);
  close(usage.products.get('rigatoni'), 0.25);
  close(usage.products.get('parmesan'), 0.0625);
  // Prepped items along the way, in their own yield units.
  close(usage.recipes.get('vodka-sauce'), 0.25); // 1 cup = 0.25 qt
  close(usage.recipes.get('chopped-garlic'), 0.25 / 16);
  assert.equal(usage.issues.size, 0);
});

test('a prep item can be measured in its kitchen container', () => {
  // One sixth pan of vodka sauce = 2 qt = half a batch.
  const usage = book().explode({ kind: 'recipe', id: 'vodka-sauce' }, { amount: 1, unit: 'sixth pan' });
  close(usage.products.get('cream'), 0.5);
  close(usage.products.get('crushed-tomatoes'), 1);
});

test('sales become theoretical usage, with modifiers and coverage', () => {
  const result = theoreticalUsage(book(), links, [
    {
      catalogId: 'SQ-RIGATONI', name: 'Rigatoni alla vodka', quantity: 7, netSales: 126,
    },
    {
      catalogId: 'SQ-RIGATONI', name: 'Rigatoni alla vodka', quantity: 3, netSales: 54 + 18,
      modifiers: [{ catalogId: 'SQ-MOD-CHICKEN', name: 'Add chicken' }],
    },
    { catalogId: 'SQ-CAESAR', name: 'Caesar salad', quantity: 5, netSales: 60 },
    {
      catalogId: 'SQ-BURGER', name: 'Burger', quantity: 4, netSales: 80,
      modifiers: [{ catalogId: 'SQ-MOD-BACON', name: 'Add bacon' }],
    },
  ]);

  // 10 portions of rigatoni, 3 with chicken.
  close(result.usage.products.get('rigatoni'), 2.5);
  close(result.usage.products.get('parmesan'), 0.625);
  close(result.usage.products.get('garlic'), 10 * 0.125 / 16);
  close(result.usage.products.get('chicken'), 0.75);
  close(result.usage.recipes.get('vodka-sauce'), 2.5);

  // Covered sales: 126 + 72 = 198 of 338.
  close(result.coverage, 198 / 338);
  // Next recipe to ask about: highest unmapped sales first.
  assert.deepEqual(result.unmappedItems.map((item) => item.name), ['Burger', 'Caesar salad']);
  assert.deepEqual(result.unmappedModifiers, [{ catalogId: 'SQ-MOD-BACON', name: 'Add bacon', quantity: 4 }]);
});

test('stopping at prep items gives the prep-to-plate view', () => {
  const result = theoreticalUsage(book(), links, [{ catalogId: 'SQ-RIGATONI', name: 'Rigatoni alla vodka', quantity: 10, netSales: 180 }], { stopAtPrep: true });
  close(result.usage.recipes.get('vodka-sauce'), 2.5);
  assert.equal(result.usage.products.has('cream'), false);
  assert.equal(result.usage.products.has('garlic'), false);
  assert.equal(result.usage.recipes.has('chopped-garlic'), false);
  close(result.usage.products.get('rigatoni'), 2.5);
});

test('missing facts become one issue each, and the rest still calculates', () => {
  const pesto: Recipe = {
    id: 'pesto', name: 'Pesto', kind: 'prep', yield: { amount: 1, unit: 'qt' },
    ingredients: [
      { item: { kind: 'product', id: 'basil' }, quantity: { amount: 4, unit: 'cup' } }, // basil is bought by weight: needs a density
      { item: { kind: 'recipe', id: 'chopped-garlic' }, quantity: { amount: 30, unit: 'g' } }, // chopped garlic by weight: needs a density
      { item: { kind: 'product', id: 'parmesan' }, quantity: { amount: 2, unit: 'oz' } },
      { item: { kind: 'product', id: 'pine-nuts' }, quantity: { amount: 2, unit: 'oz' } }, // not a known product yet
    ],
  };
  const withPesto = new RecipeBook(products, [...recipes, pesto]);
  const cost = withPesto.costOf({ kind: 'recipe', id: 'pesto' }, { amount: 2, unit: 'qt' });

  assert.equal(cost.complete, false);
  close(cost.total, 0.25 * 12); // only the parmesan could be costed: 2 qt × 2 oz = 4 oz = 0.25 lb × $12 = $3
  const kinds = cost.issues.map((issue) => issue.type).sort();
  assert.deepEqual(kinds, ['missingConversion', 'missingConversion', 'unknownItem']);

  // Once the chef answers "a cup of chopped garlic weighs about 136 g", it works.
  const answered = new RecipeBook(products, [
    ...recipes.map((r) => (r.id === 'chopped-garlic' ? { ...r, conversions: { gramsPerMl: 136 / 236.5882365 } } : r)),
    pesto,
  ]);
  const garlic = answered.explode({ kind: 'recipe', id: 'pesto' }, { amount: 1, unit: 'qt' }).products.get('garlic');
  close(garlic, (30 / 136) * 0.5); // 30 g = 30/136 cup of chopped garlic, each cup from 0.5 lb
});

test('missing prices are reported, not guessed', () => {
  const withBasil = new RecipeBook(products, [
    { id: 'garnish', name: 'Basil garnish', kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [{ item: { kind: 'product', id: 'basil' }, quantity: { amount: 0.25, unit: 'oz' } }] },
  ]);
  const cost = withBasil.portionCost('garnish');
  assert.equal(cost.complete, false);
  assert.deepEqual(cost.issues, [{ type: 'missingCost', productId: 'basil', productName: 'Basil' }]);
  assert.equal(cost.lines[0]?.cost, undefined);
});

test('recipes that contain themselves are caught without hanging', () => {
  const loop = new RecipeBook(products, [
    { id: 'a', name: 'Sauce A', kind: 'prep', yield: { amount: 1, unit: 'qt' }, ingredients: [{ item: { kind: 'recipe', id: 'b' }, quantity: { amount: 1, unit: 'cup' } }] },
    { id: 'b', name: 'Sauce B', kind: 'prep', yield: { amount: 1, unit: 'qt' }, ingredients: [{ item: { kind: 'recipe', id: 'a' }, quantity: { amount: 1, unit: 'cup' } }] },
  ]);
  const issues = loop.validate();
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], { type: 'cycle', path: ['Sauce A', 'Sauce B', 'Sauce A'] });

  const usage = loop.explode({ kind: 'recipe', id: 'a' }, { amount: 1, unit: 'qt' });
  assert.equal(usage.issues.toArray()[0]?.type, 'cycle');
});

test('modifiers can remove ingredients with negative amounts', () => {
  const swap = new RecipeBook(products, [
    ...recipes,
    { id: 'no-parm', name: 'No parmesan', kind: 'modifier', yield: { amount: 1, unit: 'each' }, ingredients: [{ item: { kind: 'product', id: 'parmesan' }, quantity: { amount: -1, unit: 'oz' } }] },
  ]);
  const result = theoreticalUsage(swap, { items: links.items, modifiers: { 'SQ-NO-PARM': 'no-parm' } }, [
    { catalogId: 'SQ-RIGATONI', name: 'Rigatoni alla vodka', quantity: 2, netSales: 36, modifiers: [{ catalogId: 'SQ-NO-PARM', name: 'No parmesan' }] },
  ]);
  close(result.usage.products.get('parmesan'), 0);
});
