import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchStatus, discardBatch, logBatch, nightlyCountSheet, useByFor, type PrepBatch } from '../src/core/prep.ts';
import { forecastDay, type DailyItemSales } from '../src/core/forecast.ts';
import { prepDemand, prepList } from '../src/core/prepList.ts';
import { prepCheck, surplusPrep } from '../src/core/prepChecks.ts';
import { book, links } from './fixtures.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
const at = (iso: string) => new Date(iso);

/*
 * Scenario, in UTC. Sunday night count at 22:00 on Oct 4.
 * Next service: Tuesday Oct 6, 5–9 PM Eastern = 21:00 Oct 6 to 01:00 Oct 7 UTC.
 * Vodka sauce keeps 5 days, chopped garlic 3.
 */
const now = at('2026-10-04T22:00:00Z');
const tuesday = { start: at('2026-10-06T21:00:00Z'), end: at('2026-10-07T01:00:00Z') };

const batches: PrepBatch[] = [
  { id: 'sauce-a', recipeId: 'vodka-sauce', amount: 1, unit: 'sixth pan', preppedAt: at('2026-09-29T14:00:00Z'), useBy: at('2026-10-04T14:00:00Z') }, // expired
  { id: 'sauce-b', recipeId: 'vodka-sauce', amount: 2, unit: 'qt', preppedAt: at('2026-10-01T14:00:00Z'), useBy: at('2026-10-06T14:00:00Z') }, // won't reach Tuesday service
  { id: 'sauce-c', recipeId: 'vodka-sauce', amount: 4, unit: 'qt', preppedAt: at('2026-10-04T14:00:00Z'), useBy: at('2026-10-09T14:00:00Z') }, // good
  { id: 'garlic-1', recipeId: 'chopped-garlic', amount: 0.5, unit: 'cup', preppedAt: at('2026-10-04T14:00:00Z'), useBy: at('2026-10-07T14:00:00Z') }, // good
];

test('batches get a use-by date from shelf life', () => {
  assert.deepEqual(useByFor(book(), 'vodka-sauce', at('2026-10-04T14:00:00Z')), at('2026-10-09T14:00:00Z'));
  const logged = logBatch(book(), { id: 'x', recipeId: 'chopped-garlic', amount: 1, unit: 'cup', preppedAt: at('2026-10-04T14:00:00Z') });
  assert.deepEqual(logged.useBy, at('2026-10-07T14:00:00Z'));
  assert.equal(useByFor(book(), 'rigatoni-vodka', now), undefined); // dishes have no shelf life set
});

test('batch status against the next service', () => {
  assert.equal(batchStatus(batches[0]!, now, tuesday), 'expired');
  assert.equal(batchStatus(batches[1]!, now, tuesday), 'expiring');
  assert.equal(batchStatus(batches[2]!, now, tuesday), 'good');
});

test('nightly count sheet: walk-in order, oldest first, totals in kitchen units', () => {
  const sheet = nightlyCountSheet(book(), [...batches].reverse(), now, tuesday, ['vodka-sauce', 'chopped-garlic']);
  assert.deepEqual(sheet.map((line) => line.name), ['Vodka sauce', 'Chopped garlic']);

  const sauce = sheet[0]!;
  assert.deepEqual(sauce.batches.map((b) => [b.batch.id, b.status]), [['sauce-a', 'expired'], ['sauce-b', 'expiring'], ['sauce-c', 'good']]);
  close(sauce.total, 8); // 1 sixth pan (2 qt) + 2 qt + 4 qt
  close(sauce.usable, 4);
  assert.equal(sauce.needsAttention, true);
  assert.equal(sheet[1]!.needsAttention, false);
});

test('discarding an expired batch logs the waste', () => {
  assert.deepEqual(discardBatch(batches[0]!, now), {
    recipeId: 'vodka-sauce', batchId: 'sauce-a', amount: 1, unit: 'sixth pan', reason: 'expired', loggedAt: now,
  });
});

test('forecast: same weekday, open days only, specials only when available', () => {
  // Tuesday Oct 6. Previous Tuesdays: Sep 29, 22, 15 (open); Sep 8, 1, Aug 25 (closed: no sales).
  const history: DailyItemSales[] = [
    { date: '2026-09-29', catalogId: 'SQ-RIGATONI', quantity: 20 },
    { date: '2026-09-22', catalogId: 'SQ-RIGATONI', quantity: 16 },
    { date: '2026-09-15', catalogId: 'SQ-BURGER', quantity: 10 }, // open, but no rigatoni sold
    { date: '2026-09-30', catalogId: 'SQ-RIGATONI', quantity: 50 }, // a Wednesday: ignored
    { date: '2026-09-29', catalogId: 'SQ-SPECIAL', quantity: 8 },
    { date: '2026-09-15', catalogId: 'SQ-SPECIAL', quantity: 4 },
  ];
  const specials = new Set(['SQ-SPECIAL']);

  const plain = forecastDay(history, '2026-10-06', { specials });
  close(plain.get('SQ-RIGATONI'), 12); // (20 + 16 + 0) / 3 open Tuesdays
  close(plain.get('SQ-BURGER'), 10 / 3);
  assert.equal(plain.has('SQ-SPECIAL'), false); // not on tomorrow's menu

  const withSpecial = forecastDay(history, '2026-10-06', { specials, specialsAvailable: specials, adjustment: 1.25 });
  close(withSpecial.get('SQ-SPECIAL'), 6 * 1.25); // averaged over the 2 days it ran, then reservations bump
  close(withSpecial.get('SQ-RIGATONI'), 15);
});

