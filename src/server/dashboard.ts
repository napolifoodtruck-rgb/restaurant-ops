/**
 * Today's dashboard, for managers: how the restaurant is running.
 *
 *   GET /api/today/dashboard
 *
 * The last service against a usual one, the week so far by day against last week, prime cost for
 * the last six full weeks, ingredient prices that moved enough to matter, and what earned most
 * over the last 7 days. Each part opens the report behind it.
 */

import type { Db } from './db.ts';
import type { SignedIn } from './auth.ts';
import { getModel } from './model.ts';
import { purchasesOf } from './reports.ts';
import { priceMoves } from './today.ts';
import { primeCost } from '../core/costReports.ts';
import { addDays, lastService, mondayOf, weekByDay, type DayTotals } from '../core/dashboard.ts';

export async function dashboardView(db: Db, who: SignedIn, today: string) {
  const rid = who.restaurantId;
  const from = addDays(today, -63);
  const orders = (await db.query<{ day: string; sales: string; orders: string; covers: string }>(
    'SELECT day::text AS day, sum(net_sales) AS sales, count(*) AS orders, sum(covers) AS covers FROM pos_orders WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day', [rid, from, today])).rows;
  const labor = new Map((await db.query<{ day: string; cost: string; hours: string }>(
    'SELECT day::text AS day, sum(labor_cost) AS cost, sum(hours) AS hours FROM pos_timecards WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day', [rid, from, today])).rows
    .map((r) => [r.day, { cost: Number(r.cost), hours: Number(r.hours) }]));
  let days: DayTotals[] = orders.map((r) => ({ day: r.day, sales: Number(r.sales), orders: Number(r.orders), covers: Number(r.covers), ...(labor.has(r.day) ? { labor: labor.get(r.day)!.cost } : {}) }));
  // No order detail synced yet: the day totals from item sales still give sales.
  if (!days.length) {
    days = (await db.query<{ day: string; sales: string }>('SELECT day::text AS day, sum(net_sales) AS sales FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day', [rid, from, today])).rows
      .map((r) => ({ day: r.day, sales: Number(r.sales), orders: 0, covers: 0, ...(labor.has(r.day) ? { labor: labor.get(r.day)!.cost } : {}) }));
  }

  // Prime cost: the last six full weeks (invoices are lumpy; a week is the shortest that reads right).
  const pTo = addDays(mondayOf(today), -1), pFrom = addDays(pTo, -41);
  const pModel = await getModel(db, rid, pTo, { from: pFrom, to: pTo });
  const inRange = (d: string) => d >= pFrom && d <= pTo;
  const prime = primeCost(days.filter((d) => inRange(d.day)).map((d) => ({ day: d.day, sales: d.sales })), purchasesOf(pModel, pFrom, pTo),
    [...labor].filter(([d]) => inRange(d)).map(([day, l]) => ({ day, cost: l.cost, hours: l.hours })));

  const model = await getModel(db, rid, today);
  const week = await getModel(db, rid, today, { from: addDays(today, -7), to: addDays(today, -1) });
  return {
    today,
    lastService: lastService(days, today) ?? null,
    week: weekByDay(days, today),
    prime: { from: pFrom, to: pTo, weeks: prime.weeks.filter((w) => w.sales > 0), total: prime.total },
    prices: priceMoves(model, today).slice(0, 4).map((m) => ({ productId: m.productId, product: m.product, change: m.change, perWeek: Math.round(m.perWeek), dish: m.dish })),
    earners: week.margins.dishes.filter((d) => d.quantity > 0).sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 5)
      .map((d) => ({ name: d.name, sold: Math.round(d.quantity), left: Math.round(d.totalContribution), netSales: Math.round(d.netSales) })),
  };
}
