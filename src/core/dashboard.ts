/**
 * Today's "how we're doing": the last service against a usual one, the week so far day by day
 * against last week, and prime cost week by week. Pure: the server hands it the day totals.
 */

export interface DayTotals { day: string; sales: number; orders: number; covers: number; labor?: number }

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Business weeks run Monday to Sunday. */
export const mondayOf = (day: string) => addDays(day, -((weekday(day) + 6) % 7));
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * The last day open before today, and what that weekday usually does (the four before it,
 * when there are at least two).
 */
export function lastService(days: readonly DayTotals[], today: string) {
  const past = days.filter((d) => d.day < today && d.sales > 0).sort((a, b) => a.day.localeCompare(b.day));
  const last = past[past.length - 1];
  if (!last) return undefined;
  const same = past.filter((d) => d.day < last.day && weekday(d.day) === weekday(last.day)).slice(-4);
  const avg = (k: 'sales' | 'orders' | 'covers') => same.reduce((a, d) => a + d[k], 0) / same.length;
  return {
    day: last.day, sales: round(last.sales), orders: last.orders, covers: last.covers,
    ...(last.orders > 0 ? { perOrder: round(last.sales / last.orders) } : {}),
    ...(last.labor !== undefined && last.sales > 0 ? { labor: round(last.labor), laborShare: last.labor / last.sales } : {}),
    ...(same.length >= 2 ? { usual: { sales: round(avg('sales')), orders: Math.round(avg('orders')), weeks: same.length } } : {}),
  };
}

/**
 * The week day by day, Monday to Sunday, each beside the same day last week. This week once it
 * has a day with sales; before that (a Monday morning), last week in full against the one before.
 */
export function weekByDay(days: readonly DayTotals[], today: string) {
  const sales = new Map(days.map((d) => [d.day, d.sales]));
  let monday = mondayOf(today);
  const thisWeek = [...Array(7).keys()].map((i) => addDays(monday, i)).filter((d) => d < today && (sales.get(d) ?? 0) > 0);
  const current = thisWeek.length > 0;
  if (!current) monday = addDays(monday, -7);
  const through = current ? thisWeek[thisWeek.length - 1]! : addDays(monday, 6);
  const out = [...Array(7).keys()].map((i) => {
    const day = addDays(monday, i);
    return { day, ...(day <= through && sales.has(day) ? { sales: round(sales.get(day)!) } : {}), ...(sales.has(addDays(day, -7)) ? { before: round(sales.get(addDays(day, -7))!) } : {}) };
  });
  const toDate = out.filter((d) => d.day <= through);
  return {
    from: monday, through, current,
    days: out,
    total: round(toDate.reduce((a, d) => a + (d.sales ?? 0), 0)),
    before: round(toDate.reduce((a, d) => a + (d.before ?? 0), 0)),
  };
}
