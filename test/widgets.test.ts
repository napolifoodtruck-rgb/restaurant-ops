import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWidgets, defaultWidgets } from '../src/core/widgets.ts';

test('each kind of post starts with what it needs most', () => {
  assert.deepEqual(defaultWidgets('kitchen').map((w) => w.type), ['dough', 'online', 'notes', 'specials', 'book']);
  assert.equal(defaultWidgets('kitchen')[0]!.size, 'wide');
  assert.equal(defaultWidgets('host')[1]!.type, 'online');
  assert.ok(!defaultWidgets('room').some((w) => w.type === 'dough'));
});

test('a manager’s choice is checked: known widgets, small or wide, a category for a counter', () => {
  assert.deepEqual(cleanWidgets([{ type: 'sales', size: 'wide', category: ' Cocktails ' }, { type: 'book', size: 'huge' }]),
    [{ type: 'sales', size: 'wide', category: 'Cocktails' }, { type: 'book', size: 'small' }]);
  assert.equal(cleanWidgets([{ type: 'sales', size: 'small' }]), undefined, 'a counter needs its category');
  assert.equal(cleanWidgets([{ type: 'weather', size: 'small' }]), undefined);
  assert.equal(cleanWidgets('dough'), undefined);
  assert.deepEqual(cleanWidgets([]), []);
});
