import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doughBoard, isTableTicket, tallyDough, takeoutFor, type DoughOf, type LiveOrder } from '../src/core/dough.ts';
import { midnightOf } from '../src/server/dough.ts';

// Pizzas and breadsticks use a ball; gelato doesn't; a gluten-free crust uses a crust, not a ball.
const doughOf: DoughOf = (l) => {
  if (/gelato|coke/i.test(l.name)) return { balls: 0, glutenFree: 0 };
  if (l.modifierKeys.some((k) => /gluten/.test(k))) return { balls: 0, glutenFree: 1 };
  return { balls: 1, glutenFree: 0 };
};
const line = (name: string, quantity = 1, modifierKeys: string[] = []) => ({ name, quantity, modifierKeys });
const order = (o: Partial<LiveOrder> & { lines: LiveOrder['lines'] }): LiveOrder => ({ id: Math.random().toString(36), state: 'OPEN', ...o });

test('table tickets are "T" and a number; anything else is to go', () => {
  for (const t of ['T9 - 3', 'T8 - S2', 't12', ' T 4']) assert.ok(isTableTicket(t), t);
  for (const t of [undefined, '', 'Pat to go', 'Tom', 'Takeout']) assert.ok(!isTableTicket(t), String(t));
});

test('every ball on today’s tickets, open or paid; dine-in and takeout apart', () => {
  const t = tallyDough([
    order({ ticketName: 'T9 - 3', state: 'COMPLETED', lines: [line('Margherita', 2), line('Coke')] }),
    order({ ticketName: 'T2', lines: [line('Breadsticks')] }),
    order({ source: 'Square Online', lines: [line('Pepperoni', 3)] }),
    order({ source: 'Online ordering', state: 'COMPLETED', lines: [line('Funghi')] }),
    order({ ticketName: 'Pat to go', lines: [line('Spinaci'), line('4oz Gelato')] }),
    order({ lines: [line('6oz Gelato')] }),
  ], doughOf);
  assert.deepEqual(t, { used: 8, dineIn: 3, takeout: { online: 4, toGo: 1, total: 5 }, glutenFree: 0, orders: 6, guessed: {}, notCounted: {} });
});

test('cancelled orders and unfinished online carts don’t count', () => {
  const t = tallyDough([
    order({ ticketName: 'T1', state: 'CANCELED', lines: [line('Margherita', 4)] }),
    order({ source: 'Square Online', state: 'DRAFT', lines: [line('Margherita', 2)] }),
    order({ ticketName: 'T1', lines: [line('Margherita')] }),
  ], doughOf);
  assert.equal(t.used, 1);
  assert.equal(t.orders, 1);
});

test('a split check’s thirds of a pizza add back up to whole ones', () => {
  const third = 0.33333;
  const t = tallyDough([1, 2, 3].map((n) => order({ ticketName: `T8 - S${n}`, lines: [line('Margherita', third), line('Pepperoni', third)] })), doughOf);
  assert.equal(t.used, 2);
  assert.equal(t.dineIn, 2);
});

test('gluten-free is its own count: no dough ball, and not against takeout', () => {
  const t = tallyDough([
    order({ ticketName: 'T3', lines: [line('Margherita', 1, ['crust|gluten free'])] }),
    order({ ticketName: 'Sam to go', lines: [line('Margherita', 2, ['crust|gluten free']), line('Margherita')] }),
  ], doughOf);
  assert.equal(t.glutenFree, 3);
  assert.equal(t.used, 1);
  assert.equal(t.takeout.total, 1);
});

test('what the boards show: left of each count, and takeout out at zero', () => {
  const tally = { used: 40, dineIn: 28, takeout: { online: 8, toGo: 4, total: 12 }, glutenFree: 3, orders: 30, guessed: {}, notCounted: {} };
  const b = doughBoard({ start: 120, glutenFreeStart: 10, takeoutCap: 30, tally });
  assert.deepEqual(b.dough, { used: 40, dineIn: 28, start: 120, left: 80 });
  assert.deepEqual(b.glutenFree, { used: 3, start: 10, left: 7 });
  assert.equal(b.takeout.left, 18);
  assert.equal(b.takeoutOut, false);
  // Sold past the number (two orders at once): never below zero, and out.
  const over = doughBoard({ takeoutCap: 10, tally });
  assert.equal(over.takeout.left, 0);
  assert.ok(over.takeoutOut);
  assert.equal(over.dough.left, undefined, 'no start entered yet: no dough left');
  // No takeout number tonight: never out.
  assert.equal(doughBoard({ tally }).takeoutOut, false);
});

test('items with no recipe: listed, counted by category or not at all', () => {
  const of: DoughOf = (l) => (l.name === 'Spinaci' ? { balls: 1, glutenFree: 0, guessed: true } : l.name === 'Breadsticks' ? { balls: 0, glutenFree: 0, unknown: true } : doughOf(l));
  const t = tallyDough([order({ ticketName: 'T1', lines: [line('Spinaci', 0.33333), line('Breadsticks', 2)] }), order({ ticketName: 'T1 - S2', lines: [line('Spinaci', 0.66667)] })], of);
  assert.equal(t.used, 1);
  assert.deepEqual(t.guessed, { Spinaci: 1 });
  assert.deepEqual(t.notCounted, { Breadsticks: 2 });
});

test('the takeout number: the night’s own, else the weekday’s', () => {
  const week = [null, null, null, 30, 30, 40, 45];   // Sunday first
  assert.equal(takeoutFor('2026-10-09', week), 40);  // a Friday
  assert.equal(takeoutFor('2026-10-09', week, 52), 52);
  assert.equal(takeoutFor('2026-10-09', week, 0), 0, 'zero tonight is a number, not none');
  assert.equal(takeoutFor('2026-10-05', week), undefined);  // a Monday
});

test('the restaurant’s midnight, as Square wants it', () => {
  assert.equal(midnightOf('2026-10-09', 'America/New_York'), '2026-10-09T04:00:00.000Z');
  assert.equal(midnightOf('2026-12-09', 'America/New_York'), '2026-12-09T05:00:00.000Z');
});
