/**
 * Reports, for managers, over any period:
 *
 *   GET /api/reports/sales?from=&to=        how the money came in, tables, servers
 *   GET /api/reports/menu?from=&to=&area=   every item by how it was ordered, by category
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

export async function reportRoutes(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/reports/sales' && path !== '/api/reports/menu') return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new HttpError(400, 'Pick a period: from and to dates.');
  if (to > today) throw new HttpError(400, 'That period hasn’t happened yet.');
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
