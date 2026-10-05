import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderReport, speedReport, stationProgress, timedTasks, typicalMinutesPerUnit, visibleTasks, type PrepTask, type TimedTask } from '../src/core/stationPrep.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const at = (hhmm: string) => `2026-10-05T${hhmm}:00.000Z`;
let n = 0;
const task = (stationId: string, recipeId: string, amount: number, suggestedOrder: number, extra: Partial<PrepTask> = {}): PrepTask => ({
  id: `t${++n}`,
  stationId,
  recipeId,
  amount,
  suggestedOrder,
  status: 'open',
  ...extra,
});
const done = (by: string, completedAt: string, extra: Partial<PrepTask> = {}): Partial<PrepTask> => ({ status: 'done', completedBy: by, completedAt, ...extra });

test('line cooks see their station; sous chefs and up see every station', () => {
  const tasks = [task('saute', 'stock', 1, 1), task('pizza', 'dough', 2, 1), task('pastry', 'gelato', 1, 1)];
  assert.deepEqual(visibleTasks(tasks, { staffId: 'sam', role: 'line', stations: ['saute'] }).map((t) => t.stationId), ['saute']);
  assert.deepEqual(visibleTasks(tasks, { staffId: 'ana', role: 'lead', stations: ['pizza', 'pastry'] }).map((t) => t.stationId), ['pizza', 'pastry']);
  assert.equal(visibleTasks(tasks, { staffId: 'chef', role: 'chef', stations: [] }).length, 3);
  assert.equal(visibleTasks(tasks, { staffId: 'sous', role: 'sous', stations: ['saute'] }).length, 3);
});

test('durations come from start taps or the gap since the last check-off; bunched check-offs are not speed', () => {
  const tasks = [
    task('saute', 'stock', 1, 1, done('sam', at('13:00'))), // first of the day: unknown
    task('saute', 'pomodoro', 2, 2, done('sam', at('13:50'))), // 50 min gap
    task('saute', 'garlic', 1, 3, done('sam', at('14:30'), { startedAt: at('14:10') })), // 20 min from a start tap
    task('saute', 'onions', 1, 4, done('sam', at('15:55'))), // 85 min gap
    task('saute', 'herbs', 1, 5, done('sam', at('15:56'))), // 1 min later: batch check-off
    task('saute', 'aioli', 1, 6, done('sam', at('19:30'))), // 3.5 hours: not one task
  ];
  const { timed, batchCheckOffs } = timedTasks(tasks);
  assert.deepEqual(timed.map((t) => [t.task.recipeId, t.minutes, t.source]), [
    ['pomodoro', 50, 'gap'],
    ['garlic', 20, 'started'],
    ['onions', 85, 'gap'],
  ]);
  assert.deepEqual(batchCheckOffs.map((t) => t.recipeId), ['herbs']);
  close(typicalMinutesPerUnit(timed).get('pomodoro'), 25); // 50 minutes for 2 batches
});

test('each station shows what is left and when it will finish against service', () => {
  const typical = new Map([['pomodoro', 25], ['dough', 15], ['stock', 60]]);
  const tasks = [
    task('saute', 'pomodoro', 2, 1, done('sam', at('14:00'))),
    task('saute', 'stock', 1, 2, { status: 'started', startedAt: at('14:30'), neededBy: at('17:00') }),
    task('saute', 'pomodoro', 4, 3, { neededBy: at('17:00') }),
    task('saute', 'mystery', 1, 4), // no history yet
    task('pizza', 'dough', 4, 1, { neededBy: at('16:00') }),
  ];
  const now = at('15:00');
  const progress = Object.fromEntries(stationProgress(tasks, now, typical, new Map([['pizza', 2]])).map((p) => [p.stationId, p]));
  const saute = progress['saute']!;
  assert.equal(saute.done, 1);
  assert.equal(saute.total, 4);
  // Stock started 30 minutes ago (30 of 60 left) + 4 batches of pomodoro at 25 minutes.
  close(saute.minutesLeft, 30 + 100);
  assert.equal(saute.untimed, 1);
  assert.equal(saute.projectedFinish, at('17:10'));
  assert.equal(saute.behind, true); // service needs it by 5:00
  // Pizza: 60 minutes of dough shared by two cooks.
  close(progress['pizza']!.minutesLeft, 30);
  assert.equal(progress['pizza']!.behind, false);
});

test('suggested vs actual order shows quick tasks done ahead of urgent ones', () => {
  const tasks = [
    task('saute', 'stock', 1, 1, done('sam', at('15:30'))), // most urgent, done last
    task('saute', 'herbs', 1, 2, done('sam', at('13:10'))),
    task('saute', 'garlic', 1, 3, done('sam', at('13:40'))),
    task('pizza', 'dough', 1, 1, done('ana', at('13:00'))),
    task('pizza', 'sauce', 1, 2, done('ana', at('13:30'))),
  ];
  const report = Object.fromEntries(orderReport(tasks).map((r) => [r.staffId, r]));
  close(report['sam']!.inOrder, 1 - 2 / 3);
  assert.deepEqual(report['sam']!.jumpedAhead.map((j) => [j.task.recipeId, j.ahead.map((a) => a.recipeId)]), [
    ['herbs', ['stock']],
    ['garlic', ['stock']],
  ]);
  assert.equal(report['ana']!.inOrder, 1);
});

test('speed is compared on the same task, once there is enough to compare', () => {
  const timed = (by: string, minutes: number, amount = 1): TimedTask => ({ task: task('saute', 'pomodoro', amount, 1, done(by, at('14:00'))), minutes, source: 'started' });
  const history = [timed('sam', 30), timed('sam', 32, 1), timed('sam', 60, 2), timed('ana', 20), timed('ana', 22), timed('ana', 40, 2), timed('lee', 25)];
  const lines = speedReport(history);
  // Per batch: Sam 30, 32, 30; Ana 20, 22, 20; Lee 25. Kitchen median 25 minutes.
  // Sam runs 20% slower, Ana 20% faster. Lee has one task: not enough to say.
  assert.deepEqual(lines.map((l) => [l.staffId, l.tasks, +l.relative.toFixed(3)]), [
    ['sam', 3, 1.2],
    ['ana', 3, 0.8],
  ]);
});
