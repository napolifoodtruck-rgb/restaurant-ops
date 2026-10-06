/**
 * Reports from orders: how the money came in (table orders, to go at the register, online),
 * tables, each server's covers, cover rate, tip rate and wine, and every menu item by how it was
 * ordered. Each for any period, set against the period before and the same one last year.
 *
 * House rules, from how Napoli reads its numbers:
 *   - Orders with a table are table orders; register orders with no table are to go, whatever
 *     dining option they were rung with; online orders are online.
 *   - Automatic gratuity is a tip, not a sale.
 *   - Servers are judged on table orders only (to-go tips say little about service), and wine
 *     against covers, so whoever works more shifts doesn't simply look better.
 *   - Days when wine is half price are left out of servers' wine, found from the data: a weekday
 *     when most wine sold on a discount button ("50% OFF WINE WEDNESDAY").
 *   - A special is judged by what it sold per day it was on, not its total.
 */

export interface Order {
  id: string;
  day: string;
  table?: string;
  fulfillment?: string;
  source?: string;
  serverId?: string;
  serverName?: string;
  covers: number;
  sales: number;
  tips: number;
  autoGratuity: number;
}

export interface Line {
  orderId: string;
  day: string;
  item: string;
  variation?: string;
  category?: string;
  quantity: number;
  sales: number;
}

export type OrderType = 'table' | 'register' | 'online';
export const ORDER_TYPES: OrderType[] = ['table', 'register', 'online'];
export const TYPE_NAMES: Record<OrderType, string> = { table: 'Table orders', register: 'To go at the register', online: 'Online' };

export function orderType(o: Pick<Order, 'table' | 'source'>): OrderType {
  if (/online|web|app\b|doordash|uber|grubhub/i.test(o.source ?? '')) return 'online';
  return o.table ? 'table' : 'register';
}

const DAY = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1;

/** The same number of days just before. */
export function previousRange(from: string, to: string) {
  const n = daysBetween(from, to);
  return { from: shift(from, -n), to: shift(from, -1) };
}
/** The same weekdays a year earlier (52 weeks back), so a Saturday is set against a Saturday. */
export function lastYearRange(from: string, to: string) {
  return { from: shift(from, -364), to: shift(to, -364) };
}

export const isWine = (category?: string) => /\bwine\b/i.test(category ?? '');
export function wineKind(l: Pick<Line, 'item' | 'variation'>): 'glass' | 'bottle' | 'other' {
  const name = `${l.item} ${l.variation ?? ''}`;
  if (/\b(gls|glass|glasses)\b/i.test(name)) return 'glass';
  if (/\b(btl|bottle|bottles)\b/i.test(name)) return 'bottle';
  return 'other';
}
const DISCOUNT = /%|\b(off|half|happy hour)\b/i;

/** Weekdays when most wine sold on a discount button: left out of servers' wine. */
export function discountWineDays(lines: Line[]): number[] {
  const by = new Map<number, { all: number; off: number }>();
  for (const l of lines) {
    if (!isWine(l.category)) continue;
    const w = weekdayOf(l.day);
    const x = by.get(w) ?? { all: 0, off: 0 };
    x.all += l.quantity;
    if (DISCOUNT.test(l.variation ?? '')) x.off += l.quantity;
    by.set(w, x);
  }
  return [...by].filter(([, x]) => x.all >= 5 && x.off / x.all >= 0.5).map(([w]) => w).sort();
}

const money = (v: number) => Math.round(v * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : undefined);

export interface SalesReport {
  days: number;
  totals: { sales: number; orders: number; covers: number; coverRate?: number; tips: number; tipRate?: number; tableSales: number };
  byType: { type: OrderType; name: string; sales: number; orders: number; average?: number; share: number }[];
  tables: { table: string; sales: number; covers: number; turns: number; coverRate?: number; coversPerTurn?: number }[];
  servers: { name: string; orders: number; covers: number; sales: number; coverRate?: number; tips: number; tipRate?: number; wineGlass: number; wineBottle: number; wine: number; winePerCover?: number; wineCovers: number }[];
  wineDaysLeftOut: number[];
}

