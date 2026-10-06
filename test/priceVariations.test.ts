import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldedTotals, looksLikeDiscount, priceFolds } from '../src/core/priceVariations.ts';
import { recentAnswers, withAnswer, withoutAnswer } from '../src/server/model.ts';

const menu = [
  { catalogId: 'neg-r', itemId: 'neg', itemName: 'Negroni', variationName: 'Regular', price: 14 },
  { catalogId: 'neg-t', itemId: 'neg', itemName: 'Negroni', variationName: 'Tuesday $10', price: 10 },
  { catalogId: 'gavi-r', itemId: 'gavi', itemName: 'Gavi GLS', variationName: 'Regular', price: 12 },
  { catalogId: 'gavi-w', itemId: 'gavi', itemName: 'Gavi GLS', variationName: '50% OFF WINE WEDNESDAY', price: 6 },
  { catalogId: 'piz-s', itemId: 'piz', itemName: 'Margherita', variationName: 'Small' },
  { catalogId: 'piz-l', itemId: 'piz', itemName: 'Margherita', variationName: 'Large' },
  { catalogId: 'piz-h', itemId: 'piz', itemName: 'Margherita', variationName: 'Happy Hour' },
  { catalogId: 'spr-r', itemId: 'spr', itemName: 'Spritz', variationName: 'Regular' },
  { catalogId: 'spr-b', itemId: 'spr', itemName: 'Spritz', variationName: 'Bartender Pour' },
];

test('discount buttons are told by their names', () => {
  assert.deepEqual(['Tuesday $10', 'Cocktail Tuesday', '50% OFF WINE WEDNESDAY', 'Wednesday 50% Off', 'Happy Hour', 'Regular', 'Large', 'BTL', 'Sun-dried'].map(looksLikeDiscount),
    [true, true, true, true, true, false, false, false, false]);
});

test('a discount button folds into the one regular variation; sizes are left alone', () => {
  const fold = priceFolds(menu);
  assert.equal(fold({ catalogId: 'neg-t', itemName: 'Negroni', variationName: 'Tuesday $10' })?.catalogId, 'neg-r');
  assert.equal(fold({ catalogId: 'gavi-w', itemName: 'Gavi GLS', variationName: '50% OFF WINE WEDNESDAY' })?.catalogId, 'gavi-r');
  assert.equal(fold({ catalogId: 'old-id', itemName: 'Negroni', variationName: 'Cocktail Tuesday' })?.catalogId, 'neg-r'); // a button since deleted, by name
  assert.equal(fold({ catalogId: 'piz-h', itemName: 'Margherita', variationName: 'Happy Hour' }), undefined); // small or large? no telling
  assert.equal(fold({ catalogId: 'neg-r', itemName: 'Negroni', variationName: 'Regular' }), undefined);
});

test('kept apart, or folded by hand', () => {
  const fold = priceFolds(menu, { priceSplit: ['neg-t'], priceMerge: [{ catalogId: 'spr-b', into: 'spr-r' }] });
  assert.equal(fold({ catalogId: 'neg-t', itemName: 'Negroni', variationName: 'Tuesday $10' }), undefined);
  assert.equal(fold({ catalogId: 'spr-b', itemName: 'Spritz', variationName: 'Bartender Pour' })?.catalogId, 'spr-r');
  const totals = foldedTotals([{ into: 'neg-r', catalogId: 'neg-t', itemName: 'Negroni', variationName: 'Tuesday $10', quantity: 3, netSales: 30 }, { into: 'neg-r', catalogId: 'neg-t', itemName: 'Negroni', variationName: 'Tuesday $10', quantity: 2, netSales: 20 }]);
  assert.deepEqual(totals.get('neg-r'), [{ catalogId: 'neg-t', variationName: 'Tuesday $10', name: 'Negroni (Tuesday $10)', quantity: 5, netSales: 50 }]);
});

test('answers can be taken back, newest first in the list', () => {
  const item = { catalogId: 'cp', itemName: 'Corn Panna' };
  let links = withAnswer({ confirm: [], newDish: [] }, { type: 'notFood', catalogId: 'gc', itemName: 'Gift Card' }, { at: '2026-10-01T10:00:00Z', by: 's1' });
  links = withAnswer(links, { type: 'link', ...item, recipe: 'Corn Panna' }, { at: '2026-10-05T10:00:00Z', by: 's1' });
  links = withAnswer(links, { type: 'dismiss', dedupeKey: 'k1', note: 'Funghi changed?' }, { at: '2026-10-03T10:00:00Z' });
  assert.deepEqual(recentAnswers(links).map((a) => [a.type, a.name]), [['link', 'Corn Panna'], ['dismiss', 'Funghi changed?'], ['notFood', 'Gift Card']]);
  const undone = withoutAnswer(withoutAnswer(links, item), { dedupeKey: 'k1' });
  assert.deepEqual([undone.confirm.length, undone.dismissed!.length, undone.notFood!.length], [0, 0, 1]);
});

test('an item Square no longer lists folds by what sold', () => {
  const fold = priceFolds([], {}, [{ catalogId: 'a', itemName: 'Basil Gimlet', variationName: 'Regular' }, { catalogId: 'b', itemName: 'Basil Gimlet', variationName: 'Tuesday $10' }]);
  assert.equal(fold({ catalogId: 'b', itemName: 'Basil Gimlet', variationName: 'Tuesday $10' })?.catalogId, 'a');
});
