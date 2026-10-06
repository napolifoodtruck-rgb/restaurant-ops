/**
 * Online ordering settings over HTTP. Managers only: what's sold online, and how many pizzas each
 * pickup window takes. Customers order through onlineCheckout.ts.
 *
 *   GET  /api/online/menu                      every Square item with its online settings, and problems that would stop an order
 *   POST /api/online/items/:itemId             { published?, countsAsPizza? (true | false | null = from its category), soldOutToday? }
 *   POST /api/online/modifiers/:modifierId     { mode: 'shown' | 'hidden' | 'always' }
 *   GET  /api/online/windows?day=YYYY-MM-DD    the weekly plan, that date's windows (default today) and dates with their own limits
 *   POST /api/online/windows/plan              { cells: [{ weekday, starts, maxPizzas }] }
 *   POST /api/online/windows/day               { day, cells: [{ starts, maxPizzas | null = back to the plan }], note? }
 *                                              or { day, closeFrom: 'HH:MM' } (no more online orders from that window on)
 *                                              or { day, reset: true } (back to the plan)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { MODIFIER_MODES, modifierProblems, onlineMenu, type CatalogObject, type ModifierMode, type OnlineMenuItem } from '../core/onlineMenu.ts';
import { isWindowStart, pizzaLimitProblem, windowStarts, windowsFor, type DayCell, type PickupWindow, type PlanCell } from '../core/pickupWindows.ts';
import { addDays } from '../core/forecast.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = (t: string) => t.slice(0, 5);

/** The restaurant's own date and time of day (HH:MM). */
export function localNow(timezone: string, now = new Date()): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function loadPlan(db: Db, restaurantId: string): Promise<PlanCell[]> {
  const { rows } = await db.query<{ weekday: number; starts: string; max_pizzas: number }>('SELECT weekday, starts::text AS starts, max_pizzas FROM pickup_window_plan WHERE restaurant_id = $1', [restaurantId]);
  return rows.map((r) => ({ weekday: Number(r.weekday), starts: hhmm(r.starts), maxPizzas: Number(r.max_pizzas) }));
}

async function loadDay(db: Db, restaurantId: string, day: string): Promise<DayCell[]> {
  const { rows } = await db.query<{ starts: string; max_pizzas: number }>('SELECT starts::text AS starts, max_pizzas FROM pickup_window_days WHERE restaurant_id = $1 AND day = $2', [restaurantId, day]);
  return rows.map((r) => ({ starts: hhmm(r.starts), maxPizzas: Number(r.max_pizzas) }));
}

