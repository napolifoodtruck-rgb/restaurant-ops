/**
 * Reports, for managers, over any period:
 *
 *   GET /api/reports/day?day=               one service: dine-in, to go and online, the menu by category and item, servers
 *   GET /api/reports/sales?from=&to=        how the money came in, tables, servers
 *   GET /api/reports/menu?from=&to=&area=   every item by how it was ordered, by category
 *   GET /api/reports/prime?from=&to=        prime cost by week: food and bar bought, labor, sales
 *   GET /api/reports/hours?from=&to=        sales and labor by weekday and hour
 *   GET /api/reports/usage?from=&to=&area=  what the recipes say was used against what was bought
 *
 * Each comes with the period before and the same weekdays last year, when there are orders
 * for them. Built from the orders the nightly Square sync keeps (see squareSync.ts).
 */

import type { ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { areaFor, loadAreas } from './areas.ts';
import { lastYearRange, menuReport, previousRange, salesReport, discountWineDays, type Line, type Order } from '../core/reports.ts';
import { hoursGrid, primeCost, purchaseKind, usageGaps, type Purchase, type PurchaseKind } from '../core/costReports.ts';
import { getModel, type Model } from './model.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function load(db: Db, restaurantId: string, from: string, to: string): Promise<{ orders: Order[]; lines: Line[] }> {
  const orders = (await db.query<{ order_id: string; day: string; table_name: string | null; fulfillment: string | null; source: string | null; server_id: string | null; server_name: string | null; covers: number; net_sales: string; tips: string; auto_gratuity: string }>(
    'SELECT order_id, day::text AS day, table_name, fulfillment, source, server_id, server_name, covers, net_sales, tips, auto_gratuity FROM pos_orders WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to])).rows
    .map((r) => ({ id: r.order_id, day: r.day, ...(r.table_name ? { table: r.table_name } : {}), ...(r.fulfillment ? { fulfillment: r.fulfillment } : {}), ...(r.source ? { source: r.source } : {}),
      ...(r.server_id ? { serverId: r.server_id } : {}), ...(r.server_name ? { serverName: r.server_name } : {}), covers: Number(r.covers), sales: Number(r.net_sales), tips: Number(r.tips), autoGratuity: Number(r.auto_gratuity) }));
  const lines = (await db.query<{ order_id: string; day: string; item_name: string; variation_name: string | null; category: string | null; quantity: string; net_sales: string }>(
    'SELECT order_id, day::text AS day, item_name, variation_name, category, quantity, net_sales FROM pos_order_lines WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to])).rows
    .map((r) => ({ orderId: r.order_id, day: r.day, item: r.item_name, ...(r.variation_name ? { variation: r.variation_name } : {}), ...(r.category ? { category: r.category } : {}), quantity: Number(r.quantity), sales: Number(r.net_sales) }));
  return { orders, lines };
}

/** What was bought, line by line from the invoices, sorted into food, bar and everything else. */
export function purchasesOf(model: Model, from: string, to: string): Purchase[] {
  const kindOf = new Map(model.purchasing.products.map((p) => [p.externalId, purchaseKind(p.categoryType)]));
  const out: Purchase[] = [];
  for (const inv of model.purchasing.invoices) {
    if (!inv.invoiceDate || inv.invoiceDate < from || inv.invoiceDate > to) continue;
    // Lines with no product take the kind most of the invoice's lines have (a vendor sells one sort of thing).
    const kinds = inv.lines.map((l) => (l.productExternalId ? kindOf.get(l.productExternalId) : undefined)).filter((k): k is PurchaseKind => Boolean(k));
    const usual = (['food', 'bar', 'other'] as const).map((k) => [k, kinds.filter((x) => x === k).length] as const).sort((a, b) => b[1] - a[1])[0];
    for (const l of inv.lines) {
      const kind = (l.productExternalId && kindOf.get(l.productExternalId)) || (usual && usual[1] > 0 ? usual[0] : 'other');
      out.push({ date: inv.invoiceDate, amount: inv.isCredit ? -Math.abs(l.lineTotal) : l.lineTotal, kind, ...(l.productExternalId ? { productId: l.productExternalId } : {}), ...(inv.vendorName ? { vendor: inv.vendorName } : {}) });
    }
  }
  return out;
}

async function costReports(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string, from: string, to: string): Promise<boolean> {
  const path = url.pathname;
  const model = await getModel(db, who.restaurantId, to, { from, to });
  if (path === '/api/reports/prime') {
    const weekStart = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const load = async (f: string, t: string) => {
      const sales = (await db.query<{ day: string; sales: string }>('SELECT day::text AS day, sum(net_sales) AS sales FROM pos_orders WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day', [who.restaurantId, f, t])).rows.map((r) => ({ day: r.day, sales: Number(r.sales) }));
      const labor = (await db.query<{ day: string; cost: string; hours: string; job: string | null }>('SELECT day::text AS day, sum(labor_cost) AS cost, sum(hours) AS hours, job_title AS job FROM pos_timecards WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day, job_title', [who.restaurantId, f, t])).rows
        .map((r) => ({ day: r.day, cost: Number(r.cost), hours: Number(r.hours), ...(r.job ? { job: r.job } : {}) }));
      return primeCost(sales, purchasesOf(f === from ? model : await getModel(db, who.restaurantId, t, { from: f, to: t }), f, t), labor);
    };
    const now = await load(from, to);
    const prev = previousRange(from, to), ly = lastYearRange(from, to);
    const firsts = (await db.query<{ orders: string | null; labor: string | null }>('SELECT (SELECT min(day)::text FROM pos_orders WHERE restaurant_id = $1) AS orders, (SELECT min(day)::text FROM pos_timecards WHERE restaurant_id = $1) AS labor', [who.restaurantId])).rows[0]!;
    const invoicesFrom = model.purchasing.invoices.map((i) => i.invoiceDate).filter(Boolean).sort()[0];
    const covered = (f: string) => Boolean(firsts.orders && firsts.labor && invoicesFrom && f >= firsts.orders && f >= firsts.labor && f >= invoicesFrom);
    return send(res, 200, {
      from, to, previous: prev, lastYear: ly, weekStart: weekStart(from),
      dataFrom: { orders: firsts.orders, labor: firsts.labor, invoices: invoicesFrom },
      ...now,
      ...(covered(prev.from) ? { before: (await load(prev.from, prev.to)).total } : {}),
      ...(covered(ly.from) ? { lastYearTotal: (await load(ly.from, ly.to)).total } : {}),
    }), true;
  }
  if (path === '/api/reports/hours') {
    const sales = (await db.query<{ day: string; hour: number; sales: string; orders: number; covers: number }>('SELECT day::text AS day, hour, net_sales AS sales, orders, covers FROM pos_sales_hourly WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [who.restaurantId, from, to])).rows
      .map((r) => ({ day: r.day, hour: Number(r.hour), sales: Number(r.sales), orders: Number(r.orders), covers: Number(r.covers) }));
    const shifts = (await db.query<{ day: string; clock_in: string; clock_out: string; cost: string; job: string | null }>(
      "SELECT day::text AS day, to_char(clock_in, 'YYYY-MM-DD HH24:MI:SS') AS clock_in, to_char(clock_out, 'YYYY-MM-DD HH24:MI:SS') AS clock_out, labor_cost AS cost, job_title AS job FROM pos_timecards WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3", [who.restaurantId, from, to])).rows
      .map((r) => ({ day: r.day, clockIn: r.clock_in, clockOut: r.clock_out, cost: Number(r.cost), ...(r.job ? { job: r.job } : {}) }));
    const dataFrom = (await db.query<{ day: string | null }>('SELECT min(day)::text AS day FROM pos_sales_hourly WHERE restaurant_id = $1', [who.restaurantId])).rows[0]?.day ?? undefined;
    return send(res, 200, { from, to, ...(dataFrom ? { dataFrom } : {}), hasLabor: shifts.length > 0, ...hoursGrid(sales, shifts) }), true;
  }
  // Usage: each dish sold × its recipe at today's prices, against what was bought, one side at a time.
  const area = areaFor(who, url.searchParams.get('area'));
  const areaOf = await loadAreas(db, who.restaurantId);
  const invoicesFrom = model.purchasing.invoices.map((i) => i.invoiceDate).filter(Boolean).sort()[0];
  const noRecipe = model.margins.unlinked.filter((u) => areaOf(u.category) === area && u.netSales > 0).reduce((a, u) => a + u.netSales, 0);
  return send(res, 200, { from, to, area, ...(invoicesFrom ? { invoicesFrom } : {}), days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1, noRecipeSales: Math.round(noRecipe), ...usageFor(model, area, areaOf, from, to) }), true;
}

/** Recipes against purchases for one side over the model's period: each dish sold × its recipe, at today's prices. */
export function usageFor(model: Model, area: 'kitchen' | 'bar', areaOf: (category: string) => string, from: string, to: string) {
  const expected = model.margins.dishes.filter((d) => areaOf(d.category) === area)
    .flatMap((d) => d.cost.lines.filter((l) => l.cost !== undefined).map((l) => ({ productId: l.productId, name: l.productName, dollars: l.cost! * d.quantity })));
  const want: PurchaseKind = area === 'bar' ? 'bar' : 'food';
  const purchases = purchasesOf(model, from, to).filter((p) => p.kind === want);
  const names = new Map(model.purchasing.products.map((p) => [p.externalId, p.name]));
  const kinds = new Map(model.purchasing.products.map((p) => [p.externalId, purchaseKind(p.categoryType)]));
  return usageGaps(expected, purchases, names, kinds);
}

/**
 * One service, for the morning after: the totals against a usual night of that weekday, how the money
 * came in (dine-in, to go, online) against the same night last week, every category of the menu with
 * its items by how they were ordered, and each server. The day defaults to the last one with sales.
 */
async function dayReport(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string): Promise<boolean> {
  const rid = who.restaurantId;
  const asked = url.searchParams.get('day');
  if (asked && (!DATE.test(asked) || asked > today)) throw new HttpError(400, 'Pick a day that’s happened.');
  const day = asked ?? (await db.query<{ day: string | null }>('SELECT max(day)::text AS day FROM pos_orders WHERE restaurant_id = $1 AND day < $2', [rid, today])).rows[0]?.day;
  if (!day) return send(res, 200, { day: null }), true;
  const near = (await db.query<{ prev: string | null; next: string | null }>(
    'SELECT (SELECT max(day)::text FROM pos_orders WHERE restaurant_id = $1 AND day < $2) AS prev, (SELECT min(day)::text FROM pos_orders WHERE restaurant_id = $1 AND day > $2) AS next', [rid, day])).rows[0]!;
  const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const cur = await load(db, rid, day, day);
  const weekAgo = await load(db, rid, shiftDay(day, -7), shiftDay(day, -7));
  const wineDaysLeftOut = discountWineDays(cur.lines);
  const now = salesReport(cur.orders, cur.lines, { wineDaysLeftOut });
  const then = weekAgo.orders.length ? salesReport(weekAgo.orders, weekAgo.lines, { wineDaysLeftOut }) : undefined;
  // A usual night of this weekday: the four before it with sales, when there are at least two.
  const usualDays = (await db.query<{ sales: string; orders: string }>(
    'SELECT sum(net_sales) AS sales, count(*) AS orders FROM pos_orders WHERE restaurant_id = $1 AND day < $2 AND day >= $2::date - 28 AND extract(dow FROM day) = extract(dow FROM $2::date) GROUP BY day HAVING sum(net_sales) > 0', [rid, day])).rows;
  const avg = (k: 'sales' | 'orders') => usualDays.reduce((a, r) => a + Number(r[k]), 0) / usualDays.length;
  const labor = (await db.query<{ cost: string | null; hours: string | null }>('SELECT sum(labor_cost) AS cost, sum(hours) AS hours FROM pos_timecards WHERE restaurant_id = $1 AND day = $2', [rid, day])).rows[0];
  const laborCost = labor?.cost !== null && labor?.cost !== undefined ? Number(labor.cost) : undefined;
  // The menu: every category, kitchen first, each with its items by how they were ordered.
  const areaOf = await loadAreas(db, rid);
  const menu = menuReport(cur.orders, cur.lines).categories.map((c) => ({ name: c.name, area: areaOf(c.name), sales: c.sales,
    items: c.items.map((i) => ({ name: i.name, quantity: i.quantity, sales: i.sales, byType: i.byType, ...(i.variations ? { variations: i.variations } : {}) })) }))
    .sort((a, b) => (a.area === b.area ? b.sales - a.sales : a.area === 'kitchen' ? -1 : 1));
  return send(res, 200, {
    day, ...(near.prev ? { prevDay: near.prev } : {}), ...(near.next && near.next < today ? { nextDay: near.next } : {}),
    totals: now.totals,
    ...(usualDays.length >= 2 ? { usual: { sales: Math.round(avg('sales') * 100) / 100, orders: Math.round(avg('orders')), nights: usualDays.length } } : {}),
    ...(laborCost !== undefined ? { labor: { cost: laborCost, hours: Number(labor!.hours ?? 0), ...(now.totals.sales > 0 ? { share: laborCost / now.totals.sales } : {}) } } : {}),
    byType: now.byType, ...(then ? { lastWeek: { day: shiftDay(day, -7), totals: then.totals, byType: then.byType } } : {}),
    servers: now.servers, wineDaysLeftOut: now.wineDaysLeftOut,
    menu,
  }), true;
}

export async function reportRoutes(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!['/api/reports/day', '/api/reports/sales', '/api/reports/menu', '/api/reports/prime', '/api/reports/hours', '/api/reports/usage'].includes(path)) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  if (path === '/api/reports/day') return dayReport(db, res, url, who, today);
  const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new HttpError(400, 'Pick a period: from and to dates.');
  if (to > today) throw new HttpError(400, 'That period hasn’t happened yet.');
  if (path === '/api/reports/prime' || path === '/api/reports/hours' || path === '/api/reports/usage') return costReports(db, res, url, who, today, from, to);
  const range = await db.query<{ first: string | null; last: string | null }>('SELECT min(day)::text AS first, max(day)::text AS last FROM pos_orders WHERE restaurant_id = $1', [who.restaurantId]);
  const dataFrom = range.rows[0]?.first ?? undefined, dataTo = range.rows[0]?.last ?? undefined;
  const prev = previousRange(from, to), ly = lastYearRange(from, to);
  // A comparison only when the orders reach back that far.
  const covered = (r: { from: string }) => Boolean(dataFrom && r.from >= dataFrom);
  const cur = await load(db, who.restaurantId, from, to);
  const before = covered(prev) ? await load(db, who.restaurantId, prev.from, prev.to) : undefined;
  const lastYear = covered(ly) ? await load(db, who.restaurantId, ly.from, ly.to) : undefined;
  const meta = { from, to, ...(dataFrom ? { dataFrom, dataTo } : {}), previous: prev, lastYear: ly, hasPrevious: Boolean(before), hasLastYear: Boolean(lastYear) };

  if (path === '/api/reports/sales') {
    // The half-price wine days come from the whole of what's loaded, so every period agrees.
    const wineDaysLeftOut = discountWineDays([...cur.lines, ...(before?.lines ?? []), ...(lastYear?.lines ?? [])]);
    return send(res, 200, {
      ...meta,
      current: salesReport(cur.orders, cur.lines, { wineDaysLeftOut }),
      ...(before ? { before: salesReport(before.orders, before.lines, { wineDaysLeftOut }) } : {}),
      ...(lastYear ? { lastYearReport: salesReport(lastYear.orders, lastYear.lines, { wineDaysLeftOut }) } : {}),
    }), true;
  }

  // Menu items: one side of the menu at a time.
  const area = areaFor(who, url.searchParams.get('area'));
  const areaOf = await loadAreas(db, who.restaurantId);
  const onSide = (d: { orders: Order[]; lines: Line[] }) => ({ orders: d.orders, lines: d.lines.filter((l) => areaOf(l.category) === area) });
  const now = onSide(cur);
  const vsBefore = menuReport(now.orders, now.lines, before ? onSide(before) : undefined);
  const vsLastYear = lastYear ? menuReport(now.orders, now.lines, onSide(lastYear)) : undefined;
  // Each item's change against last year sits beside its change against the period before.
  for (const c of vsBefore.categories) for (const it of c.items) {
    const ly = vsLastYear?.categories.find((x) => x.name === c.name)?.items.find((x) => x.name === it.name);
    if (ly?.change !== undefined) (it as typeof it & { lastYearChange?: number }).lastYearChange = ly.change;
  }
  return send(res, 200, { ...meta, area, ...vsBefore }), true;
}
