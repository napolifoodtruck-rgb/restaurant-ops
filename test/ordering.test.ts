import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveOrder, deliveryToOrderFor, draftOrder, inferDeliveryDays, nextDeliveries, OrderError, orderEmail, recommendLine, type DeliveryRecord, type DeliverySchedule } from '../src/core/ordering.ts';
import { addDays, weekdayOf } from '../src/core/forecast.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

test('delivery days are learned from invoice dates; one-off deliveries are ignored', () => {
  const records: DeliveryRecord[] = [];
  for (let d = '2026-07-01'; d <= '2026-09-30'; d = addDays(d, 1)) {
    if (weekdayOf(d) === 2 || weekdayOf(d) === 5) records.push({ vendorId: 'produce', date: d }); // Tuesdays and Fridays
    if (weekdayOf(d) === 4 && d.endsWith('3')) records.push({ vendorId: 'cheese', date: d }); // a few Thursdays
  }
  records.push({ vendorId: 'produce', date: '2026-08-12' }); // one emergency Wednesday
  records.push({ vendorId: 'produce', date: '2026-08-14' }); // and a duplicate invoice the same Friday
  records.push({ vendorId: 'once', date: '2026-08-01' });
  const schedules = inferDeliveryDays(records);
  const produce = schedules.find((s) => s.vendorId === 'produce')!;
  assert.deepEqual(produce.weekdays, [2, 5]);
  assert.equal(produce.counts[3], 1); // the Wednesday is seen, not scheduled
  assert.equal(schedules.find((s) => s.vendorId === 'once'), undefined); // too few to call a schedule
});

const produce: DeliverySchedule = { vendorId: 'produce', weekdays: [2, 5], counts: [], deliveries: 26, source: 'confirmed', cutoff: { daysBefore: 1, time: '14:00' } };

test('the next order is for the first delivery whose cutoff has not passed', () => {
  assert.deepEqual(nextDeliveries(produce, '2026-10-05'), ['2026-10-06', '2026-10-09']);
  // Monday 10 am: Tuesday's order is due today at 2 pm.
  assert.deepEqual(deliveryToOrderFor(produce, '2026-10-05', '10:00'), { delivery: '2026-10-06', following: '2026-10-09', deadline: { date: '2026-10-05', time: '14:00' } });
  // Monday 3 pm: too late for Tuesday, so Friday's (due Thursday at 2).
  assert.deepEqual(deliveryToOrderFor(produce, '2026-10-05', '15:00'), { delivery: '2026-10-09', following: '2026-10-13', deadline: { date: '2026-10-08', time: '14:00' } });
});

// Closed Sundays and Mondays.
const openDays = (perDay: number) => (date: string) => (weekdayOf(date) === 0 || weekdayOf(date) === 1 ? 0 : perDay);

test('order enough to last until the following delivery, in whole packs', () => {
  const flour = { productId: 'flour', dailyUse: openDays(20), packSize: 50, packName: '50 lb bag', packPrice: 46 };
  // Tuesday delivery, next one Friday: Tue–Thu use 60 lb, +15% = 69; 30 on hand → 39 short → one bag.
  const line = recommendLine({ ...flour, onHand: 30 }, '2026-10-05', '2026-10-06', '2026-10-09')!;
  assert.equal(line.packs, 1);
  close(line.coverNeeded, 60);
  assert.equal(line.cost, 46);
  assert.equal(line.reason, '60 needed until 2026-10-09 + 15% safety, 30 left at delivery');
  // Plenty on hand: nothing to order.
  assert.equal(recommendLine({ ...flour, onHand: 100 }, '2026-10-05', '2026-10-06', '2026-10-09'), undefined);
  // Friday's delivery covers through Monday's closure to Tuesday: Fri + Sat = 40 lb, but Wed–Thu come out of stock first.
  const friday = recommendLine({ ...flour, onHand: 50, onHandIsEstimate: true }, '2026-10-06', '2026-10-09', '2026-10-13')!;
  // 50 on hand − 40 used Wed–Thu = 10 left; 40 × 1.25 − 10 = 40 → one bag.
  assert.equal(friday.packs, 1);
  assert.match(friday.reason, /25% safety, 10 left at delivery \(estimated\)/);
});

test('never order more than will keep', () => {
  // Arugula keeps 4 days; with weekly deliveries the week's need is capped.
  const arugula = { productId: 'arugula', onHand: 0, dailyUse: () => 1, packSize: 3, packName: '3 lb case', shelfLifeDays: 4 };
  const line = recommendLine(arugula, '2026-10-05', '2026-10-06', '2026-10-13')!;
  assert.equal(line.packs, 1);
  assert.equal(line.capped, true);
});

test('orders are drafts until a manager approves them', () => {
  const lines = [recommendLine({ productId: 'flour', onHand: 0, dailyUse: () => 20, packSize: 50, packName: '50 lb bag', packPrice: 46 }, '2026-10-05', '2026-10-06', '2026-10-09')!];
  const draft = draftOrder('produce', '2026-10-06', lines, { minimum: 150, deadline: { date: '2026-10-05', time: '14:00' } });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.total, 92);
  assert.equal(draft.belowMinimum, true);
  assert.throws(() => orderEmail(draft, 'Napoli', () => 'Flour'), OrderError);
  const approved = approveOrder(draft, 'manager-1', '2026-10-05T11:00:00Z');
  assert.equal(approved.status, 'approved');
  const email = orderEmail(approved, 'Napoli', () => 'Flour, Pizza');
  assert.equal(email.subject, 'Napoli order for delivery 2026-10-06');
  assert.match(email.body, /- 2 × 50 lb bag {2}Flour, Pizza/);
  assert.throws(() => approveOrder(draftOrder('produce', '2026-10-06', []), 'm', 'now'), OrderError);
});
