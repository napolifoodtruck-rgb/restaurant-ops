import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRecipeCardText } from '../src/connectors/marginedgeRecipes.ts';
import { buildRecipes, recipeId, yieldsToConversions } from '../src/core/recipeCards.ts';
import type { PurchasedProduct } from '../src/core/purchasing.ts';
import { RecipeBook } from '../src/core/recipes.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const apricotText = readFileSync(new URL('./fixtures/apricot-pizza-card.txt', import.meta.url), 'utf8');

// A prep card shaped like MarginEdge's, with a method, a fraction, a wrapped name and a second page.
const doughText = [
  'Napoli Pizzera and Gelateria                             printed 10/04/2026 07:20 PM',
  '',
  'Pizza Dough',
  'Category: Prep items',
  'Recipe Type: Dough',
  'Allergens: Gluten',
  'Equipment:',
  'Yields: 40 Portion',
  '',
  'Ingredients                              Method',
  '',
  '  25 Pound          Flour, Pizza         Mix flour and water.',
  '  16 Quart          Water                Rest 20 minutes.',
  '  1 1/2 Cup         Salt, Kosher',
  '  2 Ounce           Yeast, Fresh Eagle',
  '                    Compressed',
  '                                           Page 1 of 2',
  '\f',
  'Napoli Pizzera and Gelateria                             printed 10/04/2026 07:20 PM',
  'Ingredients                              Method',
  '  1/4 Cup           Oil, Olive Extra     Ball at 280 g.',
  '                    Virgin',
  '                                           Page 2 of 2',
].join('\n');

const glazeText = [
  'Apricot Glaze',
  'Category: Prep items',
  'Yields: 2 Quart',
  'Ingredients                              Method',
  '  4 Pound           Preserves, Apricot   No Method',
  '  1 Cup             Vinegar, Balsamic White',
].join('\n');

test('reads the real Apricot Pizza card', () => {
  const card = parseRecipeCardText(apricotText);
  assert.equal(card.name, 'Apricot Pizza');
  assert.equal(card.category, 'Menu items');
  assert.equal(card.recipeType, 'Pizza');
  assert.deepEqual(card.yields, [{ amount: 1, unit: 'each' }]);
  assert.equal(card.layout, 'card');
  assert.deepEqual(card.ingredients.map((i) => [i.amount, i.unit, i.name, i.yieldPercent]), [
    [1, 'each', 'Pizza Dough', 100],
    [1.25, 'oz', 'apricot glaze', 100],
    [1.75, 'oz', 'Cheese, Mozzarella', 100],
    [1.25, 'oz', 'Sopressata', 100],
    [2, 'g', 'Oregano, Fresh', 100],
    [1, 'oz', 'Cheese, Cottonbell', 100],
  ]);
  assert.equal(card.method, undefined); // "No Method"
  assert.deepEqual(card.unreadLines, []);
});

test('reads fractions, wrapped names, methods and later pages', () => {
  const card = parseRecipeCardText(doughText);
  assert.equal(card.name, 'Pizza Dough');
  assert.deepEqual(card.yields, [{ amount: 40, unit: 'each' }]);
  assert.deepEqual(card.ingredients.map((i) => [i.amount, i.unit, i.name]), [
    [25, 'lb', 'Flour, Pizza'],
    [16, 'qt', 'Water'],
    [1.5, 'cup', 'Salt, Kosher'],
    [2, 'oz', 'Yeast, Fresh Eagle Compressed'],
    [0.25, 'cup', 'Oil, Olive Extra Virgin'],
  ]);
  assert.equal(card.method, 'Mix flour and water.\nRest 20 minutes.\nBall at 280 g.');
});

const product = (id: string, name: string, baseUnit: string, conversions = {}): PurchasedProduct => ({ externalId: id, name, baseUnit, conversions });
const products = [
  product('flour', 'Flour, Pizza', 'lb'),
  product('mozz', 'Cheese, Mozzarella', 'lb'),
  product('sopr', 'Sopressata', 'lb'),
  product('oregano', 'Oregano, Fresh', 'lb'),
  product('cotton', 'Cheese, Cottonbell', 'lb'),
  product('preserves', 'Preserves, Apricot', 'jar'),
  product('vinegar', 'Vinegar, Balsamic White', 'l'),
];

