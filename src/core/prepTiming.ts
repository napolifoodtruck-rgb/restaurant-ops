/**
 * How long prep takes, from the taps cooks already make on the station list.
 *
 * A list's time runs from "Start prep" (or the first Start tap on an item) to the last thing
 * checked off. An item's time is exact when its Start was tapped; otherwise it's the time since
 * the same cook's previous check-off on that list (the list's start for their first), which is
 * how long it took as long as they went straight from one to the next. Gaps longer than a
 * normal stretch of work (a break, a delivery) aren't counted.
 *
 * Cooks are compared with the usual time for the same items, in the same amounts: whoever
 * makes the dough would look slow next to whoever fills garnish pans otherwise.
 */

export interface Mark {
  /** A prep item; cleaning checks have none but still mark when someone moved on. */
  itemId?: string;
  name?: string;
  unit?: string;
  /** How much was made, when known. */
  amount?: number;
  startedAt?: number;
  doneAt: number;
  by?: string;
  byName?: string;
}

export interface WorkedList {
  listId: string;
  stationId: string;
  date: string;
  /** The "Start prep" tap. */
  startedAt?: number;
  marks: Mark[];
}

export interface ItemTime {
  itemId: string;
  name: string;
  unit?: string;
  amount?: number;
  minutes: number;
  exact: boolean;
  by?: string;
  byName?: string;
  stationId: string;
  date: string;
}

const MIN = 60_000;
/** Longer than this between check-offs is a break, not one item. */
export const MAX_GAP_MINUTES = 90;
/** An item started and finished further apart than this was left open. */
export const MAX_EXACT_MINUTES = 240;

/** When a list began and ended, and how long that was; nothing until something's checked off. */
export function listSpan(list: WorkedList): { start: number; end: number; minutes: number; measured: boolean } | undefined {
  const done = list.marks.map((m) => m.doneAt);
  if (!done.length) return undefined;
  const starts = [list.startedAt, ...list.marks.map((m) => m.startedAt)].filter((x): x is number => x !== undefined);
  // With no start tapped, the clock starts at the first check-off (so it runs a little short).
  const start = Math.min(...starts, ...done);
  const end = Math.max(...done);
  return { start, end, minutes: Math.round((end - start) / MIN), measured: starts.length > 0 };
}

