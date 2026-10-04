import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRecipes, parseRecipeCardText, recipeId } from '../src/connectors/marginedgeRecipes.ts';
import type { ImportedProduct } from '../src/connectors/marginedge.ts';
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
  assert.deepEqual(card.yield, { amount: 1, unit: 'each' });
  assert.deepEqual(card.ingredients, [
    { amount: 1, unit: 'each', name: 'Pizza Dough' },
    { amount: 1.25, unit: 'oz', name: 'apricot glaze' },
    { amount: 1.75, unit: 'oz', name: 'Cheese, Mozzarella' },
    { amount: 1.25, unit: 'oz', name: 'Sopressata' },
    { amount: 2, unit: 'g', name: 'Oregano, Fresh' },
    { amount: 1, unit: 'oz', name: 'Cheese, Cottonbell' },
  ]);
  assert.equal(card.method, undefined); // "No Method"
  assert.deepEqual(card.unreadLines, []);
});

test('reads fractions, wrapped names, methods and later pages', () => {
  const card = parseRecipeCardText(doughText);
  assert.equal(card.name, 'Pizza Dough');
  assert.deepEqual(card.yield, { amount: 40, unit: 'each' });
  assert.deepEqual(card.ingredients.map((i) => [i.amount, i.unit, i.name]), [
    [25, 'lb', 'Flour, Pizza'],
    [16, 'qt', 'Water'],
    [1.5, 'cup', 'Salt, Kosher'],
    [2, 'oz', 'Yeast, Fresh Eagle Compressed'],
    [0.25, 'cup', 'Oil, Olive Extra Virgin'],
  ]);
  assert.equal(card.method, 'Mix flour and water.\nRest 20 minutes.\nBall at 280 g.');
});

const product = (id: string, name: string, baseUnit: string, conversions = {}): ImportedProduct => ({ externalId: id, name, baseUnit, conversions });
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

  // Water, salt, yeast and olive oil aren't products in this sample.
  const unknown = issues.filter((i) => i.type === 'unknownIngredient').map((i) => i.type === 'unknownIngredient' && i.ingredient);
  assert.deepEqual(unknown, ['Water', 'Salt, Kosher', 'Yeast, Fresh Eagle Compressed', 'Oil, Olive Extra Virgin']);
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
