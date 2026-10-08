/**
 * Online ordering settings over HTTP. Managers only: what's sold online, and how many pizzas each
 * pickup window takes. Anyone signed in can pause online orders when the kitchen is slammed.
 * Customers order through onlineCheckout.ts.
 *
 *   GET  /api/online/pause                     whether online orders are paused, and whether any are being taken tonight
 *   POST /api/online/pause                     { minutes: 15 | 30 | 60 } or { tonight: true } or { resume: true }
 *   GET  /api/online/menu                      every Square item with its online settings, in menu order, how many sold in 30 days, and problems that would stop an order
 *   POST /api/online/arrange                   { categories: [name…], items: [itemId…] } the online menu's order, as dragged
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
import { MODIFIER_MODES, arranged, modifierProblems, onlineMenu, type CatalogObject, type ModifierMode, type OnlineMenuItem } from '../core/onlineMenu.ts';
import { LAST_WINDOW_ENDS, isWindowStart, pizzaLimitProblem, stillOpen, windowStarts, windowsFor, type DayCell, type PickupWindow, type PlanCell } from '../core/pickupWindows.ts';
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

/**
 * Every Square item with its online settings, in the order a manager arranged, as of the last catalog sync, with any objects just
 * read from Square (`fresh`) in place of their copies. Sold out, prices and stock counting are
 * as at `locationId` (default: the location the nightly sync reads).
 */
