import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerProblem, withAnswer, type LinkAnswers } from '../src/server/model.ts';

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
