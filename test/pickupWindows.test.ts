import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOrder, fittingWindows, pizzaLimitProblem, windowStarts, windowsFor, type PlanCell } from '../src/core/pickupWindows.ts';

// Saturdays (weekday 6): 4 pizzas a window, 6 in the 6 pm rush windows. Wednesdays: 3 all evening.
const plan: PlanCell[] = [
  ...windowStarts().map((starts) => ({ weekday: 6, starts, maxPizzas: starts >= '18:00' && starts < '19:00' ? 6 : 4 })),
  ...windowStarts().map((starts) => ({ weekday: 3, starts, maxPizzas: 3 })),
];
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-11';

test('twelve 20-minute windows from 5 to 9 pm', () => {
  assert.equal(windowStarts().length, 12);
  assert.equal(windowStarts()[0], '17:00');
  assert.equal(windowStarts().at(-1), '20:40');
  const w = windowsFor(SATURDAY, plan);
  assert.equal(w.at(-1)!.ends, '21:00');
  assert.deepEqual(w.map((x) => x.max), [4, 4, 4, 6, 6, 6, 4, 4, 4, 4, 4, 4]);
});

test('a weekday without a plan takes nothing online', () => {
  assert.ok(windowsFor(SUNDAY, plan).every((w) => w.max === 0));
  assert.deepEqual(fitOrder(windowsFor(SUNDAY, plan), 1, '12:00'), { kind: 'closed' });
});

test("a date's own limits win over the plan, window by window", () => {
  const w = windowsFor(SATURDAY, plan, [{ starts: '17:00', maxPizzas: 0 }, { starts: '18:00', maxPizzas: 8 }]);
  assert.equal(w[0]!.max, 0);
  assert.equal(w[0]!.changed, true);
  assert.equal(w[3]!.max, 8);
  assert.equal(w[1]!.max, 4);
  assert.equal(w[1]!.changed, undefined);
});

test('an order goes in the first window with room for all its pizzas, never split', () => {
  // 5:00 has 1 pizza left, 5:20 has 3, 5:40 is empty.
  const w = windowsFor(SATURDAY, plan, [], { '17:00': 3, '17:20': 1 });
  const small = fitOrder(w, 1, '12:00');
  assert.equal(small.kind === 'fits' && small.earliest.starts, '17:00');
  const three = fitOrder(w, 3, '12:00');
  assert.equal(three.kind === 'fits' && three.earliest.starts, '17:20');
  // Four pizzas wait for 5:40; the earlier windows stay open for smaller orders.
  const four = fitOrder(w, 4, '12:00');
  assert.equal(four.kind === 'fits' && four.earliest.starts, '17:40');
  assert.deepEqual(fittingWindows(w, 1, '12:00').slice(0, 2).map((x) => x.starts), ['17:00', '17:20']);
});

test('salads and gelato alone fit any open window', () => {
  const w = windowsFor(SATURDAY, plan, [], { '17:00': 4 });
  const fit = fitOrder(w, 0, '12:00');
  assert.equal(fit.kind === 'fits' && fit.earliest.starts, '17:00');
});

test('more pizzas than any window takes means a phone call', () => {
  assert.deepEqual(fitOrder(windowsFor(SATURDAY, plan), 7, '12:00'), { kind: 'tooBig', mostAnyWindowTakes: 6 });
  // The rush windows take 6, so 6 is fine.
  const six = fitOrder(windowsFor(SATURDAY, plan), 6, '12:00');
  assert.equal(six.kind === 'fits' && six.earliest.starts, '18:00');
});

test('a window stops taking orders 20 minutes before it starts', () => {
  const w = windowsFor(SATURDAY, plan);
  const at440 = fitOrder(w, 1, '16:40');
  assert.equal(at440.kind === 'fits' && at440.earliest.starts, '17:00');
  const at441 = fitOrder(w, 1, '16:41');
  assert.equal(at441.kind === 'fits' && at441.earliest.starts, '17:20');
  assert.deepEqual(fitOrder(w, 1, '20:30'), { kind: 'full' });
});

test('full tonight when every window left is taken', () => {
  const taken = Object.fromEntries(windowStarts().map((s) => [s, 6]));
  const w = windowsFor(SATURDAY, plan, [], taken);
  assert.deepEqual(fitOrder(w, 1, '12:00'), { kind: 'full' });
  assert.ok(w.every((x) => x.left === 0)); // limits lowered below what's taken never go negative
});

test('closing the rest of tonight', () => {
  const closeFrom = '19:00';
  const w = windowsFor(SATURDAY, plan, windowStarts().filter((s) => s >= closeFrom).map((starts) => ({ starts, maxPizzas: 0 })));
  const fit = fitOrder(w, 1, '18:30');
  assert.deepEqual(fit, { kind: 'full' });
});

test('pizza limits are whole numbers from 0 to 99', () => {
  assert.equal(pizzaLimitProblem(0), undefined);
  assert.equal(pizzaLimitProblem(12), undefined);
  for (const bad of [-1, 2.5, 100, '4', null]) assert.ok(pizzaLimitProblem(bad));
});