test('dish forecast becomes demand for prepped items', () => {
  const demand = prepDemand(book(), links, new Map([['SQ-RIGATONI', 16]]));
  close(demand.get('vodka-sauce'), 4); // 16 cups = 4 qt
  assert.equal(demand.has('chopped-garlic'), false); // only needed through the sauce
});

test('prep list: whole batches, usable on hand, sub-preps first', () => {
  const demand = new Map([['vodka-sauce', 4]]);
  const list = prepList(book(), demand, batches, tuesday.end);
  assert.deepEqual(list.map((line) => line.name), ['Chopped garlic', 'Vodka sauce']);

  const [garlic, sauce] = list;
  // Sauce: 4 qt + 10% = 4.4 qt needed; only batch C (4 qt) lasts through Tuesday → 0.4 short → 1 batch.
  close(sauce!.forDishes, 4.4);
  close(sauce!.onHand, 4);
  assert.equal(sauce!.batches, 1);
  close(sauce!.toMake, 4);
  // That batch needs 0.25 cup chopped garlic; 0.5 cup on hand is still good → nothing to make.
  close(garlic!.forOtherPrep, 0.25);
  close(garlic!.onHand, 0.5);
  close(garlic!.toMake, 0);
});

test('prep list with nothing on hand cascades into sub-prep', () => {
  const list = prepList(book(), new Map([['vodka-sauce', 4]]), [], tuesday.end);
  const sauce = list.find((line) => line.recipeId === 'vodka-sauce')!;
  const garlic = list.find((line) => line.recipeId === 'chopped-garlic')!;
  assert.equal(sauce.batches, 2); // 4.4 qt → two 4 qt batches
  close(garlic.forOtherPrep, 0.5); // 2 batches × 0.25 cup
  assert.equal(garlic.batches, 1);
  close(garlic.toMake, 1);
});

test('skipped count: estimates get a bigger buffer', () => {
  const exact = prepList(book(), new Map([['vodka-sauce', 4]]), [], tuesday.end, { wholeBatches: false });
  const estimated = prepList(book(), new Map([['vodka-sauce', 4]]), [], tuesday.end, { wholeBatches: false, onHandIsEstimate: true });
  close(exact.find((l) => l.recipeId === 'vodka-sauce')!.toMake, 4.4);
  const sauce = estimated.find((l) => l.recipeId === 'vodka-sauce')!;
  close(sauce.toMake, 4.8);
  assert.equal(sauce.estimated, true);
});

test('surplus specials: what will expire unused at the expected pace', () => {
  // Tue–Fri services, 0.5 qt of sauce a day.
  const day = (end: string) => ({ serviceEnd: at(end), demand: new Map([['vodka-sauce', 0.5]]) });
  const days = [day('2026-10-07T01:00:00Z'), day('2026-10-08T01:00:00Z'), day('2026-10-09T01:00:00Z'), day('2026-10-10T01:00:00Z')];
  const suggestions = surplusPrep(book(), batches, days, now);

  // Batch A already expired: left to the discard flow.
  // Batch B expires before Tuesday's service ends: all 2 qt go unused.
  // Garlic: no demand in these days (no sauce being made), so the whole 0.5 cup expires Oct 7.
  // Batch C covers Tue, Wed, Thu (1.5 qt), expires before Friday's service: 2.5 qt left.
  assert.deepEqual(suggestions.map((s) => [s.batchId, s.surplus, s.share]), [['sauce-b', 2, 1], ['garlic-1', 0.5, 1], ['sauce-c', 2.5, 0.625]]);
  close(suggestions[2]!.value, 21.2988235475 * 2.5 / 4);

  // A batch that sells through isn't flagged.
  const busy = days.map((d) => ({ ...d, demand: new Map([['vodka-sauce', 2], ['chopped-garlic', 0.5]]) }));
  assert.deepEqual(surplusPrep(book(), batches, busy, now).map((s) => s.batchId), ['sauce-b']);
});

test('daily prep check: gaps beyond 5%, largest dollar value first', () => {
  const lines = prepCheck(book(), {
    previous: new Map([['vodka-sauce', 6], ['chopped-garlic', 1]]),
    prepped: new Map([['vodka-sauce', 4]]),
    used: new Map([['vodka-sauce', 3], ['chopped-garlic', 0.25]]),
    wasted: new Map([['vodka-sauce', 2]]),
    counted: new Map([['vodka-sauce', 3.5], ['chopped-garlic', 0.74]]), // garlic within 5% of 0.75
  });
  assert.equal(lines.length, 1);
  const sauce = lines[0]!;
  close(sauce.expected, 5); // 6 + 4 − 3 − 2
  close(sauce.difference, -1.5);
  close(sauce.value, -21.2988235475 * 1.5 / 4); // about $7.99 of sauce unaccounted for
});
