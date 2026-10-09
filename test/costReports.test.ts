import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursGrid, primeCost, priceHistory, purchaseKind, spreadShift, usageGaps, weekOf } from '../src/core/costReports.ts';

test('weeks run Monday to Sunday; purchases sort into food, bar and everything else', () => {
  assert.equal(weekOf('2026-10-04'), '2026-09-28'); // a Sunday belongs to the week before
  assert.equal(weekOf('2026-10-05'), '2026-10-05');
  assert.deepEqual(['FOOD', 'WINE', 'NA_BEVERAGES', 'OTHER', undefined].map(purchaseKind), ['food', 'bar', 'bar', 'other', 'other']);
});

test('prime cost: food and bar bought plus labor, week by week, against sales', () => {
  const r = primeCost(
    [{ day: '2026-09-29', sales: 4000 }, { day: '2026-10-03', sales: 6000 }, { day: '2026-10-06', sales: 3000 }],
    [{ date: '2026-09-30', amount: 2500, kind: 'food' }, { date: '2026-10-01', amount: 800, kind: 'bar' }, { date: '2026-10-01', amount: 300, kind: 'other' }],
    [{ day: '2026-10-03', cost: 2000, hours: 160, job: 'Server' }, { day: '2026-10-06', cost: 700, hours: 55, job: 'Pizza Maker' }],
  );
  assert.deepEqual(r.weeks.map((w) => [w.week, w.sales, w.food, w.bar, w.labor, w.prime, w.days]), [['2026-09-28', 10000, 2500, 800, 2000, 5300, 2], ['2026-10-05', 3000, 0, 0, 700, 700, 1]]);
  assert.equal(r.weeks[0]!.primeShare, 0.53); // supplies aren't prime cost
  assert.deepEqual([r.total.sales, r.total.prime], [13000, 6000]);
  assert.deepEqual(r.byJob.map((j) => j.job), ['Server', 'Pizza Maker']);
});

test('recipes against purchases: the gap per product, and what was bought that no recipe uses', () => {
  const names = new Map([['mozz', 'Mozzarella'], ['flour', 'Flour'], ['gloves', 'Gloves'], ['basil', 'Basil']]);
  const kinds = new Map([['mozz', 'food' as const], ['flour', 'food' as const], ['basil', 'food' as const]]);
  const r = usageGaps(
    [{ productId: 'mozz', name: 'Mozzarella', dollars: 1000 }, { productId: 'flour', name: 'Flour', dollars: 300 }],
    [{ date: '2026-10-01', amount: 1400, kind: 'food', productId: 'mozz' }, { date: '2026-10-01', amount: 290, kind: 'food', productId: 'flour' }, { date: '2026-10-01', amount: 60, kind: 'food', productId: 'basil' }, { date: '2026-10-01', amount: 80, kind: 'other', productId: 'gloves' }],
    names, kinds,
  );
  assert.deepEqual(r.rows.map((x) => [x.name, x.bought, x.expected, x.gap]), [['Mozzarella', 1400, 1000, 400], ['Flour', 290, 300, -10]]);
  assert.deepEqual(r.notOnRecipes.map((x) => x.name), ['Basil']); // gloves are supplies, not food
  assert.deepEqual(r.totals, { bought: 1690, expected: 1300, gap: 390, boughtOff: 60 });
});

test('shifts spread over the hours worked; the grid averages each weekday’s open days', () => {
  assert.deepEqual(spreadShift({ clockIn: '2026-10-03 16:30:00', clockOut: '2026-10-03 18:15:00' }), [{ day: '2026-10-03', hour: 16, hours: 0.5 }, { day: '2026-10-03', hour: 17, hours: 1 }, { day: '2026-10-03', hour: 18, hours: 0.25 }]);
  const g = hoursGrid(
    [{ day: '2026-09-26', hour: 18, sales: 2000, orders: 20, covers: 50 }, { day: '2026-10-03', hour: 18, sales: 2400, orders: 22, covers: 60 }],
    [{ day: '2026-10-03', clockIn: '2026-10-03 17:00:00', clockOut: '2026-10-03 19:00:00', cost: 30 }, { day: '2026-09-26', clockIn: '2026-09-26 18:00:00', clockOut: '2026-09-26 19:00:00', cost: 15 }],
  );
  const sat6 = g.cells.find((c) => c.weekday === 6 && c.hour === 18)!;
  assert.deepEqual([sat6.sales, sat6.covers, sat6.laborHours, sat6.perLaborHour], [2200, 55, 1, 2200]); // two Saturdays, averaged
  assert.deepEqual([g.weekdays, g.hours, g.days], [[6], [17, 18], { 6: 2 }]);
});

test('an ingredient’s price over time: vendor changes and how much it moved', () => {
  const p = (date: string, vendor: string, perUnit: number) => ({ date, vendor, perUnit, packPrice: perUnit * 50, pack: '50 lb', quantity: 1 });
  const h = priceHistory([p('2025-10-01', 'Ferraro', 0.8), p('2026-07-01', 'Ferraro', 0.9), p('2026-09-20', 'IGF', 1.0), p('2026-10-01', 'IGF', 1.0)], '2026-10-05');
  assert.deepEqual(h.switches, [{ date: '2026-09-20', from: 'Ferraro', to: 'IGF' }]);
  assert.equal(h.latest, 1);
  assert.equal(Math.round(h.change90! * 100), 11); // from 0.90 in early July
  assert.equal(Math.round(h.change365! * 100), 25); // from 0.80 a year ago
  assert.deepEqual(h.vendors.map((v) => v.vendor), ['IGF', 'Ferraro']);
});

test('last price by vendor, and a nudge when another vendor was cheaper', () => {
  const p = (date: string, vendor: string, perUnit: number) => ({ date, vendor, perUnit, packPrice: perUnit * 50, pack: '50 lb', quantity: 1 });
  const h = priceHistory([p('2026-06-01', 'Ferraro', 0.95), p('2026-08-01', 'Ferraro', 0.9), p('2026-09-20', 'IGF', 1.0), p('2026-10-01', 'IGF', 1.0)], '2026-10-05');
  assert.deepEqual(h.vendors.map((v) => [v.vendor, v.lastPerUnit, v.last, v.lastPackPrice]), [['IGF', 1, '2026-10-01', 50], ['Ferraro', 0.9, '2026-08-01', 45]]);
  assert.deepEqual(h.cheaper, { vendor: 'Ferraro', perUnit: 0.9, date: '2026-08-01', current: 'IGF', currentPerUnit: 1, saves: 0.1, daysOld: 65 });
  // Buying the cheaper one already, or the gap is under 3%: no nudge.
  assert.equal(priceHistory([p('2026-09-20', 'IGF', 1.0), p('2026-10-01', 'Ferraro', 0.9)], '2026-10-05').cheaper, undefined);
  assert.equal(priceHistory([p('2026-09-20', 'Ferraro', 0.98), p('2026-10-01', 'IGF', 1.0)], '2026-10-05').cheaper, undefined);
  assert.equal(priceHistory([p('2026-10-01', 'IGF', 1.0)], '2026-10-05').cheaper, undefined);
  assert.equal(priceHistory([p('2026-03-01', 'Ferraro', 0.8), p('2026-10-01', 'IGF', 1.0)], '2026-10-05').cheaper, undefined); // too old to go on
});
