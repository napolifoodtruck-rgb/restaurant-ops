import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTAINERS, findContainer, recipeWeight, unitWeight, weightText } from '../src/core/containers.ts';

const near = (a: number | undefined, b: number, tol = 1) => assert.ok(a !== undefined && Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const pans = DEFAULT_CONTAINERS;

test('containers go by any of their names', () => {
  assert.equal(findContainer('Ninth Pan', pans)?.name, '1/9 pan');
  assert.equal(findContainer('(1/3) pan', pans)?.name, '1/3 pan');
  assert.equal(findContainer('Deep 1/9', pans)?.name, 'deep 1/9 pan');
  assert.equal(findContainer('1/6 pan 6"', pans)?.name, '1/6 pan 6in');
  assert.equal(findContainer('bottle', pans)?.name, 'squeeze bottle');
  assert.equal(findContainer('sheet tray', pans), undefined);
});

test('a recipe that states its weight under a second yield ("1 batch = 3,950 g")', () => {
  const conv = { customUnits: { g: { amount: 1 / 3950, unit: 'batch' } } };
  const w = recipeWeight({ amount: 1, unit: 'batch' }, conv, undefined)!;
  near(w.batchGrams, 3950, 0.01);
  assert.equal(w.stated, true);
  near(unitWeight('batch', undefined, w, pans)?.grams, 3950, 0.01);
});

test('a recipe made in its own container: one 1/3 pan = 4,000 g, and other containers by that density', () => {
  const conv = { customUnits: { '(1/3) pan': { amount: 4000, unit: 'g' } } };
  const w = recipeWeight({ amount: 4000, unit: 'g' }, conv, 9999)!; // stated beats the ingredients
  assert.equal(w.batchGrams, 4000);
  assert.deepEqual(unitWeight('third pan', undefined, w, pans), { grams: 4000, source: 'recipe' });
  const third = findContainer('1/3 pan', pans)!.volumeMl!, bottle = findContainer('squeeze bottle', pans)!.volumeMl!;
  near(unitWeight('bottle', undefined, w, pans)?.grams, (4000 / third) * bottle);
});

test('a syrup: sugar by the gram, made by the quart, poured by the fl oz', () => {
  // 1,000 g sugar + 1,000 g water makes 1.6 qt: about 1.32 g per ml.
  const w = recipeWeight({ amount: 1.6, unit: 'qt' }, undefined, 2000)!;
  assert.equal(w.stated, false);
  near(w.conversions.gramsPerMl! * 1000, 1321);
  near(unitWeight('fl oz', undefined, w, pans)?.grams, 39, 0.5);
  near(unitWeight('deli quart', undefined, w, pans)?.grams, 1250, 15);
});

test('what goes in is not what comes out: ricotta drains its whey, so the weight falls back to the volume', () => {
  const w = recipeWeight({ amount: 9, unit: 'cup' }, undefined, 4168)!; // milk and cream in, 9 cups out
  near(w.batchGrams, 2129);
  near(unitWeight('1/9 pan', undefined, w, pans)?.grams, findContainer('1/9 pan', pans)!.volumeMl!);
});

test('weighed beats everything; a weight unit is its own weight; nothing to go on gives nothing', () => {
  const w = recipeWeight({ amount: 1, unit: 'batch' }, undefined, 5000)!;
  assert.deepEqual(unitWeight('1/9 pan', 900, w, pans), { grams: 900, source: 'weighed' });
  assert.deepEqual(unitWeight('lb', undefined, undefined, pans), { grams: 453.59237, source: 'unit' });
  assert.equal(unitWeight('1/9 pan', undefined, undefined, pans), undefined);
  assert.equal(unitWeight('1/9 pan', undefined, w, pans), undefined); // a batch with no volume can't fill a pan
  assert.equal(unitWeight('batch', undefined, w, pans)?.grams, 5000);
});

test('pieces: 170 meatballs from 8.5 kg', () => {
  const w = recipeWeight({ amount: 170, unit: 'each' }, undefined, 8500)!;
  assert.equal(unitWeight('each', undefined, w, pans)?.grams, 50);
  assert.equal(unitWeight('batch', undefined, w, pans)?.grams, 8500);
});

test('weights read in pounds from a pound up', () => {
  assert.equal(weightText(2858), '6.3 lb');
  assert.equal(weightText(9275), '20 lb');
  assert.equal(weightText(300), '300 g');
  assert.equal(weightText(0), '');
});