export async function loadOnlineMenu(db: Db, restaurantId: string, today: string, options: { fresh?: readonly CatalogObject[]; locationId?: string } = {}): Promise<{ menu: OnlineMenuItem[]; synced: boolean }> {
  const copy = (await db.query<{ data: CatalogObject }>('SELECT data FROM pos_catalog WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as CatalogObject);
  const fresh = new Map((options.fresh ?? []).map((o) => [o.id, o]));
  const catalog = copy.map((o) => fresh.get(o.id) ?? o);
  const items = (await db.query<{ item_id: string; published: boolean; counts_as_pizza: boolean | null; sold_out_on: string | null; position: number | null }>('SELECT item_id, published, counts_as_pizza, sold_out_on::text AS sold_out_on, position FROM online_items WHERE restaurant_id = $1', [restaurantId])).rows;
  const categoryOrder = (await db.query<{ name: string }>('SELECT name FROM online_categories WHERE restaurant_id = $1 ORDER BY position', [restaurantId])).rows.map((r) => r.name);
  const modes = Object.fromEntries((await db.query<{ modifier_id: string; mode: ModifierMode }>('SELECT modifier_id, mode FROM online_modifiers WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.modifier_id, r.mode]));
  // Without a location given, the one the nightly sync reads.
  const locationId = options.locationId ?? (await db.query<{ pos_location_id: string | null }>('SELECT pos_location_id FROM restaurants WHERE id = $1', [restaurantId])).rows[0]?.pos_location_id ?? undefined;
  const menu = arranged(onlineMenu(catalog, items.map((r) => ({ itemId: r.item_id, published: r.published, ...(r.counts_as_pizza !== null ? { countsAsPizza: r.counts_as_pizza } : {}), ...(r.sold_out_on ? { soldOutOn: r.sold_out_on } : {}), ...(r.position !== null ? { position: Number(r.position) } : {}) })), modes, today, locationId), categoryOrder);
  return { menu, synced: copy.length > 0 };
}

/** The windows of a date, with the pizzas already in paid orders and live holds. */
export async function loadWindows(db: Db, restaurantId: string, day: string, exceptOrder?: string): Promise<PickupWindow[]> {
  const taken = Object.fromEntries((await db.query<{ starts: string; pizzas: string }>(
    // Orders from before windows were 15 minutes (5:20, 5:40) count in the window their time falls in.
    "SELECT (time '00:00' + floor(extract(epoch FROM window_starts) / 900) * interval '15 minutes')::text AS starts, sum(pizzas)::text AS pizzas FROM online_orders WHERE restaurant_id = $1 AND day = $2 AND (status = 'paid' OR (status = 'held' AND hold_until > now())) AND id <> $3 GROUP BY 1",
    [restaurantId, day, exceptOrder ?? '00000000-0000-0000-0000-000000000000'])).rows.map((r) => [hhmm(r.starts), Number(r.pizzas)]));
  return windowsFor(day, await loadPlan(db, restaurantId), await loadDay(db, restaurantId, day), taken);
}

export interface Pause {
  /** When it ends, as an ISO time. */
  until: string;
  /** The restaurant's time it ends (HH:MM). */
  untilTime: string;
  /** For the rest of tonight, not a few minutes. */
  tonight: boolean;
  /** Turned off until someone turns it back on (until and untilTime are then empty). */
  off: boolean;
}

export const PAUSE_MINUTES = [15, 30, 60];

/** The pause on online orders, while it lasts. */
export async function loadPause(db: Db, restaurantId: string, timezone: string): Promise<Pause | undefined> {
  const r = (await db.query<{ until: Date | string; off: boolean }>("SELECT until, until = 'infinity' AS off FROM online_pause WHERE restaurant_id = $1 AND until > now()", [restaurantId])).rows[0];
  if (!r) return undefined;
  if (r.off) return { until: '', untilTime: '', tonight: true, off: true };
  const until = new Date(r.until);
  const now = localNow(timezone);
  const end = localNow(timezone, until);
  return { until: until.toISOString(), untilTime: end.time, tonight: end.date !== now.date || end.time >= LAST_WINDOW_ENDS, off: false };
}

/**
 * The notice in the dark box at the top of the menu, until a manager writes their own. The first line
 * is shown bold; a blank line starts the smaller paragraph under it.
 */
export const NOTICE_DEFAULT = [
  'Every online pizza is partially cooked.',
  'You finish it in your own oven at home, just before eating, so it tastes the way it does here. True Neapolitan pizza is ruined within minutes in a closed box.',
  '',
  'Fully cooked pizzas and gluten-sensitive crust are in person only: come by or call, usually under 8 minutes.',
].join('\n');
export const NOTICE_MAX = 600;

/** The "Why partially cooked?" panel, until a manager writes their own. A blank line starts a paragraph. */
export const WHY_PARTIAL_DEFAULT = [
  'Neapolitan pizza is soft, thin in the middle and at its best within minutes of leaving the oven. Closed in a box on the way home, it steams and goes soggy.',
  '',
  'So every pizza we sell online leaves our oven partially cooked. You finish it in your own oven just before eating, and it comes out crisp and hot, the way it does here.',
  '',
  'Fully cooked pizzas and gluten-sensitive crust are available in person only: come by or call, usually under 8 minutes.',
].join('\n');
export const WHY_PARTIAL_MAX = 2000;

/** The "Do you have gluten-free?" panel, until a manager writes their own. A blank line starts a paragraph. */
export const GLUTEN_FREE_DEFAULT = [
  'We make a gluten-sensitive crust, but it isn’t sold online.',
  '',
  'Come by or call to order it in person, usually under 8 minutes.',
].join('\n');
export const GLUTEN_FREE_MAX = 2000;

/** The order page's own content, as customers get it: the header photo's address (null: none), the notice, the "why" and "gluten-free" panels. */
export async function loadOrderPage(db: Db, restaurantId: string): Promise<{ headerImage: string | null; notice: string; noticeChanged: boolean; whyPartial: string; whyPartialChanged: boolean; glutenFree: string; glutenFreeChanged: boolean }> {
  const r = (await db.query<{ notice_text: string | null; why_partial_text: string | null; gluten_free_text: string | null; has_image: boolean; image_at: Date | null }>('SELECT notice_text, why_partial_text, gluten_free_text, header_image IS NOT NULL AS has_image, header_image_updated_at AS image_at FROM online_page WHERE restaurant_id = $1', [restaurantId])).rows[0];
  return {
    headerImage: r?.has_image ? `/api/order/header-image?v=${r.image_at ? new Date(r.image_at).getTime() : 0}` : null,
    notice: r?.notice_text ?? NOTICE_DEFAULT, noticeChanged: r?.notice_text != null,
    whyPartial: r?.why_partial_text ?? WHY_PARTIAL_DEFAULT, whyPartialChanged: r?.why_partial_text != null,
    glutenFree: r?.gluten_free_text ?? GLUTEN_FREE_DEFAULT, glutenFreeChanged: r?.gluten_free_text != null,
  };
}

/** Words a manager typed for the order page: spaces tidied, at most one blank line in a row. */
const tidyWords = (v: string): string => v.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

export async function onlineRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, url: URL, who: SignedIn, timezone: string): Promise<boolean> {
  if (!path.startsWith('/api/online/')) return false;
  const method = req.method ?? 'GET';
  const now = localNow(timezone);

  // Anyone on shift can pause: it's the cooks who see the slam coming.
  if (path === '/api/online/pause') {
    if (method === 'POST') {
      const b = await body(req);
      if (b.resume === true) await db.query('DELETE FROM online_pause WHERE restaurant_id = $1', [who.restaurantId]);
      else {
        if (b.off !== true && b.tonight !== true && !PAUSE_MINUTES.includes(b.minutes as number)) throw new HttpError(400, `Pause for ${PAUSE_MINUTES.join(', ')} minutes or the rest of tonight, or turn online orders off.`);
        // "The rest of tonight" runs to midnight, the restaurant's time; "off" lasts until someone turns them back on.
        await db.query(`INSERT INTO online_pause (restaurant_id, until, paused_by)
          VALUES ($1, CASE WHEN $7::boolean THEN 'infinity'::timestamptz WHEN $2::boolean THEN ($3::date + 1)::timestamp AT TIME ZONE $4 ELSE now() + make_interval(mins => $5::int) END, $6)
          ON CONFLICT (restaurant_id) DO UPDATE SET until = EXCLUDED.until, paused_by = EXCLUDED.paused_by, paused_at = now()`,
        [who.restaurantId, b.tonight === true, now.date, timezone, b.tonight === true || b.off === true ? 0 : b.minutes, who.staffId, b.off === true]);
      }
    } else if (method !== 'GET') throw new HttpError(404, 'Not found.');
    const windows = await loadWindows(db, who.restaurantId, now.date);
    return send(res, 200, { now: now.time, paused: (await loadPause(db, who.restaurantId, timezone)) ?? null, takingOrders: windows.some((w) => stillOpen(w, now.time)) }), true;
  }

  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/online/menu') {
    const { menu, synced } = await loadOnlineMenu(db, who.restaurantId, now.date);
    // How many of each sold in the last 30 days, everywhere: for arranging the menu.
    const sold = new Map((await db.query<{ catalog_id: string; quantity: string }>('SELECT catalog_id, sum(quantity)::text AS quantity FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day >= $2 GROUP BY catalog_id', [who.restaurantId, addDays(now.date, -30)])).rows.map((r) => [r.catalog_id, Number(r.quantity)]));
    return send(res, 200, { today: now.date, synced, items: menu.map((x) => ({ ...x, sold30: Math.round(x.variations.reduce((n, v) => n + (sold.get(v.id) ?? 0), 0)), problems: x.published ? modifierProblems(x) : [] })) }), true;
  }

  if (method === 'POST' && path === '/api/online/arrange') {
    const b = await body(req);
    const strings = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200) ? (v as string[]) : undefined);
    const categories = strings(b.categories, 200);
    const items = strings(b.items, 2000);
    if (!categories || !items) throw new HttpError(400, 'Send the categories and items in their new order.');
    await db.query('DELETE FROM online_categories WHERE restaurant_id = $1', [who.restaurantId]);
    await db.query('INSERT INTO online_categories (restaurant_id, name, position) SELECT $1, name, ord::int FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS t(name, ord) ON CONFLICT DO NOTHING', [who.restaurantId, JSON.stringify(categories)]);
    await db.query('UPDATE online_items o SET position = t.ord::int FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS t(item_id, ord) WHERE o.restaurant_id = $1 AND o.item_id = t.item_id', [who.restaurantId, JSON.stringify(items)]);
    return send(res, 200, { ok: true }), true;
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

  // The order page: a header photo (a JPEG, PNG or WebP under 3 MB; null takes it off), the notice, and the "Why partially cooked?" and "Do you have gluten-free?" texts (null or '': back to the usual words).
  if (path === '/api/online/page') {
    if (method === 'POST') {
      const b = await body(req, 5 * 1024 * 1024);
      await db.query('INSERT INTO online_page (restaurant_id, updated_by) VALUES ($1, $2) ON CONFLICT (restaurant_id) DO NOTHING', [who.restaurantId, who.staffId]);
      if (b.notice !== undefined) {
        if (b.notice !== null && typeof b.notice !== 'string') throw new HttpError(400, 'The notice is words, or nothing.');
        const text = typeof b.notice === 'string' ? tidyWords(b.notice) : '';
        if (text.length > NOTICE_MAX) throw new HttpError(400, `Keep the notice under ${NOTICE_MAX} characters.`);
        await db.query('UPDATE online_page SET notice_text = $2, updated_at = now(), updated_by = $3 WHERE restaurant_id = $1', [who.restaurantId, text && text !== NOTICE_DEFAULT ? text : null, who.staffId]);
      }
      if (b.whyPartial !== undefined) {
        if (b.whyPartial !== null && typeof b.whyPartial !== 'string') throw new HttpError(400, 'The "why partially cooked" text is words, or nothing.');
        const text = typeof b.whyPartial === 'string' ? tidyWords(b.whyPartial) : '';
        if (text.length > WHY_PARTIAL_MAX) throw new HttpError(400, `Keep the "why partially cooked" text under ${WHY_PARTIAL_MAX} characters.`);
        await db.query('UPDATE online_page SET why_partial_text = $2, updated_at = now(), updated_by = $3 WHERE restaurant_id = $1', [who.restaurantId, text && text !== WHY_PARTIAL_DEFAULT ? text : null, who.staffId]);
      }
      if (b.glutenFree !== undefined) {
        if (b.glutenFree !== null && typeof b.glutenFree !== 'string') throw new HttpError(400, 'The "gluten-free" text is words, or nothing.');
        const text = typeof b.glutenFree === 'string' ? tidyWords(b.glutenFree) : '';
        if (text.length > GLUTEN_FREE_MAX) throw new HttpError(400, `Keep the "gluten-free" text under ${GLUTEN_FREE_MAX} characters.`);
        await db.query('UPDATE online_page SET gluten_free_text = $2, updated_at = now(), updated_by = $3 WHERE restaurant_id = $1', [who.restaurantId, text && text !== GLUTEN_FREE_DEFAULT ? text : null, who.staffId]);
      }
      if (b.headerImage !== undefined) {
        if (b.headerImage === null) await db.query('UPDATE online_page SET header_image = NULL, header_image_type = NULL, header_image_updated_at = now(), updated_at = now(), updated_by = $2 WHERE restaurant_id = $1', [who.restaurantId, who.staffId]);
        else {
          const m = typeof b.headerImage === 'string' ? b.headerImage.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
          if (!m) throw new HttpError(400, 'Use a JPEG, PNG or WebP photo.');
          if (m[2]!.length > 4_000_000) throw new HttpError(400, 'Use a photo under 3 MB.');
          await db.query('UPDATE online_page SET header_image = decode($2, \'base64\'), header_image_type = $3, header_image_updated_at = now(), updated_at = now(), updated_by = $4 WHERE restaurant_id = $1', [who.restaurantId, m[2], m[1], who.staffId]);
        }
      }
    } else if (method !== 'GET') throw new HttpError(404, 'Not found.');
    return send(res, 200, await loadOrderPage(db, who.restaurantId)), true;
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
