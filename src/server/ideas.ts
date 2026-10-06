/**
 * The Ideas page: managers and owners only. Every rule in core/ideas.ts, fed from the same numbers the
 * other pages show, ranked by dollars a month. Worked out once every half hour per restaurant (it reads
 * a lot); a manager's Not now / Done applies straight away.
 *
 *   GET  /api/ideas             { ideas, setAside, totals }
 *   POST /api/ideas/dismiss     { key, status: 'later' | 'done' | 'back' }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { HttpError, body, send } from './http.ts';
import { getModel } from './model.ts';
import { loadAreas } from './areas.ts';
import { marginsView } from './views.ts';
import { usageFor } from './reports.ts';
import { pricesOf } from './costs.ts';
import { prepTiming } from './prep.ts';
import { hoursGrid, priceHistory, purchaseKind } from '../core/costReports.ts';
import { dishIdeas, foodCostIdeas, laborIdeas, prepIdeas, priceIdeas, rankIdeas, unusedIdeas, vendorIdeas, wasteIdeas, type Idea, type ProductPrices } from '../core/ideas.ts';

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cache = new Map<string, { at: number; today: string; ideas: Idea[]; notes: string[] }>();

/** Every idea for the restaurant, before anything set aside is taken out. */
export async function workOutIdeas(db: Db, restaurantId: string, today: string, tz: string): Promise<{ ideas: Idea[]; notes: string[] }> {
  const hit = cache.get(restaurantId);
  if (hit && hit.today === today && Date.now() - hit.at < 30 * 60_000) return hit;
  const ideas: Idea[] = [];
  const notes: string[] = [];
  const areaOf = await loadAreas(db, restaurantId);
  const sides = ['kitchen', 'bar'] as const;

  // Waste: the last 4 weeks of recipes against purchases, confirmed by the 4 weeks before.
  const days = 28;
  const to = shift(today, -1), from = shift(to, -(days - 1));
  const prevTo = shift(from, -1), prevFrom = shift(prevTo, -(days - 1));
  const now = await getModel(db, restaurantId, to, { from, to });
  const before = await getModel(db, restaurantId, prevTo, { from: prevFrom, to: prevTo });
  const invoicesFrom = now.imported.invoices.map((i) => i.invoiceDate).filter(Boolean).sort()[0];
  const hasBefore = Boolean(invoicesFrom && invoicesFrom <= prevFrom);
  for (const area of sides) {
    const u = usageFor(now, area, areaOf, from, to);
    const b = hasBefore ? usageFor(before, area, areaOf, prevFrom, prevTo) : undefined;
    const coverage = u.totals.bought + u.totals.boughtOff > 0 ? u.totals.expected / (u.totals.bought + u.totals.boughtOff) : 1;
    ideas.push(...wasteIdeas(u.rows, b?.rows, days, area), ...unusedIdeas(u.notOnRecipes.filter((r) => !b || b.notOnRecipes.some((x) => x.productId === r.productId)), days, area, { coverage }));
  }
  if (!hasBefore) notes.push('Waste ideas check two 4-week periods; the invoices don’t reach back that far yet, so one period is used.');

  // Prices and vendors: every product bought in the last 4 months.
  const model90 = await getModel(db, restaurantId, today);
  const products: ProductPrices[] = model90.imported.products.filter((p) => purchaseKind(p.categoryType) !== 'other').flatMap((p) => {
    const points = pricesOf(model90, p.externalId);
    if (!points.some((x) => x.date >= shift(today, -120))) return [];
    const h = priceHistory(points, today);
    return [{ productId: p.externalId, name: p.name, unit: p.baseUnit ?? '', points, ...(h.change90 !== undefined ? { change90: h.change90 } : {}) }];
  });
  ideas.push(...priceIdeas(products, today), ...vendorIdeas(products, today));

  // Dishes: the last 90 days on each side.
  for (const area of sides) {
    const m = marginsView(model90, { area, areaOf });
    const periodDays = Math.max(1, Math.round((Date.parse(m.to) - Date.parse(m.from)) / 86_400_000) + 1);
    const cats = m.categories.map((c) => ({ name: c.name, foodCostShare: c.foodCostShare, dishes: c.dishes }));
    ideas.push(...dishIdeas(cats, (m.openDays / periodDays) * 30, area), ...foodCostIdeas(cats, periodDays, area));
  }

  // Labor: an average week of the last 4, by weekday and hour.
  const sales = (await db.query<{ day: string; hour: number; sales: string; orders: number; covers: number }>('SELECT day::text AS day, hour, net_sales AS sales, orders, covers FROM pos_sales_hourly WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to])).rows
    .map((r) => ({ day: r.day, hour: Number(r.hour), sales: Number(r.sales), orders: Number(r.orders), covers: Number(r.covers) }));
  const shifts = (await db.query<{ day: string; clock_in: string; clock_out: string; cost: string; hours: string }>(
    "SELECT day::text AS day, to_char(clock_in, 'YYYY-MM-DD HH24:MI:SS') AS clock_in, to_char(clock_out, 'YYYY-MM-DD HH24:MI:SS') AS clock_out, labor_cost AS cost, hours FROM pos_timecards WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3", [restaurantId, from, to])).rows;
  const hours = shifts.reduce((a, s) => a + Number(s.hours), 0), cost = shifts.reduce((a, s) => a + Number(s.cost), 0);
  const wage = hours > 0 ? cost / hours : 0;
  if (sales.length && shifts.length) ideas.push(...laborIdeas(hoursGrid(sales, shifts.map((s) => ({ day: s.day, clockIn: s.clock_in, clockOut: s.clock_out, cost: Number(s.cost) }))).cells, wage));
  else notes.push('Labor ideas come once Square timecards and hourly sales have synced.');

  // Prep: the last 6 weeks of timed check-offs.
  const timing = await prepTiming(db, restaurantId, today, tz, { days: 42 });
  ideas.push(...prepIdeas(timing.times.map((t) => ({ itemId: t.itemId, name: t.name, minutes: t.minutes, ...(t.amount !== undefined ? { amount: t.amount } : {}), ...(t.by ? { by: t.by } : {}), ...(t.byName ? { byName: t.byName } : {}), date: t.date })), timing.days, wage || 16));

  const out = { at: Date.now(), today, ideas: rankIdeas(ideas), notes };
  cache.set(restaurantId, out);
  return out;
}

export async function ideaRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, who: SignedIn, today: string, tz: string): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/ideas' && path !== '/api/ideas/dismiss') return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');

  if (req.method === 'POST' && path === '/api/ideas/dismiss') {
    const b = await body(req);
    const key = typeof b.key === 'string' ? b.key : '';
    if (!key) throw new HttpError(400, 'Which idea?');
    if (b.status === 'back') {
      await db.query('DELETE FROM idea_dismissals WHERE restaurant_id = $1 AND idea_key = $2', [who.restaurantId, key]);
      return send(res, 200, { ok: true }), true;
    }
    if (b.status !== 'later' && b.status !== 'done') throw new HttpError(400, 'Not now or done?');
    const idea = (await workOutIdeas(db, who.restaurantId, today, tz)).ideas.find((i) => i.key === key);
    await db.query(`INSERT INTO idea_dismissals (restaurant_id, idea_key, status, until, monthly, title, dismissed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (restaurant_id, idea_key) DO UPDATE SET status = EXCLUDED.status, until = EXCLUDED.until, monthly = EXCLUDED.monthly, title = EXCLUDED.title, dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()`,
      [who.restaurantId, key, b.status, b.status === 'later' ? new Date(Date.now() + 14 * 86_400_000).toISOString() : null, idea?.monthly ?? 0, idea?.title ?? String(b.title ?? '').slice(0, 300), who.staffId]);
    return send(res, 200, { ok: true }), true;
  }

  if (req.method !== 'GET') return false;
  const { ideas, notes } = await workOutIdeas(db, who.restaurantId, today, tz);
  const set = new Map((await db.query<{ idea_key: string; status: 'later' | 'done'; until: string | null; monthly: string; title: string; dismissed_at: string; by_name: string | null }>(
    'SELECT d.idea_key, d.status, d.until, d.monthly, d.title, d.dismissed_at, s.display_name AS by_name FROM idea_dismissals d LEFT JOIN staff s ON s.id = d.dismissed_by AND s.restaurant_id = d.restaurant_id WHERE d.restaurant_id = $1', [who.restaurantId])).rows.map((r) => [r.idea_key, r]));
  // Set aside until its time comes, or (done) unless it's grown by half again since.
  const asleep = (i: Idea) => {
    const d = set.get(i.key);
    if (!d) return false;
    if (i.monthly >= Number(d.monthly) * 1.5 && i.monthly - Number(d.monthly) >= 50) return false;
    return d.status === 'done' || (d.until !== null && Date.parse(d.until) > Date.now());
  };
  const live = ideas.filter((i) => !asleep(i));
  const totals: Record<string, number> = {};
  for (const i of live) totals[i.kind] = (totals[i.kind] ?? 0) + i.monthly;
  return send(res, 200, {
    ideas: live,
    setAside: [...set.values()].filter((d) => ideas.some((i) => i.key === d.idea_key && asleep(i)) || d.status === 'done').sort((a, b) => b.dismissed_at.localeCompare(a.dismissed_at)).slice(0, 30)
      .map((d) => ({ key: d.idea_key, status: d.status, ...(d.until ? { until: d.until } : {}), monthly: Number(d.monthly), title: d.title, at: d.dismissed_at, ...(d.by_name ? { by: d.by_name } : {}) })),
    totals, monthly: live.reduce((a, i) => a + i.monthly, 0), notes,
  }), true;
}