/** Each item's time on each list: exact from its Start tap, else the time since the same cook's last check-off. */
export function itemTimes(lists: WorkedList[]): ItemTime[] {
  const out: ItemTime[] = [];
  for (const list of lists) {
    const span = listSpan(list);
    if (!span) continue;
    const byCook = new Map<string, Mark[]>();
    for (const m of list.marks) {
      const k = m.by ?? '';
      byCook.set(k, [...(byCook.get(k) ?? []), m]);
    }
    for (const marks of byCook.values()) {
      marks.sort((a, b) => a.doneAt - b.doneAt);
      // A cook's first item counts from the list's start only when someone actually tapped a start.
      let prev: number | undefined = span.measured ? span.start : undefined;
      for (const m of marks) {
        let minutes: number | undefined, exact = false;
        if (m.startedAt !== undefined && m.doneAt > m.startedAt) {
          minutes = (m.doneAt - m.startedAt) / MIN; exact = true;
          if (minutes > MAX_EXACT_MINUTES) minutes = undefined;
        } else if (prev !== undefined && m.doneAt > prev) {
          minutes = (m.doneAt - prev) / MIN;
          if (minutes > MAX_GAP_MINUTES) minutes = undefined;
        }
        if (m.itemId && minutes !== undefined && minutes >= 0.5) {
          out.push({ itemId: m.itemId, name: m.name ?? '', ...(m.unit ? { unit: m.unit } : {}), ...(m.amount !== undefined ? { amount: m.amount } : {}),
            minutes: Math.round(minutes * 10) / 10, exact, ...(m.by ? { by: m.by } : {}), ...(m.byName ? { byName: m.byName } : {}), stationId: list.stationId, date: list.date });
        }
        prev = m.doneAt;
      }
    }
  }
  return out;
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface ItemUsual {
  itemId: string;
  name: string;
  unit?: string;
  times: number;
  /** The usual time, whatever the amount. */
  minutes: number;
  /** The usual time for one unit, when amounts are known for enough of them. */
  perUnit?: number;
  /** The usual amount made. */
  amount?: number;
}

/** The usual time for each item; only items timed at least `min` times. */
export function itemUsuals(times: ItemTime[], min = 3): Map<string, ItemUsual> {
  const by = new Map<string, ItemTime[]>();
  for (const t of times) by.set(t.itemId, [...(by.get(t.itemId) ?? []), t]);
  const out = new Map<string, ItemUsual>();
  for (const [itemId, ts] of by) {
    if (ts.length < min) continue;
    const sized = ts.filter((t) => t.amount !== undefined && t.amount > 0);
    out.set(itemId, {
      itemId, name: ts[ts.length - 1]!.name, ...(ts[0]!.unit ? { unit: ts[0]!.unit } : {}), times: ts.length,
      minutes: median(ts.map((t) => t.minutes)),
      ...(sized.length >= min ? { perUnit: median(sized.map((t) => t.minutes / t.amount!)), amount: median(sized.map((t) => t.amount!)) } : {}),
    });
  }
  return out;
}

/** What a time would usually be for this item in this amount. */
export function expected(t: Pick<ItemTime, 'amount'>, u: ItemUsual): number {
  // Bigger batches take longer, but not in proportion (setup and cleanup are the same): halfway.
  if (u.perUnit !== undefined && u.amount && t.amount && t.amount > 0) return u.minutes * (0.5 + 0.5 * (t.amount / u.amount));
  return u.minutes;
}

export interface CookPace {
  by: string;
  name: string;
  /** Timed items compared. */
  items: number;
  /** Their usual time as a share of the usual for the same items: 0.9 is 10% quicker. */
  ratio: number;
  /** Hours of prep timed. */
  hours: number;
}

/** Each cook against the usual for the same items; only cooks with at least `min` comparable items. */
export function cookPace(times: ItemTime[], usuals: Map<string, ItemUsual>, min = 8): CookPace[] {
  const by = new Map<string, { name: string; ratios: number[]; minutes: number }>();
  for (const t of times) {
    const u = usuals.get(t.itemId);
    if (!t.by || !u) continue;
    const e = expected(t, u);
    if (!(e > 0)) continue;
    const p = by.get(t.by) ?? { name: t.byName ?? 'Someone', ratios: [], minutes: 0 };
    p.ratios.push(t.minutes / e);
    p.minutes += t.minutes;
    by.set(t.by, p);
  }
  return [...by].filter(([, p]) => p.ratios.length >= min)
    .map(([id, p]) => ({ by: id, name: p.name, items: p.ratios.length, ratio: Math.round(median(p.ratios) * 100) / 100, hours: Math.round((p.minutes / 60) * 10) / 10 }))
    .sort((a, b) => a.ratio - b.ratio);
}

export interface LeftToDo {
  itemId: string;
  amount?: number;
  /** Already under way. */
  startedAt?: number;
}

/**
 * Minutes of work left on a list in progress: each item still to make at its usual time for
 * that amount (less what's already gone on one that's been started), a usual item time for
 * anything never timed, and a few minutes per cleaning task.
 */
export function minutesLeft(left: LeftToDo[], cleaningLeft: number, usuals: Map<string, ItemUsual>, now: number, opts: { fallback?: number; perCleaning?: number } = {}): number {
  const fallback = opts.fallback ?? 8, perCleaning = opts.perCleaning ?? 4;
  let total = 0;
  for (const l of left) {
    const u = usuals.get(l.itemId);
    const usual = u ? expected(l, u) : fallback;
    const gone = l.startedAt !== undefined ? Math.max(0, (now - l.startedAt) / MIN) : 0;
    // A started item that's running long still has a minute or two left.
    total += Math.max(usual - gone, l.startedAt !== undefined ? 1 : usual);
  }
  return Math.round(total + cleaningLeft * perCleaning);
}

/** A usual item time for a station: the middle of its timed items. */
export function stationItemUsual(usuals: Map<string, ItemUsual>, itemIds: string[]): number | undefined {
  const xs = itemIds.map((id) => usuals.get(id)?.minutes).filter((x): x is number => x !== undefined);
  return xs.length ? median(xs) : undefined;
}