test('cards link into nested recipes by name', () => {
  const cards = [apricotText, doughText, glazeText].map(parseRecipeCardText);
  const { recipes, issues } = buildRecipes(cards, products);

  const pizza = recipes.find((r) => r.name === 'Apricot Pizza')!;
  assert.equal(pizza.kind, 'dish');
  assert.deepEqual(pizza.ingredients.slice(0, 3).map((i) => i.item), [
    { kind: 'recipe', id: recipeId('Pizza Dough') },
    { kind: 'recipe', id: recipeId('Apricot Glaze') }, // matched despite "apricot glaze" in lower case
    { kind: 'product', id: 'mozz' },
  ]);
  assert.equal(recipes.find((r) => r.name === 'Pizza Dough')?.kind, 'prep');

  // Water is free; salt, yeast and olive oil aren't products in this sample.
  const unknown = issues.filter((i) => i.type === 'unknownIngredient').map((i) => i.type === 'unknownIngredient' && i.ingredient);
  assert.deepEqual(unknown, ['Salt, Kosher', 'Yeast, Fresh Eagle Compressed', 'Oil, Olive Extra Virgin']);
});

test('unmatched ingredients come with suggestions', () => {
  const { issues } = buildRecipes([parseRecipeCardText(apricotText)], products);
  const glaze = issues.find((i) => i.type === 'unknownIngredient' && i.ingredient === 'apricot glaze');
  assert.deepEqual(glaze?.type === 'unknownIngredient' && glaze.suggestions, ['Preserves, Apricot']);
  const dough = issues.find((i) => i.type === 'unknownIngredient' && i.ingredient === 'Pizza Dough');
  assert.deepEqual(dough?.type === 'unknownIngredient' && dough.suggestions, ['Flour, Pizza']);
});

test('imported recipes cost through sub-recipes', () => {
  const cards = [apricotText, doughText, glazeText].map(parseRecipeCardText);
  const { recipes } = buildRecipes(cards, products);
  const book = new RecipeBook(
    [
      { id: 'flour', name: 'Flour, Pizza', baseUnit: 'lb', cost: { price: 49.96, per: { amount: 55, unit: 'lb' } } },
      { id: 'mozz', name: 'Cheese, Mozzarella', baseUnit: 'lb', cost: { price: 5.86, per: { amount: 1, unit: 'lb' } } },
    ],
    recipes,
  );
  const cost = book.portionCost(recipeId('Apricot Pizza'));
  // Dough: 25 lb flour / 40 portions × $49.96/55 lb. Mozzarella: 1.75 oz × $5.86/lb.
  const flour = (25 / 40) * (49.96 / 55);
  const mozz = (1.75 / 16) * 5.86;
  close(cost.total, flour + mozz);
  assert.equal(cost.complete, false); // the other ingredients have no price in this sample
});

// ---------------------------------------------------------------- recipe costing layout (read with OCR)

const parmaText = readFileSync(new URL('./fixtures/parma-costing-ocr.txt', import.meta.url), 'utf8');
const doughCostingText = readFileSync(new URL('./fixtures/pizza-dough-costing-ocr.txt', import.meta.url), 'utf8');

