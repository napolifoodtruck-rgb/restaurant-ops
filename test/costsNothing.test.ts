import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costsNothing } from '../src/server/model.ts';

test('water, ice and soda from the gun cost nothing; bottled and branded ones do', () => {
  for (const n of ['Water', 'Tap Water', 'Ice', 'Soda Water', 'Club Soda', 'Water, Soda', 'Seltzer']) assert.equal(costsNothing(n), true, n);
  for (const n of ['Topo Chico Mineral Water 12oz', 'San Pellegrino Sparkling Water 750ml', 'Ice Cream Stabilizer', 'Coconut Water', 'Tonic Water']) assert.equal(costsNothing(n), false, n);
});
