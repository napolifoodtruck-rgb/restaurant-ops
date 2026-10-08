import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerProblem, latestAnswers, withAnswer, type LinkAnswers } from '../src/server/model.ts';

const empty: LinkAnswers = { confirm: [], newDish: [] };

test('answers fold into the kitchen book; a later answer about the same item replaces the earlier one', () => {
  const corn = { catalogId: 'C1', itemName: 'Corn Panna' };
  let book = withAnswer(empty, { type: 'link', ...corn, recipe: 'Corn Panna' });
  assert.deepEqual(book.confirm, [{ ...corn, recipe: 'Corn Panna' }]);
  book = withAnswer(book, { type: 'newDish', ...corn });
  assert.deepEqual([book.confirm.length, book.newDish.length], [0, 1]);
  book = withAnswer(book, { type: 'notFood', ...corn });
  assert.deepEqual([book.newDish.length, book.notFood!.length], [0, 1]);
  // A dated version is its own answer: the summer and fall ricotta on one button both stay.
  const ricotta = { catalogId: 'R1', itemName: 'Ricotta Appetizer' };
  book = withAnswer(withAnswer(book, { type: 'link', ...ricotta, recipe: 'Ricotta and Heirloom Tomatoes' }), { type: 'newDish', ...ricotta, from: '2026-08-18' });
  assert.equal(book.confirm.filter((x) => x.catalogId === 'R1').length + book.newDish.filter((x) => x.catalogId === 'R1').length, 2);
  // Dismissing twice keeps one.
  book = withAnswer(withAnswer(book, { type: 'dismiss', dedupeKey: 'menu:changed:X' }), { type: 'dismiss', dedupeKey: 'menu:changed:X' });
  assert.equal(book.dismissed!.length, 1);
  assert.equal(empty.confirm.length, 0); // the original is untouched
});

test('a new answer keeps what was said about the menu, and replaces the same button under any variation', () => {
  const book: LinkAnswers = {
    confirm: [], newDish: [{ catalogId: 'S1', itemName: 'Salsiccia', variationName: 'Regular', at: '2026-10-07T17:00:00Z' }],
    notFood: [{ catalogId: 'S1', itemName: 'Salsiccia' }],
    menuStatus: [{ recipeId: 'greca', status: 'off', date: '2026-10-01' }], priceSplit: ['W1'], priceMerge: [{ catalogId: 'W2', into: 'W3' }],
  };
  const next = withAnswer(book, { type: 'link', catalogId: 'S1', itemName: 'Salsiccia', recipe: 'Salsiccia' }, { at: '2026-10-08T16:00:00Z' });
  assert.deepEqual(next.menuStatus, book.menuStatus);
  assert.deepEqual([next.priceSplit, next.priceMerge], [book.priceSplit, book.priceMerge]);
  assert.deepEqual([next.confirm.length, next.newDish.length, next.notFood!.length], [1, 0, 0]);
});

test('the latest answer about a button wins, whatever kind it is', () => {
  const links: LinkAnswers = {
    confirm: [{ catalogId: 'K1', itemName: 'Katahdin', recipe: 'Katahdin', at: '2026-10-08T12:00:00Z' }, { catalogId: 'C1', itemName: 'Corn Panna', recipe: 'Corn Panna' }],
    newDish: [{ catalogId: 'K1', itemName: 'Katahdin', variationName: 'Regular', at: '2026-10-07T12:00:00Z' }, { catalogId: 'W1', itemName: 'Watermelon & Feta', at: '2026-10-07T12:00:00Z' }],
    notFood: [{ catalogId: 'K1', itemName: 'Katahdin' }, { catalogId: 'W1', itemName: 'Watermelon & Feta' }, { catalogId: 'C1', itemName: 'Corn Panna' }],
  };
  const l = latestAnswers(links);
  assert.deepEqual(l.confirm.map((x) => x.itemName), ['Katahdin']);
  assert.deepEqual(l.newDish.map((x) => x.itemName), ['Watermelon & Feta']);
  // Two answers from the file with no time: as before, "not food" is the one that counts.
  assert.deepEqual(l.notFood!.map((x) => x.itemName), ['Corn Panna']);
});

test('answers are checked before saving', () => {
  assert.equal(answerProblem({ type: 'link', catalogId: 'C', itemName: 'X', recipe: 'Y' }), undefined);
  assert.match(answerProblem({ type: 'link', catalogId: 'C', itemName: 'X' })!, /recipe/);
  assert.match(answerProblem({ type: 'newDish', catalogId: 'C', itemName: 'X', from: 'Aug 18' })!, /YYYY-MM-DD/);
  assert.match(answerProblem({ type: 'delete everything' })!, /Unknown/);
  assert.match(answerProblem({ type: 'dismiss' })!, /which/);
});

test('product answers: weights, densities, pack contents and prices fold into the import answers', async () => {
  const { withProductAnswer } = await import('../src/server/model.ts');
  let a = withProductAnswer({}, { type: 'conversion', productId: 'spinach', fact: 'gramsPerEach', amount: 4, amountUnit: 'lb' }, '2026-10-05');
  assert.ok(Math.abs(a.conversions!.spinach!.gramsPerEach! - 4 * 453.59237) < 1e-6);
  a = withProductAnswer(a, { type: 'conversion', productId: 'tomatoes', fact: 'gramsPerMl', unit: 'pt', amount: 12, amountUnit: 'oz' }, '2026-10-05');
  assert.ok(Math.abs(a.conversions!.tomatoes!.gramsPerMl! - (12 * 28.349523125) / 473.176473) < 1e-3);
  a = withProductAnswer(a, { type: 'conversion', productId: 'chili', fact: 'customUnit', unit: 'case', amount: 6, amountUnit: 'lb' }, '2026-10-05');
  assert.deepEqual(a.conversions!.chili!.customUnits, { case: { amount: 6, unit: 'lb' } });
  a = withProductAnswer(a, { type: 'price', productId: 'panko', price: 18.5, amount: 5, unit: 'lb' }, '2026-10-05');
  assert.deepEqual(a.manualPrices!.panko, { price: 18.5, per: { amount: 5, unit: 'lb' }, date: '2026-10-05', note: 'entered in the app' });
  assert.ok(a.conversions!.spinach, 'earlier answers are kept');
  assert.throws(() => withProductAnswer({}, { type: 'conversion', productId: 'x', fact: 'gramsPerEach', amount: 1, amountUnit: 'qt' }, '2026-10-05'));
});

test('recipes that look like one dish: "pizza" left off, or a letter or two misspelled', async () => {
  const { sameDishAs } = await import('../src/server/cards.ts');
  const card = (name: string, recipeType = 'Pizza') => ({ name, recipeType, category: 'Menu items', yields: [{ amount: 1, unit: 'each' }], ingredients: [] });
  const cards = [card('Katahdin'), card('Katahdin Pizza'), card('Khatadin Pizza'), card('Margherita'), card('Marinara pizza'), card('Marinara Sauce', 'Prep'), card('Greca'), card('Greens')];
  assert.deepEqual(sameDishAs(cards[1]!, cards), ['Katahdin', 'Khatadin Pizza']);
  assert.deepEqual(sameDishAs(cards[3]!, cards), []); // Margherita and Marinara are different pizzas
  assert.deepEqual(sameDishAs(cards[4]!, cards), []); // a sauce isn't a pizza
  assert.deepEqual(sameDishAs(cards[6]!, cards), []); // short names need to match exactly
});
