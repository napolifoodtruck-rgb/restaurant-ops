import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestPortions, withIngredientAmount } from '../src/core/portionCheck.ts';
import { RecipeBook, type Product, type Recipe } from '../src/core/recipes.ts';

const products: Product[] = [
  { id: 'pepperoni', name: 'Pepperoni, Sliced', baseUnit: 'lb', cost: { price: 5.5, per: { amount: 1, unit: 'lb' } } },
  { id: 'mozz', name: 'Mozzarella', baseUnit: 'lb', cost: { price: 4.4, per: { amount: 1, unit: 'lb' } } },
  { id: 'flour', name: 'Flour', baseUnit: 'lb', cost: { price: 0.9, per: { amount: 1, unit: 'lb' } } },
  { id: 'chorizo', name: 'Chorizo', baseUnit: 'lb', cost: { price: 11, per: { amount: 1, unit: 'lb' } } },
];
const p = (id: string, amount: number, unit: string) => ({ item: { kind: 'product' as const, id }, quantity: { amount, unit } });
const r = (kind: 'dish' | 'prep') => (id: string, ...ingredients: Recipe['ingredients']): Recipe => ({ id, name: id[0]!.toUpperCase() + id.slice(1), kind, yield: kind === 'dish' ? { amount: 1, unit: 'each' } : { amount: 10, unit: 'each' }, ingredients });
const recipes: Recipe[] = [
  r('prep')('dough', p('flour', 3, 'lb')),
  r('dish')('pepperoni', { item: { kind: 'recipe', id: 'dough' }, quantity: { amount: 1, unit: 'each' } }, p('mozz', 3, 'oz'), p('pepperoni', 3, 'oz')),
  r('dish')('margherita', { item: { kind: 'recipe', id: 'dough' }, quantity: { amount: 1, unit: 'each' } }, p('mozz', 3, 'oz')),
  r('dish')('calabria', p('chorizo', 0.8, 'oz')),
];
const book = new RecipeBook(products, recipes);

test('an ingredient in one dish: purchases give its real portion', () => {
  const suggestions = suggestPortions(book, {
    // 958 pizzas + 156 add-ons at 3 oz = 208.9 lb expected; 120 lb bought.
    expectedUse: new Map([['pepperoni', (1114 * 3) / 16], ['mozz', 400], ['flour', 900], ['chorizo', 50]]),
    purchased: new Map([['pepperoni', 120], ['mozz', 520], ['flour', 950], ['chorizo', 52]]),
    dishesSold: new Map([['pepperoni', 958], ['margherita', 1928], ['calabria', 1075]]),
  });
  // Mozzarella is on two dishes and flour is inside a prep: not pinned on one dish. Chorizo matches.
  assert.deepEqual(suggestions.map((s) => [s.recipeName, s.productName, s.card.amount, s.suggested.amount, s.suggested.unit]), [['Pepperoni', 'Pepperoni, Sliced', 3, 1.75, 'oz']]);
  assert.equal(suggestions[0]!.message, 'Pepperoni: purchases of Pepperoni, Sliced fit 1.75 oz a portion, the recipe says 3 oz. Use 1.75 oz, or weigh a few?');
});

test('a confirmed portion changes the recipe', () => {
  const updated = withIngredientAmount(recipes, 'pepperoni', { kind: 'product', id: 'pepperoni' }, { amount: 1.75, unit: 'oz' });
  const after = new RecipeBook(products, updated);
  const before = book.portionCost('pepperoni').total;
  assert.ok(Math.abs(before - after.portionCost('pepperoni').total - (1.25 / 16) * 5.5) < 1e-9);
  assert.deepEqual(recipes.find((x) => x.id === 'pepperoni')!.ingredients[2]!.quantity, { amount: 3, unit: 'oz' }); // the original is untouched
});

test('with dishes still missing cards, only buying less than the card is conclusive', () => {
  const input = {
    expectedUse: new Map([['pepperoni', 100], ['chorizo', 40]]),
    purchased: new Map([['pepperoni', 60], ['chorizo', 60]]),
    dishesSold: new Map([['pepperoni', 500], ['calabria', 800]]),
    unlinkedSales: true,
  };
  // Chorizo bought 1.5× could be a dish without a card; pepperoni bought 0.6× can't be.
  assert.deepEqual(suggestPortions(book, input).map((s) => s.productName), ['Pepperoni, Sliced']);
  // Once a manager says chorizo goes into nothing else, its gap counts.
  assert.deepEqual(suggestPortions(book, { ...input, exclusive: new Set(['chorizo']) }).map((s) => s.productName), ['Chorizo', 'Pepperoni, Sliced']);
});
