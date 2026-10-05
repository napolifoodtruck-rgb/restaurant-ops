import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLines, dayShare, roundUp, stepFor, weekdayOf, type DaySales } from '../src/core/stationLists.ts';

// Four weeks: Tuesdays $3,000, Fridays $5,000, Saturdays $4,600, closed Sunday and Monday.
const sales: DaySales[] = [];
for (let week = 0; week < 4; week++) {
  const base = new Date(Date.UTC(2026, 8, 1 + week * 7)); // Tue Sep 1
  const day = (offset: number, netSales: number) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + offset);
    sales.push({ date: d.toISOString().slice(0, 10), netSales });
  };
  day(0, 3000); day(3, 5000); day(4, 4600); day(5, 0);
}

test('how busy a day runs next to the busiest', () => {
  assert.equal(weekdayOf('2026-10-06'), 2); // a Tuesday
  assert.deepEqual(dayShare(sales, 2), { share: 0.6, busiest: 5 });
  assert.equal(dayShare(sales, 6)!.share, 0.92);
  assert.equal(dayShare(sales, 1), undefined); // never open on Mondays
});

test('par scaled to the day, rounded up in halves or wholes; to make is par minus count', () => {
  assert.deepEqual([stepFor(3), stepFor(0.25), stepFor(6), stepFor(14)], [0.5, 0.5, 1, 1]);
  assert.equal(roundUp(1.8, 0.5), 2);
  const items = [
    { id: 'dressing', name: 'House dressing', unit: 'bottle', kind: 'count' as const, par: 3 },
    { id: 'bresaola', name: 'Bresaola', unit: 'portion', kind: 'count' as const, par: 14 },
    { id: 'saba', name: 'Saba', unit: 'bottle', kind: 'count' as const, par: 0.25 },
    { id: 'togo', name: 'To-go salads', unit: 'each', kind: 'count' as const, par: 8, weekdays: [5] },
    { id: 'ham', name: 'Ready the ham', kind: 'task' as const },
  ];
  const tuesday = dayLines(items, '2026-10-06', dayShare(sales, 2), new Map([['dressing', 0.5], ['bresaola', 10], ['saba', 0.25]]));
  assert.deepEqual(tuesday.map((l) => [l.item.id, l.dayPar, l.suggested]), [
    ['dressing', 2, 1.5], // 60% of 3 = 1.8 → 2, minus 0.5 on hand
    ['bresaola', 9, 0], // 60% of 14 = 8.4 → 9, already 10
    ['saba', 0.5, 0.5], // never below one step: half a bottle
    ['ham', undefined, undefined],
  ]);
  assert.match(tuesday[0]!.reason!, /Tuesday usually runs at 60% of a Friday: par 2 instead of 3, 0.5 on hand/);
  const friday = dayLines(items, '2026-10-09', dayShare(sales, 5), new Map([['togo', 0]]));
  assert.deepEqual(friday.map((l) => [l.item.id, l.dayPar, l.suggested]), [['dressing', 3, undefined], ['bresaola', 14, undefined], ['saba', 0.25, undefined], ['togo', 8, 8], ['ham', undefined, undefined]]);
});

test('bulk prep is inventory: fills draw it down, batches add, counts reset it', async () => {
  const { batchSuggestion, onHandFrom } = await import('../src/core/stationLists.ts');
  const ledger = [
    { at: '2026-10-02T15:00:00Z', kind: 'counted' as const, setTo: 6 },
    { at: '2026-10-03T14:00:00Z', kind: 'filled' as const, change: -4 }, // pizza filled 2 sixth pans
    { at: '2026-10-03T16:00:00Z', kind: 'made' as const, change: 8 },
    { at: '2026-10-04T14:00:00Z', kind: 'filled' as const, change: -7 },
  ];
  assert.deepEqual(onHandFrom(ledger), { amount: 3, estimated: true, countedAt: '2026-10-02T15:00:00Z' });
  assert.deepEqual(onHandFrom([...ledger, { at: '2026-10-04T23:00:00Z', kind: 'counted', setTo: 2.5 }]), { amount: 2.5, estimated: false, countedAt: '2026-10-04T23:00:00Z' });
  assert.equal(onHandFrom([]), undefined);

  // Pizza fills 3 sixth pans tomorrow at 2 qt each = 6 qt; about 3 qt on hand; a batch makes 8 qt.
  const s = batchSuggestion([{ station: 'Pizza', item: 'Spinach Panna', unit: '1/6 pan', toMake: 3, holds: 2 }], onHandFrom(ledger), { name: 'Spinach Panna', unit: 'qt', batchYield: 8 })!;
  assert.deepEqual([s.suggested, s.need], [1, 6]);
  assert.equal(s.reason, 'Pizza fills 3 1/6 pan (6 qt); about 3 qt on hand (estimated since the last count): make 1 batch (8 qt).');
  // Enough on hand, or a small shortfall: wait a day.
  assert.equal(batchSuggestion([{ station: 'Pizza', item: 'Spinach Panna', toMake: 2, holds: 2 }], { amount: 3, estimated: false }, { name: 'S', unit: 'qt', batchYield: 8 })!.suggested, 0);
  // Missing pieces are said, not guessed.
  const unknown = batchSuggestion([{ station: 'Expo', item: 'Ricotta (fill)', unit: '1/9 pan', toMake: 1 }, { station: 'Pizza', item: 'Ricotta', toMake: undefined, holds: 1 }], undefined, { name: 'Ricotta', unit: 'qt' })!;
  assert.equal(unknown.suggested, undefined);
  assert.deepEqual(unknown.missing, ['Expo Ricotta (fill) (how much one 1/9 pan holds)', 'Pizza Ricotta (not counted)']);
  assert.match(unknown.reason, /Set how much one batch makes/);
});
