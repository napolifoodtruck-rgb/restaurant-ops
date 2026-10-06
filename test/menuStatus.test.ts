import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFromSales, menuChecks, onMenu, quietThreshold } from '../src/core/menu.ts';

const day = (n: number) => new Date(Date.UTC(2026, 6, 1 + n)).toISOString().slice(0, 10); // n days after Jul 1
const today = day(100);
const span = (id: string, first: number, last: number) => ({ catalogId: id, name: id, first: day(first), last: day(last), quantity: 10, days: 5 });
const lookup = (catalogId: string) => ({ recipeId: catalogId });
const name = (id: string) => id;

test('how long a dish can go quiet depends on how often it sells', () => {
  assert.equal(quietThreshold(Array.from({ length: 60 }, (_, i) => day(i))), 7); // every night: a week
  assert.equal(quietThreshold([0, 9, 17, 26, 35, 44].map(day)), 18); // about weekly: two and a half weeks
  assert.equal(quietThreshold([day(1)]), 21); // too little to tell
  assert.equal(quietThreshold([0, 40, 80].map(day)), 42); // capped at six weeks
});

test('a quiet dish stays on and is asked about; it comes off only on a yes, or when a planned dish replaces it', () => {
  const sellingDays = new Map([['nightly', Array.from({ length: 80 }, (_, i) => day(i))], ['weekly', [70, 78, 85, 92].map(day)], ['gone', [10, 11, 12, 13].map(day)], ['said', [10, 20, 30].map(day)], ['replaced', [50, 60, 70].map(day)]]);
  const spans = [span('nightly', 0, 79), span('weekly', 70, 92), span('gone', 10, 13), span('said', 10, 30), span('replaced', 50, 70)];
  const entries = entriesFromSales(spans, lookup, name, 'dinner', today, {
    sellingDays,
    answers: [{ recipeId: 'said', status: 'off', date: day(31) }],
    replacedFrom: new Map([['replaced', day(80)]]),
  });
  const on = onMenu(entries, today).map((e) => [e.recipeId, e.quietSince ?? null]);
  assert.deepEqual(on, [['nightly', day(79)], ['weekly', null], ['gone', day(13)]]); // nightly: 21 days quiet (asks); weekly: 8 days (fine)
  assert.deepEqual(entries.filter((e) => e.endsOn).map((e) => [e.recipeId, e.endsOn]), [['said', day(31)], ['replaced', day(70)]]);
  const checks = menuChecks({ entries, sales: [], lookup, recipeName: name, today, statusAware: true });
  assert.deepEqual(checks.filter((c) => c.kind === 'notSelling').map((c) => c.recipeId), ['nightly', 'gone']);
});

test('still on quiets the question; a dish that sells again after coming off is back on; one put back on stays on', () => {
  const sellingDays = new Map([['a', [0, 1, 2, 3].map(day)], ['b', [0, 1, 2, 95].map(day)]]);
  const entries = entriesFromSales([span('a', 0, 3), span('b', 0, 95)], lookup, name, 'dinner', today, {
    sellingDays,
    answers: [{ recipeId: 'a', status: 'stillOn', date: day(95) }, { recipeId: 'b', status: 'off', date: day(10) }, { recipeId: 'c', status: 'on', date: day(99) }],
  });
  assert.deepEqual(onMenu(entries, today).map((e) => [e.recipeId, e.quietSince ?? null]), [['a', null], ['b', null], ['c', null]]);
});
