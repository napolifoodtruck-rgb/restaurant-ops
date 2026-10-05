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
