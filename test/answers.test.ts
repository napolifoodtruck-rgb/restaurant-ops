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
