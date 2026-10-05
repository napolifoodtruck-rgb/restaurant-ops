/**
 * Station prep lists, the way kitchens already run them: each item has a unit and a par for
 * the busiest day; at night someone counts what's left; tomorrow's list is par minus count.
 *
 * What the app adds: the par is scaled to the day's expected business (a Tuesday that runs
 * at 58% of a Friday doesn't need Friday's sauce), with the reason shown, and a chef approves
 * before anyone preps from it.
 */

export interface StationItem {
  id: string;
  name: string;
  unit?: string;
  kind: 'count' | 'task' | 'batch';
  /** Par on the busiest day. */
  par?: number;
  /** Only on these weekdays (0 = Sunday). */
  weekdays?: number[];
  /** On the list from / until these days (a new dish's preps, a retired dish's). */
  activeFrom?: string;
  activeUntil?: string;
}

export interface DaySales {
  date: string;
  netSales: number;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * How busy a weekday runs compared with the busiest one, from recent daily sales (closed days,
 * with no sales, are left out). 1 for the busiest day. Undefined with too little history.
 */
export function dayShare(sales: readonly DaySales[], weekday: number, options: { busiest?: number; minDays?: number } = {}): { share: number; busiest: number } | undefined {
  const totals = new Map<number, { sum: number; n: number }>();
  for (const s of sales) {
    if (!(s.netSales > 0)) continue;
    const w = weekdayOf(s.date);
    const t = totals.get(w) ?? { sum: 0, n: 0 };
    t.sum += s.netSales;
    t.n += 1;
    totals.set(w, t);
  }
  const avg = (w: number) => {
    const t = totals.get(w);
    return t && t.n >= (options.minDays ?? 3) ? t.sum / t.n : undefined;
  };
  const busiest = options.busiest ?? [...totals.keys()].sort((a, b) => (avg(b) ?? 0) - (avg(a) ?? 0))[0];
  if (busiest === undefined) return undefined;
  const top = avg(busiest), day = avg(weekday);
  if (!top || day === undefined) return undefined;
  return { share: Math.min(1, day / top), busiest };
}

/** Pars are counted in halves when small (half a ninth pan), whole units otherwise. */
export function stepFor(par: number): number {
  return par < 4 || !Number.isInteger(par) ? 0.5 : 1;
}

export function roundUp(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step;
}

export interface DayLine {
  item: StationItem;
  /** The par for this day, scaled. Undefined for tasks and items without a par. */
  dayPar?: number;
  /** What the app suggests making, once counted. */
  suggested?: number;
  reason?: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The items on a station's list for a date, with the day's par and, given counts, what to make. */
export function dayLines(items: readonly StationItem[], date: string, share: { share: number; busiest: number } | undefined, counts: ReadonlyMap<string, number> = new Map()): DayLine[] {
  const weekday = weekdayOf(date);
  const out: DayLine[] = [];
  for (const item of items) {
    if (item.weekdays?.length && !item.weekdays.includes(weekday)) continue;
    if ((item.activeFrom && date < item.activeFrom) || (item.activeUntil && date > item.activeUntil)) continue;
    if (item.kind !== 'count' || item.par === undefined) {
      out.push({ item });
      continue;
    }
    const step = stepFor(item.par);
    const scaled = share && weekday !== share.busiest ? Math.max(step, roundUp(item.par * share.share, step)) : item.par;
    const counted = counts.get(item.id);
    const line: DayLine = { item, dayPar: scaled };
    if (counted !== undefined) {
      line.suggested = Math.max(0, roundUp(scaled - counted, step));
      line.reason = scaled !== item.par && share
        ? `${DAY_NAMES[weekday]} usually runs at ${Math.round(share.share * 100)}% of a ${DAY_NAMES[share.busiest]}: par ${fmt(scaled)} instead of ${fmt(item.par)}, ${fmt(counted)} on hand.`
        : `Par ${fmt(scaled)}, ${fmt(counted)} on hand.`;
    }
    out.push(line);
  }
  return out;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

// ---------------------------------------------------------------- bulk prep as inventory

export interface StationNeed {
  station: string;
  item: string;
  unit?: string;
  /** What that station will fill tomorrow, in its own units; undefined when not counted yet. */
  toMake?: number;
  /** Bulk units one station unit holds (one 1/6 pan holds 2 qt). */
  holds?: number;
}

export interface BulkOnHand {
  amount: number;
  /** False right after a count; true when it's been moved by fills and batches since. */
  estimated: boolean;
  /** The last count, if any. */
  countedAt?: string;
}

export interface BatchSuggestion {
  suggested?: number;
  /** What the stations will draw, in bulk units. */
  need: number;
  reason: string;
  /** Linked station items left out (not counted, or no conversion yet). */
  missing: string[];
}

/**
 * Batches of a bulk item to make: tomorrow's station fills, converted to the bulk's unit,
 * less what's on hand, in whole batches. A shortfall under a fifth of a batch waits a day.
 */
export function batchSuggestion(needs: readonly StationNeed[], onHand: BulkOnHand | undefined, bulk: { name: string; unit?: string; batchYield?: number }): BatchSuggestion | undefined {
  if (!needs.length) return undefined;
  const u = bulk.unit ? ` ${bulk.unit}` : '';
  const missing: string[] = [];
  const parts: string[] = [];
  let need = 0;
  for (const n of needs) {
    if (n.toMake === undefined) { missing.push(`${n.station} ${n.item} (not counted)`); continue; }
    if (!n.holds) { missing.push(`${n.station} ${n.item} (how much one ${n.unit ?? 'container'} holds)`); continue; }
    if (n.toMake > 0) parts.push(`${n.station} fills ${fmt(n.toMake)} ${n.unit ?? ''} (${fmt(n.toMake * n.holds)}${u})`.replace(/ +/g, ' '));
    need += n.toMake * n.holds;
  }
  const have = onHand?.amount ?? 0;
  const haveText = onHand ? `${onHand.estimated ? 'about ' : ''}${fmt(Math.round(have * 100) / 100)}${u} on hand${onHand.estimated ? (onHand.countedAt ? ' (estimated since the last count)' : ' (estimated, never counted)') : ''}` : `nothing on hand recorded`;
  const drawn = parts.length ? parts.join(', ') : 'No station fills any';
  const short = need - have;
  if (!bulk.batchYield) {
    return { need, missing, reason: `${drawn}; ${haveText}. Set how much one batch makes to get a suggestion.` };
  }
  const suggested = short > 0.2 * bulk.batchYield ? Math.ceil(short / bulk.batchYield - 1e-9) : 0;
  const makes = suggested ? `make ${suggested} batch${suggested === 1 ? '' : 'es'} (${fmt(suggested * bulk.batchYield)}${u})` : 'no batch needed';
  return { suggested, need, missing, reason: `${drawn}; ${haveText}: ${makes}.` };
}

/** On hand from the ledger: the last count, moved by everything after it. */
export function onHandFrom(entries: readonly { at: string; kind: 'made' | 'filled' | 'counted' | 'waste'; change?: number; setTo?: number }[]): BulkOnHand | undefined {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  let lastCount = -1;
  sorted.forEach((e, i) => { if (e.kind === 'counted') lastCount = i; });
  let amount = lastCount >= 0 ? sorted[lastCount]!.setTo ?? 0 : 0;
  const after = sorted.slice(lastCount + 1);
  for (const e of after) amount += e.change ?? 0;
  return { amount: Math.max(0, amount), estimated: after.length > 0 || lastCount < 0, ...(lastCount >= 0 ? { countedAt: sorted[lastCount]!.at } : {}) };
}
