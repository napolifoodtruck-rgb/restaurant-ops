import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessArea } from '../src/server/areas.ts';

test('Square categories sort into kitchen, bar or neither by name', () => {
  const sides = Object.fromEntries(['Pizza', 'Apps', 'Gelato', 'Dessert', 'Specials & Archive', 'Online Gelato & Merch', 'Beer', 'Wine', 'Cocktails', 'Non-Alcoholic Drinks', 'Online Drinks', 'Coffee', 'Merch', ''].map((c) => [c, guessArea(c)]));
  assert.deepEqual(sides, {
    Pizza: 'kitchen', Apps: 'kitchen', Gelato: 'kitchen', Dessert: 'kitchen', 'Specials & Archive': 'kitchen', 'Online Gelato & Merch': 'kitchen',
    Beer: 'bar', Wine: 'bar', Cocktails: 'bar', 'Non-Alcoholic Drinks': 'bar', 'Online Drinks': 'bar', Coffee: 'bar', Merch: 'none', '': 'none',
  });
});

test('card names are capitalized the way the book writes them', async () => {
  const { titleCase } = await import('../src/server/cards.ts');
  assert.deepEqual(['apricot glaze', 'BOH chili oil', 'Gluten Free dough1', 'brussels sprouts with black garlic'].map(titleCase),
    ['Apricot Glaze', 'BOH Chili Oil', 'Gluten Free Dough', 'Brussels Sprouts with Black Garlic']);
});
