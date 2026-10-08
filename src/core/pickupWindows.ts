/**
 * Pickup windows for online orders. The evening is cut into 15-minute windows (5:00 to 9:00 pm),
 * and each window takes at most so many pizzas: the oven is the limit, so salads, gelato and drinks
 * don't count. A weekly plan gives each weekday's limits; a date can be changed on its own (a
 * holiday, an event, a short-staffed night, or "close the rest of tonight" when dine-in is slammed).
 *
 * An order goes in the first window that can take all of its pizzas, never split: a big order
 * waits for a window with room, and the earlier window stays open for smaller orders. Orders are
 * same day only, and a window closes to new orders a little before it starts.
 */

import { weekdayOf } from './forecast.ts';

export const WINDOW_MINUTES = 15;
export const FIRST_WINDOW = '17:00';
export const LAST_WINDOW_ENDS = '21:00';
/** How long before a window starts it stops taking orders: the pizzas need making. */
export const LEAD_MINUTES = 20;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const toHhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Start times of the evening's windows: 17:00, 17:15, … 20:45. */
export function windowStarts(): string[] {
  const out: string[] = [];
  for (let t = toMinutes(FIRST_WINDOW); t + WINDOW_MINUTES <= toMinutes(LAST_WINDOW_ENDS); t += WINDOW_MINUTES) out.push(toHhmm(t));
  return out;
}

export const isWindowStart = (hhmm: string): boolean => windowStarts().includes(hhmm);

/** One cell of the weekly plan: weekday 0 = Sunday. */
export interface PlanCell {
  weekday: number;
  starts: string;
  maxPizzas: number;
}

/** A change for one date, for one window. */
export interface DayCell {
  starts: string;
  maxPizzas: number;
}

export interface PickupWindow {
  starts: string;
  ends: string;
  /** Pizzas this window takes in all. 0 = closed. */
  max: number;
  /** Pizzas already in orders (and held at checkout). */
  taken: number;
  /** Pizzas it can still take (never below 0, even if limits were lowered after orders came in). */
  left: number;
  /** The date's own limit, not the weekly plan's. */
  changed?: true;
}

/** The windows of one date: the weekly plan for its weekday, with the date's own changes on top. */
export function windowsFor(day: string, plan: readonly PlanCell[], changes: readonly DayCell[] = [], taken: Readonly<Record<string, number>> = {}): PickupWindow[] {
  const weekday = weekdayOf(day);
  const planned = new Map(plan.filter((c) => c.weekday === weekday).map((c) => [c.starts, c.maxPizzas]));
  const changed = new Map(changes.map((c) => [c.starts, c.maxPizzas]));
  return windowStarts().map((starts) => {
    const max = changed.get(starts) ?? planned.get(starts) ?? 0;
    const t = taken[starts] ?? 0;
    return { starts, ends: toHhmm(toMinutes(starts) + WINDOW_MINUTES), max, taken: t, left: Math.max(0, max - t), ...(changed.has(starts) ? { changed: true as const } : {}) };
  });
}

/** Still taking orders at `now` (HH:MM, the restaurant's time): open, and not too close to its start. */
export function stillOpen(w: PickupWindow, now: string, leadMinutes = LEAD_MINUTES): boolean {
  return w.max > 0 && toMinutes(w.starts) - leadMinutes >= toMinutes(now);
}

/**
 * The windows an order can go in: still open, with room for all of its pizzas. An order without
 * pizzas fits any open window.
 */
export function fittingWindows(windows: readonly PickupWindow[], pizzas: number, now: string, leadMinutes = LEAD_MINUTES): PickupWindow[] {
  return windows.filter((w) => stillOpen(w, now, leadMinutes) && w.left >= pizzas);
}

export type Fit =
  | { kind: 'fits'; earliest: PickupWindow; windows: PickupWindow[] }
  /** More pizzas than any window takes in all: only a phone call can sort it out. */
  | { kind: 'tooBig'; mostAnyWindowTakes: number }
  /** Windows are full or past for tonight. */
  | { kind: 'full' }
  /** Not taking online orders tonight at all. */
  | { kind: 'closed' };

/** Where an order of `pizzas` can go tonight, and why not when it can't. */
export function fitOrder(windows: readonly PickupWindow[], pizzas: number, now: string, leadMinutes = LEAD_MINUTES): Fit {
  if (!windows.some((w) => w.max > 0)) return { kind: 'closed' };
  const most = Math.max(...windows.map((w) => w.max));
  if (pizzas > most) return { kind: 'tooBig', mostAnyWindowTakes: most };
  const fits = fittingWindows(windows, pizzas, now, leadMinutes);
  return fits.length ? { kind: 'fits', earliest: fits[0]!, windows: fits } : { kind: 'full' };
}

/** A limit someone typed: a whole number of pizzas, 0 to 99. */
export function pizzaLimitProblem(v: unknown): string | undefined {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 99 ? undefined : 'A window takes 0 to 99 pizzas.';
}