/** Team and sales for one period's orders and lines. */
export function salesReport(orders: Order[], lines: Line[], opts: { wineDaysLeftOut?: number[] } = {}): SalesReport {
  const days = new Set(orders.map((o) => o.day)).size;
  const tableOrders = orders.filter((o) => orderType(o) === 'table');
  const sum = (xs: Order[], f: (o: Order) => number) => xs.reduce((a, o) => a + f(o), 0);
  const tips = (o: Order) => o.tips + o.autoGratuity;
  const sales = sum(orders, (o) => o.sales);
  const tableSales = sum(tableOrders, (o) => o.sales), tableCovers = sum(tableOrders, (o) => o.covers);

  const byType = ORDER_TYPES.map((type) => {
    const xs = orders.filter((o) => orderType(o) === type);
    const s = sum(xs, (o) => o.sales);
    return { type, name: TYPE_NAMES[type], sales: money(s), orders: xs.length, ...(xs.length ? { average: money(s / xs.length) } : {}), share: sales ? s / sales : 0 };
  }).filter((x) => x.orders);

  const tables = new Map<string, Order[]>();
  for (const o of tableOrders) tables.set(o.table!, [...(tables.get(o.table!) ?? []), o]);
  const tableNum = (t: string) => Number(t.replace(/\D+/g, '')) || 0;

  // Servers: table orders only; wine from their table orders' lines, leaving out discount days.
  const leftOut = new Set(opts.wineDaysLeftOut ?? discountWineDays(lines));
  const orderOf = new Map(tableOrders.map((o) => [o.id, o]));
  const wineBy = new Map<string, { glass: number; bottle: number; other: number }>();
  for (const l of lines) {
    const o = orderOf.get(l.orderId);
    if (!o || !isWine(l.category) || leftOut.has(weekdayOf(l.day))) continue;
    const k = o.serverName ?? 'Unassigned';
    const w = wineBy.get(k) ?? { glass: 0, bottle: 0, other: 0 };
    w[wineKind(l)] += l.sales;
    wineBy.set(k, w);
  }
  const servers = new Map<string, Order[]>();
  for (const o of tableOrders) { const k = o.serverName ?? 'Unassigned'; servers.set(k, [...(servers.get(k) ?? []), o]); }

  return {
    days,
    totals: { sales: money(sales), orders: orders.length, covers: tableCovers, ...(ratio(tableSales, tableCovers) !== undefined ? { coverRate: money(tableSales / tableCovers) } : {}),
      tips: money(sum(orders, tips)), ...(ratio(sum(tableOrders, tips), tableSales) !== undefined ? { tipRate: sum(tableOrders, tips) / tableSales } : {}), tableSales: money(tableSales) },
    byType,
    tables: [...tables].map(([table, xs]) => {
      const s = sum(xs, (o) => o.sales), c = sum(xs, (o) => o.covers);
      return { table, sales: money(s), covers: c, turns: xs.length, ...(c ? { coverRate: money(s / c), coversPerTurn: Math.round((c / xs.length) * 10) / 10 } : {}) };
    }).sort((a, b) => tableNum(a.table) - tableNum(b.table) || a.table.localeCompare(b.table)),
    servers: [...servers].map(([name, xs]) => {
      const s = sum(xs, (o) => o.sales), c = sum(xs, (o) => o.covers), t = sum(xs, tips);
      const w = wineBy.get(name) ?? { glass: 0, bottle: 0, other: 0 };
      const wineCovers = sum(xs.filter((o) => !leftOut.has(weekdayOf(o.day))), (o) => o.covers);
      const wine = w.glass + w.bottle + w.other;
      return { name, orders: xs.length, covers: c, sales: money(s), ...(c ? { coverRate: money(s / c) } : {}), tips: money(t), ...(s > 0 ? { tipRate: t / s } : {}),
        wineGlass: money(w.glass), wineBottle: money(w.bottle), wine: money(wine), wineCovers, ...(wineCovers ? { winePerCover: money(wine / wineCovers) } : {}) };
    }).sort((a, b) => b.sales - a.sales),
    wineDaysLeftOut: [...leftOut].sort(),
  };
}

