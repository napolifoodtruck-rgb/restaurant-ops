import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf } from '../src/server/appInvoices.ts';
import type { ImportedProduct } from '../src/connectors/marginedge.ts';

const basil: ImportedProduct = { externalId: 'p-basil', name: 'Basil, Fresh', baseUnit: 'lb', conversions: {}, categoryType: 'FOOD' };

test('units that won’t convert are refused', () => {
  assert.equal(baseOf(basil, 'oz'), 0.0625);
  assert.equal(baseOf(basil, 'lb'), 1);
  assert.equal(baseOf(basil, 'floz'), undefined);
});