/** Every Square item with its online settings, as of the last catalog sync. */
export async function loadOnlineMenu(db: Db, restaurantId: string, today: string): Promise<{ menu: OnlineMenuItem[]; synced: boolean }> {
  const catalog = (await db.query<{ data: CatalogObject }>('SELECT data FROM pos_catalog WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as CatalogObject);
  const items = (await db.query<{ item_id: string; published: boolean; counts_as_pizza: boolean | null; sold_out_on: string | null }>('SELECT item_id, published, counts_as_pizza, sold_out_on::text AS sold_out_on FROM online_items WHERE restaurant_id = $1', [restaurantId])).rows;
  const modes = Object.fromEntries((await db.query<{ modifier_id: string; mode: ModifierMode }>('SELECT modifier_id, mode FROM online_modifiers WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.modifier_id, r.mode]));
  const menu = onlineMenu(catalog, items.map((r) => ({ itemId: r.item_id, published: r.published, ...(r.counts_as_pizza !== null ? { countsAsPizza: r.counts_as_pizza } : {}), ...(r.sold_out_on ? { soldOutOn: r.sold_out_on } : {}) })), modes, today);
  return { menu, synced: catalog.length > 0 };
}

/** The windows of a date, with the pizzas already in paid orders and live holds. */
export async function loadWindows(db: Db, restaurantId: string, day: string, exceptOrder?: string): Promise<PickupWindow[]> {
  const taken = Object.fromEntries((await db.query<{ starts: string; pizzas: string }>(
    "SELECT window_starts::text AS starts, sum(pizzas)::text AS pizzas FROM online_orders WHERE restaurant_id = $1 AND day = $2 AND (status = 'paid' OR (status = 'held' AND hold_until > now())) AND id <> $3 GROUP BY window_starts",
    [restaurantId, day, exceptOrder ?? '00000000-0000-0000-0000-000000000000'])).rows.map((r) => [hhmm(r.starts), Number(r.pizzas)]));
  return windowsFor(day, await loadPlan(db, restaurantId), await loadDay(db, restaurantId, day), taken);
}

export async function onlineRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, url: URL, who: SignedIn, timezone: string): Promise<boolean> {
  if (!path.startsWith('/api/online/')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const method = req.method ?? 'GET';
  const now = localNow(timezone);
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/online/menu') {
    const { menu, synced } = await loadOnlineMenu(db, who.restaurantId, now.date);
    return send(res, 200, { today: now.date, synced, items: menu.map((x) => ({ ...x, problems: x.published ? modifierProblems(x) : [] })) }), true;
  }

  if (method === 'POST' && (m = path.match(/^\/api\/online\/items\/([A-Za-z0-9_-]{1,64})$/))) {
    const b = await body(req);
    const known = await db.query("SELECT 1 FROM pos_catalog WHERE restaurant_id = $1 AND object_id = $2 AND type = 'ITEM'", [who.restaurantId, m[1]]);
    if (!known.rows.length) throw new HttpError(404, 'That item isn’t in the Square menu.');
    if (b.published !== undefined && typeof b.published !== 'boolean') throw new HttpError(400, 'Published is yes or no.');
    if (b.countsAsPizza !== undefined && b.countsAsPizza !== null && typeof b.countsAsPizza !== 'boolean') throw new HttpError(400, 'Counts as a pizza is yes, no, or from its category.');
    if (b.soldOutToday !== undefined && typeof b.soldOutToday !== 'boolean') throw new HttpError(400, 'Sold out is yes or no.');
    if (b.published === undefined && b.countsAsPizza === undefined && b.soldOutToday === undefined) throw new HttpError(400, 'Nothing to change.');
    await db.query('INSERT INTO online_items (restaurant_id, item_id, updated_by) VALUES ($1, $2, $3) ON CONFLICT (restaurant_id, item_id) DO NOTHING', [who.restaurantId, m[1], who.staffId]);
    if (b.published !== undefined) await db.query('UPDATE online_items SET published = $3, updated_at = now(), updated_by = $4 WHERE restaurant_id = $1 AND item_id = $2', [who.restaurantId, m[1], b.published, who.staffId]);
    if (b.countsAsPizza !== undefined) await db.query('UPDATE online_items SET counts_as_pizza = $3, updated_at = now(), updated_by = $4 WHERE restaurant_id = $1 AND item_id = $2', [who.restaurantId, m[1], b.countsAsPizza, who.staffId]);
    if (b.soldOutToday !== undefined) await db.query('UPDATE online_items SET sold_out_on = $3, updated_at = now(), updated_by = $4 WHERE restaurant_id = $1 AND item_id = $2', [who.restaurantId, m[1], b.soldOutToday ? now.date : null, who.staffId]);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && (m = path.match(/^\/api\/online\/modifiers\/([A-Za-z0-9_-]{1,64})$/))) {
    const b = await body(req);
    if (!MODIFIER_MODES.includes(b.mode as ModifierMode)) throw new HttpError(400, 'Shown, hidden or always.');
    const known = await db.query("SELECT 1 FROM pos_catalog WHERE restaurant_id = $1 AND type = 'MODIFIER_LIST' AND data->'modifier_list_data'->'modifiers' @> $2::jsonb", [who.restaurantId, JSON.stringify([{ id: m[1] }])]);
    if (!known.rows.length) throw new HttpError(404, 'That modifier isn’t in the Square menu.');
    await db.query('INSERT INTO online_modifiers (restaurant_id, modifier_id, mode, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (restaurant_id, modifier_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), updated_by = EXCLUDED.updated_by', [who.restaurantId, m[1], b.mode, who.staffId]);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'GET' && path === '/api/online/windows') {
    const day = url.searchParams.get('day') ?? now.date;
    if (!DAY.test(day) || Number.isNaN(Date.parse(day))) throw new HttpError(400, 'Dates are YYYY-MM-DD.');
    const plan = await loadPlan(db, who.restaurantId);
    const changed = (await db.query<{ day: string; windows: string; closed: boolean; note: string | null }>(
      'SELECT day::text AS day, count(*)::text AS windows, bool_and(max_pizzas = 0) AS closed, max(note) AS note FROM pickup_window_days WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day',
      [who.restaurantId, now.date, addDays(now.date, 90)])).rows;
    return send(res, 200, {
      today: now.date,
      now: now.time,
      starts: windowStarts(),
      plan,
      day,
      windows: await loadWindows(db, who.restaurantId, day),
      changedDays: changed.map((r) => ({ day: r.day, windows: Number(r.windows), closed: Boolean(r.closed) && Number(r.windows) === windowStarts().length, ...(r.note ? { note: r.note } : {}) })),
    }), true;
  }

  if (method === 'POST' && path === '/api/online/windows/plan') {
    const b = await body(req);
    const cells = Array.isArray(b.cells) ? (b.cells as Record<string, unknown>[]) : [];
    if (!cells.length || cells.length > 7 * windowStarts().length) throw new HttpError(400, 'Which windows?');
    for (const c of cells) {
      if (!Number.isInteger(c.weekday) || (c.weekday as number) < 0 || (c.weekday as number) > 6) throw new HttpError(400, 'Weekday is 0 (Sunday) to 6.');
      if (typeof c.starts !== 'string' || !isWindowStart(c.starts)) throw new HttpError(400, `Windows start at ${windowStarts().join(', ')}.`);
      const problem = pizzaLimitProblem(c.maxPizzas);
      if (problem) throw new HttpError(400, problem);
    }
    for (const c of cells) {
      await db.query('INSERT INTO pickup_window_plan (restaurant_id, weekday, starts, max_pizzas, updated_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (restaurant_id, weekday, starts) DO UPDATE SET max_pizzas = EXCLUDED.max_pizzas, updated_at = now(), updated_by = EXCLUDED.updated_by',
        [who.restaurantId, c.weekday, c.starts, c.maxPizzas, who.staffId]);
    }
    return send(res, 200, { ok: true, saved: cells.length }), true;
  }

  if (method === 'POST' && path === '/api/online/windows/day') {
    const b = await body(req);
    const day = typeof b.day === 'string' ? b.day : '';
    if (!DAY.test(day) || Number.isNaN(Date.parse(day))) throw new HttpError(400, 'Which day? (YYYY-MM-DD)');
    if (day < now.date) throw new HttpError(400, 'That day has passed.');
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null;

    if (b.reset === true) {
      await db.query('DELETE FROM pickup_window_days WHERE restaurant_id = $1 AND day = $2', [who.restaurantId, day]);
      return send(res, 200, { ok: true }), true;
    }

    let cells: { starts: string; maxPizzas: number | null }[];
    if (typeof b.closeFrom === 'string') {
      if (!isWindowStart(b.closeFrom)) throw new HttpError(400, `Windows start at ${windowStarts().join(', ')}.`);
      const from = b.closeFrom;
      cells = windowStarts().filter((s) => s >= from).map((starts) => ({ starts, maxPizzas: 0 }));
    } else {
      const list = Array.isArray(b.cells) ? (b.cells as Record<string, unknown>[]) : [];
      if (!list.length || list.length > windowStarts().length) throw new HttpError(400, 'Which windows?');
      cells = list.map((c) => {
        if (typeof c.starts !== 'string' || !isWindowStart(c.starts)) throw new HttpError(400, `Windows start at ${windowStarts().join(', ')}.`);
        if (c.maxPizzas !== null) {
          const problem = pizzaLimitProblem(c.maxPizzas);
          if (problem) throw new HttpError(400, problem);
        }
        return { starts: c.starts, maxPizzas: c.maxPizzas as number | null };
      });
    }
    for (const c of cells) {
      if (c.maxPizzas === null) await db.query('DELETE FROM pickup_window_days WHERE restaurant_id = $1 AND day = $2 AND starts = $3', [who.restaurantId, day, c.starts]);
      else await db.query('INSERT INTO pickup_window_days (restaurant_id, day, starts, max_pizzas, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (restaurant_id, day, starts) DO UPDATE SET max_pizzas = EXCLUDED.max_pizzas, note = COALESCE(EXCLUDED.note, pickup_window_days.note), updated_at = now(), updated_by = EXCLUDED.updated_by',
        [who.restaurantId, day, c.starts, c.maxPizzas, note, who.staffId]);
    }
    return send(res, 200, { ok: true, saved: cells.length }), true;
  }

  throw new HttpError(404, 'Not found.');
}