export interface MenuItem {
  name: string;
  category: string;
  quantity: number;
  sales: number;
  byType: Record<OrderType, number>;
  /** Open days from its first sale in the period to its last. */
  daysOn: number;
  perDay: number;
  /** Plates a day against the period before (when it sold then): +0.2 is 20% more. */
  change?: number;
  /** By Square variation, when it sold under more than one (sizes, glass or bottle, discount days). */
  variations?: { name: string; quantity: number; sales: number }[];
}

/** Every item by how it was ordered, ranked within its category; specials compared per day on. */
export function menuReport(orders: Order[], lines: Line[], before?: { orders: Order[]; lines: Line[] }): { categories: { name: string; sales: number; items: MenuItem[] }[]; openDays: number } {
  const typeOf = new Map(orders.map((o) => [o.id, orderType(o)]));
  const open = [...new Set(orders.map((o) => o.day))].sort();
  const openDaysIn = (from: string, to: string, days: string[]) => days.filter((d) => d >= from && d <= to).length;
  const perDayBefore = new Map<string, number>();
  if (before) {
    const days = [...new Set(before.orders.map((o) => o.day))].sort();
    const agg = new Map<string, { q: number; first: string; last: string }>();
    for (const l of before.lines) {
      const k = `${l.category ?? ''}\u0000${l.item}`;
      const x = agg.get(k) ?? { q: 0, first: l.day, last: l.day };
      x.q += l.quantity; if (l.day < x.first) x.first = l.day; if (l.day > x.last) x.last = l.day;
      agg.set(k, x);
    }
    for (const [k, x] of agg) perDayBefore.set(k, x.q / Math.max(1, openDaysIn(x.first, x.last, days)));
  }
  const items = new Map<string, MenuItem & { first: string; last: string; vars: Map<string, { name: string; quantity: number; sales: number }> }>();
  for (const l of lines) {
    const k = `${l.category ?? ''}\u0000${l.item}`;
    const it = items.get(k) ?? { name: l.item, category: l.category ?? 'Other', quantity: 0, sales: 0, byType: { table: 0, register: 0, online: 0 }, daysOn: 0, perDay: 0, first: l.day, last: l.day, vars: new Map() };
    it.quantity += l.quantity; it.sales += l.sales;
    const vn = l.variation && !/^regular$/i.test(l.variation) ? l.variation : 'Regular';
    const v = it.vars.get(vn) ?? { name: vn, quantity: 0, sales: 0 };
    v.quantity += l.quantity; v.sales += l.sales;
    it.vars.set(vn, v);
    it.byType[typeOf.get(l.orderId) ?? 'register'] += l.quantity;
    if (l.day < it.first) it.first = l.day; if (l.day > it.last) it.last = l.day;
    items.set(k, it);
  }
  const cats = new Map<string, MenuItem[]>();
  for (const [k, it] of items) {
    const daysOn = Math.max(1, openDaysIn(it.first, it.last, open));
    const perDay = it.quantity / daysOn;
    const was = perDayBefore.get(k);
    const { first: _f, last: _l, vars, ...rest } = it;
    const variations = vars.size > 1 ? [...vars.values()].map((v) => ({ name: v.name, quantity: Math.round(v.quantity * 10) / 10, sales: money(v.sales) })).sort((a, b) => b.sales - a.sales) : undefined;
    const out: MenuItem = { ...rest, quantity: Math.round(it.quantity * 10) / 10, sales: money(it.sales), daysOn, perDay: Math.round(perDay * 10) / 10, ...(was ? { change: perDay / was - 1 } : {}), ...(variations ? { variations } : {}) };
    cats.set(it.category, [...(cats.get(it.category) ?? []), out]);
  }
  return {
    openDays: open.length,
    categories: [...cats].map(([name, xs]) => ({ name, sales: money(xs.reduce((a, x) => a + x.sales, 0)), items: xs.sort((a, b) => b.sales - a.sales) })).sort((a, b) => b.sales - a.sales),
  };
}
