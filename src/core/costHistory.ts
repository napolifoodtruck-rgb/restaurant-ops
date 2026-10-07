/**
 * What a recipe cost over time: its ingredients (as the recipe is written today) priced at each
 * past date from the invoices, so a dish's chart and an ingredient's chart read as one system.
 *
 *   cost(date) = Σ amount × the ingredient's price on its latest invoice up to that date
 *
 * Before an ingredient's first invoice its first price is used (so a line doesn't drop to zero);
 * an ingredient with no invoice at all keeps today's price (set by hand, or MarginEdge's last).
 * Pure: amounts are in each product's base unit.
 */

export interface PricedLine { productId: string; name: string; amount: number }
export interface PricePoint { date: string; perUnit: number }

export interface CostPoint { date: string; cost: number }
export interface CostDriver { productId: string; name: string; change: number; from: number; to: number }

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Price on a date: the latest point up to it, else the first one. Points sorted by date. */
export function priceOn(points: readonly PricePoint[], date: string): number | undefined {
  if (!points.length) return undefined;
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.date.slice(0, 10) <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return points[found >= 0 ? found : 0]!.perUnit;
}

export interface HistoryInput {
  lines: readonly PricedLine[];
  pricesOf: (productId: string) => readonly PricePoint[];
  /** Today's price, for an ingredient with no invoices. */
  priceNow: (productId: string) => number | undefined;
  today: string;
  /** How far back, and how often. */
  weeks?: number;
  every?: number;
}

export function costHistory(input: HistoryInput): { points: CostPoint[]; drivers: CostDriver[]; complete: boolean } {
  const weeks = input.weeks ?? 52, every = input.every ?? 7;
  const dates: string[] = [];
  for (let d = weeks * 7; d >= 0; d -= every) dates.push(addDays(input.today, -d));
  if (dates.at(-1) !== input.today) dates.push(input.today);
  const price = (l: PricedLine, date: string) => priceOn(input.pricesOf(l.productId), date) ?? input.priceNow(l.productId);
  const complete = input.lines.every((l) => price(l, input.today) !== undefined);
  const points = dates.map((date) => ({ date, cost: Math.round(input.lines.reduce((a, l) => a + l.amount * (price(l, date) ?? 0), 0) * 100) / 100 }));
  // What moved it over the last 90 days, biggest first.
  const then = addDays(input.today, -90);
  const drivers = input.lines.map((l) => {
    const from = l.amount * (price(l, then) ?? 0), to = l.amount * (price(l, input.today) ?? 0);
    return { productId: l.productId, name: l.name, change: Math.round((to - from) * 100) / 100, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 };
  }).filter((d) => Math.abs(d.change) >= 0.01).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { points, drivers, complete };
}
