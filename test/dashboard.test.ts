import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastService, weekByDay, type DayTotals } from '../src/core/dashboard.ts';

const day = (d: string, sales: number, extra: Partial<DayTotals> = {}): DayTotals => ({ day: d, sales, orders: 100, covers: 0, ...extra });

test('the last service against a usual one: the same weekday, the four before it', () => {
  // Thursdays: Sep 17, 24, Oct 1, then Oct 8 (the last service before Friday Oct 9).
  const days = [day('2026-09-17', 3000), day('2026-09-24', 3200), day('2026-10-01', 3400), day('2026-10-07', 2500), day('2026-10-08', 3600, { orders: 120, labor: 900 }), day('2026-10-09', 800)];
  const l = lastService(days, '2026-10-09')!;
  assert.equal(l.day, '2026-10-08');
  assert.equal(l.perOrder, 30);
  assert.equal(l.laborShare, 0.25);
  assert.deepEqual(l.usual, { sales: 3200, orders: 100, weeks: 3 });
  assert.equal(lastService([day('2026-10-08', 3600)], '2026-10-09')!.usual, undefined); // not enough weeks to say
  assert.equal(lastService([], '2026-10-09'), undefined);
});

test('the week by day against last week; on a Monday morning, last week in full', () => {
  const days = [day('2026-09-28', 1000), day('2026-09-29', 1100), day('2026-10-05', 1200), day('2026-10-06', 1300), day('2026-10-07', 900)];
  const w = weekByDay(days, '2026-10-08'); // Thursday: Mon-Wed are in
  assert.equal(w.from, '2026-10-05');
  assert.equal(w.through, '2026-10-07');
  assert.ok(w.current);
  assert.equal(w.total, 3400);
  assert.equal(w.before, 2100); // Mon and Tue last week; nothing last Wednesday
  assert.deepEqual(w.days[0], { day: '2026-10-05', sales: 1200, before: 1000 });
  assert.deepEqual(w.days[6], { day: '2026-10-11' });
  const monday = weekByDay(days, '2026-10-12');
  assert.equal(monday.current, false);
  assert.equal(monday.from, '2026-10-05');
  assert.equal(monday.total, 3400);
});
