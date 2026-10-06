import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookPace, itemTimes, itemUsuals, listSpan, type WorkedList } from '../src/core/prepTiming.ts';

const at = (hh: number, mm: number) => Date.UTC(2026, 9, 5, hh, mm);

test('a list runs from Start prep to the last check-off', () => {
  const list: WorkedList = { listId: 'l', stationId: 's', date: '2026-10-05', startedAt: at(9, 0), marks: [{ itemId: 'a', doneAt: at(9, 20) }, { doneAt: at(10, 35) }] };
  assert.deepEqual(listSpan(list), { start: at(9, 0), end: at(10, 35), minutes: 95, measured: true });
  // Nobody tapped a start: from the first check-off, and said so.
  assert.equal(listSpan({ ...list, startedAt: undefined })!.measured, false);
  assert.equal(listSpan({ ...list, marks: [] }), undefined);
});

test('item times: exact from a Start tap, else since the same cook’s last check-off; breaks left out', () => {
  const list: WorkedList = {
    listId: 'l', stationId: 's', date: '2026-10-05', startedAt: at(9, 0),
    marks: [
      { itemId: 'dough', name: 'Pizza Dough', doneAt: at(9, 40), by: 'marco', amount: 2 },          // 40 since the start
      { itemId: 'sauce', name: 'Marinara', doneAt: at(9, 55), by: 'marco' },                         // 15 since dough
      { itemId: 'basil', name: 'Basil', startedAt: at(9, 50), doneAt: at(9, 58), by: 'ana' },        // exact 8
      { itemId: 'olives', name: 'Olives', doneAt: at(9, 30), by: 'ana' },                            // 30 since the start
      { doneAt: at(10, 0), by: 'marco' },                                                            // cleaning: a mark, not an item
      { itemId: 'garlic', name: 'Garlic', doneAt: at(12, 0), by: 'marco' },                          // two hours on: a break
    ],
  };
  const t = itemTimes([list]).map((x) => [x.name, x.minutes, x.exact, x.by]).sort();
  assert.deepEqual(t, [['Basil', 8, true, 'ana'], ['Marinara', 15, false, 'marco'], ['Olives', 30, false, 'ana'], ['Pizza Dough', 40, false, 'marco']]);
  // With no start tapped anywhere, a cook's first item has nothing to count from.
  const unstarted = itemTimes([{ ...list, startedAt: undefined, marks: list.marks.filter((m) => !m.startedAt) }]);
  assert.deepEqual(unstarted.map((x) => x.name).sort(), ['Marinara']);
});

test('cooks are compared on the same items, in the same amounts', () => {
  // Ana always makes the dough (slow item), Luis the garnish (quick); both at the usual pace for what they make.
  // Marco makes both, a little slower than usual each time.
  const times = [];
  for (let d = 1; d <= 6; d++) {
    times.push({ itemId: 'dough', name: 'Dough', minutes: 40, exact: true, by: 'ana', byName: 'Ana', stationId: 's', date: `d${d}`, amount: 2 });
    times.push({ itemId: 'garnish', name: 'Garnish', minutes: 5, exact: true, by: 'luis', byName: 'Luis', stationId: 's', date: `d${d}` });
    times.push({ itemId: 'dough', name: 'Dough', minutes: 40, exact: true, by: 'ana', byName: 'Ana', stationId: 's', date: `e${d}`, amount: 2 });
    times.push({ itemId: 'garnish', name: 'Garnish', minutes: 5, exact: true, by: 'luis', byName: 'Luis', stationId: 's', date: `e${d}` });
  }
  for (let d = 1; d <= 5; d++) {
    times.push({ itemId: 'dough', name: 'Dough', minutes: 50, exact: true, by: 'marco', byName: 'Marco', stationId: 's', date: `m${d}`, amount: 2 });
    times.push({ itemId: 'garnish', name: 'Garnish', minutes: 6, exact: true, by: 'marco', byName: 'Marco', stationId: 's', date: `m${d}` });
  }
  // A double batch takes longer, but isn't held against anyone.
  times.push({ itemId: 'dough', name: 'Dough', minutes: 60, exact: true, by: 'ana', byName: 'Ana', stationId: 's', date: 'big', amount: 4 });
  const usuals = itemUsuals(times);
  assert.equal(usuals.get('dough')!.minutes, 40);
  const pace = cookPace(times, usuals);
  assert.deepEqual(pace.map((p) => [p.name, p.ratio]), [['Ana', 1], ['Luis', 1], ['Marco', 1.23]]);
  // Too few timed items: not shown at all.
  assert.deepEqual(cookPace(times.filter((t) => t.by !== 'marco' || t.date === 'm1'), usuals).map((p) => p.name), ['Ana', 'Luis']);
});

test('a list in progress: what’s left at the usual times, less what’s already gone on started items', async () => {
  const { minutesLeft, itemUsuals: usualsOf } = await import('../src/core/prepTiming.ts');
  const t = (itemId: string, minutes: number) => ({ itemId, name: itemId, minutes, exact: true, stationId: 's', date: 'd' });
  const usuals = usualsOf([t('dough', 40), t('dough', 40), t('dough', 40), t('basil', 6), t('basil', 6), t('basil', 6)]);
  const now = at(10, 0);
  // Dough started 30 minutes ago (10 left), basil not started (6), something never timed (8), two cleaning tasks (4 each).
  assert.equal(minutesLeft([{ itemId: 'dough', startedAt: at(9, 30) }, { itemId: 'basil' }, { itemId: 'new' }], 2, usuals, now), 32);
  // Dough running long: still a minute to go, not negative.
  assert.equal(minutesLeft([{ itemId: 'dough', startedAt: at(8, 0) }], 0, usuals, now), 1);
});