test('reads a recipe costing card: yield %, MarginEdge costs, menu price, wrapped names', () => {
  const card = parseRecipeCardText(parmaText);
  assert.equal(card.layout, 'costing');
  assert.equal(card.name, 'Parma');
  assert.equal(card.recipeType, 'Pizza');
  assert.equal(card.menuPrice, 20);
  assert.equal(card.cardTotal, 4.95);
  assert.deepEqual(card.ingredients.map((i) => [i.name, i.type, i.yieldPercent, i.amount, i.unit, i.cardCost]), [
    ['Pizza Dough', 'Prep', 100, 1, 'each', 0.38],
    ['Pomodoro Sauce', 'Prep', 100, 60, 'g', 0.34],
    ['Cheese, Mozzarella', 'Food', 100, 2.5, 'oz', 0.92], // "MozzarellaFood" glued together in the PDF
    ['Arugula, Baby', 'Food', 100, 0.5, 'oz', 0.27],
    ['Prosciutto', 'Food', 85, 1.75, 'oz', 2.39],
    ['Cheese, Grana Padano', 'Food', 90, 0.75, 'oz', 0.54],
    ['Oil, Olive Extra Virgin', 'Food', 100, 0.5, 'floz', 0.11], // "Vir-" + "gin"
  ]);
  assert.deepEqual(card.unreadLines, []);
});

test('reads several yields and shelf life from a prep card', () => {
  const card = parseRecipeCardText(doughCostingText);
  assert.equal(card.name, 'Pizza Dough');
  assert.equal(card.recipeType, 'Prep');
  assert.equal(card.shelfLifeDays, 7);
  assert.deepEqual(card.yields, [{ amount: 30100, unit: 'g' }, { amount: 2, unit: 'tub' }, { amount: 120, unit: 'each' }]);
  assert.equal(card.ingredients[0]?.cardCost, undefined); // water has no cost on the card
});

test('several yields become conversions', () => {
  const { primary, conversions } = yieldsToConversions([{ amount: 30100, unit: 'g' }, { amount: 2, unit: 'tub' }, { amount: 120, unit: 'each' }]);
  assert.deepEqual(primary, { amount: 30100, unit: 'g' });
  assert.deepEqual(conversions.customUnits, { tub: { amount: 15050, unit: 'g' } });
  close(conversions.gramsPerEach, 30100 / 120); // one portion of dough
  // "1 Batch or 30 Ounces": tracked in ounces, a batch is 30 oz.
  assert.deepEqual(yieldsToConversions([{ amount: 1, unit: 'batch' }, { amount: 30, unit: 'oz' }]), { primary: { amount: 30, unit: 'oz' }, conversions: { customUnits: { batch: { amount: 30, unit: 'oz' } } } });
  // "1 Batch or 30 Portions" (the gluten-free dough): tracked in portions.
  assert.deepEqual(yieldsToConversions([{ amount: 1, unit: 'batch' }, { amount: 30, unit: 'each' }]), { primary: { amount: 30, unit: 'each' }, conversions: { customUnits: { batch: { amount: 30, unit: 'each' } } } });
});

test('yield % scales up what is bought, and portions of dough convert to grams', () => {
  const cards = [parmaText, doughCostingText].map(parseRecipeCardText);
  const { recipes } = buildRecipes(cards, [
    product('prosciutto', 'Prosciutto', 'lb'),
    product('flour', 'Flour, All Purpose', 'lb'),
  ]);
  const book = new RecipeBook(
    [
      { id: 'prosciutto', name: 'Prosciutto', baseUnit: 'lb', cost: { price: 18.57, per: { amount: 1, unit: 'lb' } } },
      { id: 'flour', name: 'Flour, All Purpose', baseUnit: 'lb', cost: { price: 49.96, per: { amount: 55, unit: 'lb' } } },
      { id: 'free-water', name: 'Water', baseUnit: 'ml', conversions: { gramsPerMl: 1 }, cost: { price: 0, per: { amount: 1, unit: 'ml' } } },
    ],
    recipes,
  );
  const usage = book.explode({ kind: 'recipe', id: recipeId('Parma') }, { amount: 1, unit: 'each' });
  // 1.75 oz served at 85% yield = 2.0588 oz bought = $2.39 at $18.57/lb, as MarginEdge says.
  close(usage.products.get('prosciutto'), 1.75 / 0.85 / 16);
  close((usage.products.get('prosciutto') ?? 0) * 18.57, 2.39, 0.005);
  // One portion of dough = 30100 g / 120, so the flour is 18000 g / 120.
  close(usage.products.get('flour'), 18000 / 120 / 453.59237);
});
