import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversionError, convert, normalizeUnit, tryConvert } from '../src/core/units.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

test('standard conversions within a dimension', () => {
  close(convert({ amount: 1, unit: 'lb' }, 'oz'), 16);
  close(convert({ amount: 1, unit: 'qt' }, 'cup'), 4);
  close(convert({ amount: 1, unit: 'gal' }, 'qt'), 4);
  close(convert({ amount: 3, unit: 'tsp' }, 'tbsp'), 1);
  close(convert({ amount: 1, unit: 'kg' }, 'lb'), 2.2046226218487757);
  close(convert({ amount: 2, unit: 'dozen' }, 'each'), 24);
});

test('kitchen spellings resolve to one unit', () => {
  assert.equal(normalizeUnit('Quarts'), 'qt');
  assert.equal(normalizeUnit(' lbs '), 'lb');
  assert.equal(normalizeUnit('#'), 'lb');
  assert.equal(normalizeUnit('Fl Oz'), 'floz');
  close(convert({ amount: 2, unit: 'Pounds' }, 'OUNCES'), 32);
});

test('custom kitchen units are per item and can chain', () => {
  const aioli = { customUnits: { 'sixth pan': { amount: 2, unit: 'qt' } } };
  close(convert({ amount: 1, unit: 'sixth pan' }, 'cup', aioli), 8);
  close(convert({ amount: 6, unit: 'cup' }, 'Sixth Pan', aioli), 0.75);

  const onions = { customUnits: { case: { amount: 2, unit: 'bag' }, bag: { amount: 25, unit: 'lb' } } };
  close(convert({ amount: 1, unit: 'case' }, 'lb', onions), 50);
});

test('crossing dimensions uses item facts', () => {
  const oil = { gramsPerMl: 0.92 };
  close(convert({ amount: 1, unit: 'l' }, 'g', oil), 920);

  const steak = { gramsPerEach: 283.49523125 }; // a 10 oz steak
  close(convert({ amount: 4, unit: 'each' }, 'lb', steak), 2.5);
  close(convert({ amount: 5, unit: 'lb' }, 'each', steak), 8);

  // count → volume needs both facts: 1 lemon = 100 g, juice density 1 → 100 ml
  const lemon = { gramsPerEach: 100, gramsPerMl: 1 };
  close(convert({ amount: 3, unit: 'each' }, 'ml', lemon), 300);
});

test('a missing fact names exactly what to ask for', () => {
  assert.throws(
    () => convert({ amount: 1, unit: 'cup' }, 'lb'),
    (error: unknown) => error instanceof ConversionError && error.needed === 'gramsPerMl',
  );
  assert.throws(
    () => convert({ amount: 1, unit: 'each' }, 'oz'),
    (error: unknown) => error instanceof ConversionError && error.needed === 'gramsPerEach',
  );
  assert.throws(
    () => convert({ amount: 1, unit: 'hotel pan' }, 'qt'),
    (error: unknown) => error instanceof ConversionError && error.needed === 'unknownUnit',
  );
  assert.equal(tryConvert({ amount: 1, unit: 'cup' }, 'lb'), undefined);
});

test('a custom unit defined in terms of itself is caught', () => {
  const broken = { customUnits: { tub: { amount: 2, unit: 'bin' }, bin: { amount: 1, unit: 'tub' } } };
  assert.throws(
    () => convert({ amount: 1, unit: 'tub' }, 'qt', broken),
    (error: unknown) => error instanceof ConversionError && error.needed === 'customUnitLoop',
  );
});
