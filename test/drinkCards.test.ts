import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftDrinkCards } from '../src/core/drinkCards.ts';

const products = [
  { id: 'w1', name: 'Rocca Bianca Pinot Grigio 2024', unit: 'bottle', type: 'WINE' },
  { id: 'w2', name: 'Monte Verde Chianti DOCG 2023', unit: 'bottle', type: 'WINE' },
  { id: 'k1', name: 'Hilltop India Pale Ale Keg (1/6BBL)', unit: 'keg', type: 'BEER' },
  { id: 'c1', name: 'Diet Cola 8oz Bottle', unit: 'bottle', type: 'NA_BEVERAGES' },
  { id: 'b1', name: 'Coffee, Whole Bean', unit: 'lb', type: 'NA_BEVERAGES' },
  { id: 'm1', name: 'Milk, Whole', unit: 'gal', type: 'FOOD' },
  { id: 'l1', name: 'Campari', unit: 'bottle', type: 'LIQUOR' },
];
const item = (itemName: string, category: string, variationName?: string, netSales = 100) => ({ catalogId: `${itemName}|${variationName ?? ''}`, itemName, ...(variationName ? { variationName } : {}), category, netSales, quantity: 10 });

test('drinks are drafted by shape from POS buttons and invoice products', () => {
  const drafts = draftDrinkCards([
    item('Rocca Bianca Pinot Grigio GLS', 'Wine'), item('Rocca Bianca Pinot Grigio GLS', 'Wine', '50% OFF WEDNESDAY', 40),
    item('Monte Verde Chianti - BTL', 'Wine'),
    item('Hilltop IPA', 'Beer'),
    item('Diet Cola', 'Non-Alcoholic Drinks'),
    item('Latte', 'Non-Alcoholic Drinks'),
    item('Negroni', 'Cocktails'),
    item('Basil Limeade', 'Non-Alcoholic Drinks', '** ADD GIN'),
  ], products, { winePour: 5 });
  const by = Object.fromEntries(drafts.map((d) => [d.name, d]));
  assert.deepEqual(by['Rocca Bianca Pinot Grigio GLS']!.ingredients, [{ amount: 5, unit: 'floz', name: 'Rocca Bianca Pinot Grigio 2024' }]);
  assert.equal(by['Rocca Bianca Pinot Grigio GLS']!.items.length, 2); // Wednesday's price is the same pour
  assert.deepEqual(by['Monte Verde Chianti - BTL']!.ingredients, [{ amount: 1, unit: 'bottle', name: 'Monte Verde Chianti DOCG 2023' }]);
  assert.deepEqual(by['Hilltop IPA']!.ingredients, [{ amount: 16, unit: 'floz', name: 'Hilltop India Pale Ale Keg (1/6BBL)' }]);
  assert.deepEqual([by['Diet Cola']!.shape, by['Diet Cola']!.ingredients], ['direct', [{ amount: 1, unit: 'bottle', name: 'Diet Cola 8oz Bottle' }]]);
  assert.deepEqual(by['Latte']!.ingredients, [{ amount: 18, unit: 'g', name: 'Coffee, Whole Bean' }, { amount: 8, unit: 'floz', name: 'Milk, Whole' }]);
  assert.equal(by['Negroni']!.shape, 'ownCard');
  assert.equal(by['Basil Limeade (** ADD GIN)']!.shape, 'ownCard'); // adding a spirit is a different drink
});
