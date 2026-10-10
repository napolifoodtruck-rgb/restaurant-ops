/**
 * The dough count, live from Square, for the kitchen, counter and host iPads.
 *
 *   GET  /api/floor/dough             tonight's counts: dough and gluten-free left, takeout sold and left
 *   POST /api/floor/dough             { count: 'dough' | 'gf' | 'takeout', left: n } what's really left right now: counts on from there
 *                                     or { count, add: ±n } (takeout's quick buttons) or { count, reset: true } back to the weekday's preset
 *   GET  /api/floor/dough/settings    managers: each weekday's presets
 *   POST /api/floor/dough/settings    { doughByWeekday?, gfByWeekday?, takeoutByWeekday?: (n | null)[7], Sunday first }
 *
 * Each night starts from the weekday's preset; the kitchen changes it whenever the real count
 * differs ("38 left", not 30): from then on the night counts down from 38.
 *
 * Reading is open to a front-of-house iPad with no one signed in (its board shows the counts);
 * changing a count needs someone signed in. Square is only read: today's orders, at most once a
 * minute however many iPads ask. When takeout runs out, online ordering stops for the night
 * (onlineCheckout.ts asks takeoutOut); it starts again if the kitchen adds takeout pizzas.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast } from './auth.ts';
import type { FloorContext } from './floor.ts';
import { getModel } from './model.ts';
import { usesRecipe } from '../core/allergens.ts';
import { modifierKey } from '../core/modifiers.ts';
import { doughBoard, takeoutFor, tallyDough, type DoughOf, type DoughTally, type LiveOrder } from '../core/dough.ts';
import type { SquareCheckout } from '../connectors/squareCheckout.ts';

/** Where the live orders come from: the online ordering's Square connection, read only. */
export interface DoughSquare { square: Pick<SquareCheckout, 'ordersSince'>; locationId: string }

const REFRESH_MS = 60_000;
const RULES_MS = 10 * 60_000;

const isGlutenFree = (name: string) => /gluten|\bgf\b/i.test(name);

interface Rules { doughOf: DoughOf; at: number; day: string }
const rulesCache = new Map<string, Rules>();
interface Live { day: string; at: number; tally?: DoughTally; error?: string; pending?: Promise<void> }
const liveCache = new Map<string, Live>();

/** Forget what was read (tests, and a changed recipe choice). */
export function resetDoughCache(restaurantId?: string) {
  if (restaurantId) { rulesCache.delete(restaurantId); liveCache.delete(restaurantId); } else { rulesCache.clear(); liveCache.clear(); }
}

const WEEK_KEYS = { doughByWeekday: 'dough_by_weekday', gfByWeekday: 'gf_by_weekday', takeoutByWeekday: 'takeout_by_weekday' } as const;
type Week = (number | null)[];

/** Each weekday's presets, Sunday first: dough balls, gluten-free crusts, takeout pizzas. */
async function settingsOf(db: Db, rid: string): Promise<Record<keyof typeof WEEK_KEYS, Week>> {
  const r = (await db.query<Record<string, unknown>>('SELECT dough_by_weekday, gf_by_weekday, takeout_by_weekday FROM dough_settings WHERE restaurant_id = $1', [rid])).rows[0];
  const week = (v: unknown): Week => ((v ? (typeof v === 'string' ? JSON.parse(v) : v) : null) as Week | null ?? [null, null, null, null, null, null, null]).map((x) => (x === null ? null : Number(x)));
  return { doughByWeekday: week(r?.dough_by_weekday), gfByWeekday: week(r?.gf_by_weekday), takeoutByWeekday: week(r?.takeout_by_weekday) };
}

/** Tonight's counts where the kitchen changed them. */
async function nightOf(db: Db, rid: string, day: string) {
  const r = (await db.query<{ dough: string | null; gf: string | null; takeout: string | null }>(
    'SELECT dough, gf, takeout FROM dough_nights WHERE restaurant_id = $1 AND day = $2', [rid, day])).rows[0];
  const n = (v: string | null | undefined) => (v === null || v === undefined ? undefined : Number(v));
  return { dough: n(r?.dough), gf: n(r?.gf), takeout: n(r?.takeout) };
}

/**
 * Which items use a dough ball or a gluten-free crust. A dough ball: anything in Square's Pizza
 * category, and the breadsticks (the one dough item outside it). Not by recipe: the focaccia on a
 * side uses some dough, but not a ball, and a new pizza counts before anyone writes its recipe. Rung
 * gluten-free, a pizza or breadsticks takes a gluten-free crust instead; a side of gluten-free bread
 * on anything else (meatballs, ricotta) takes a quarter of one.
 */
async function rulesFor(db: Db, rid: string, today: string): Promise<Rules> {
  const had = rulesCache.get(rid);
  if (had && had.day === today && Date.now() - had.at < RULES_MS) return had;
  const model = await getModel(db, rid, today);
  const recipes = model.book.recipes;
  const gfId = [...recipes.values()].find((r) => /dough|crust/i.test(r.name) && isGlutenFree(r.name))?.id;
  const uses = (recipeId: string | undefined, target: string | undefined) => Boolean(recipeId && target && (recipeId === target || usesRecipe(recipeId, target, recipes)));
  const answers = model.modifierAnswers;
  const addsGf = (key: string) => (answers.adds[key] ?? []).some((a) => a.item.kind === 'recipe' && uses(a.item.id, gfId));
  const categoryOf = await categoriesOf(db, rid, today);
  const cache = new Map<string, ReturnType<DoughOf>>();
  const doughOf: DoughOf = (line) => {
    const k = `${line.catalogId ?? ''}|${line.name}|${line.modifierKeys.join(',')}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const category = (line.catalogId && categoryOf.get(line.catalogId)) || '';
    const dough = /pizza/i.test(category) || BREADSTICKS.test(line.name);
    const gfRung = line.modifierKeys.some((key) => addsGf(key) || isGlutenFree(key.split('|')[1] ?? ''));
    // A dish that's gluten-free as it comes (its own button, or made with the gluten-free dough).
    const recipeId = line.catalogId ? model.lookup(line.catalogId, line.name, today)?.recipeId : undefined;
    const gfDish = isGlutenFree(line.name) || uses(recipeId, gfId);
    const out = dough
      ? (gfRung || gfDish ? { balls: 0, glutenFree: 1 } : { balls: 1, glutenFree: 0 })
      : { balls: 0, glutenFree: gfRung ? 0.25 : gfDish ? 1 : 0 };
    cache.set(k, out);
    return out;
  };
  const rules = { doughOf, at: Date.now(), day: today };
  rulesCache.set(rid, rules);
  return rules;
}

const BREADSTICKS = /bread\s*sticks?/i;

/** Each size's Square category: from the catalog (an item added today has no sales yet), else as last sold. */
async function categoriesOf(db: Db, rid: string, today: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of (await db.query<{ catalog_id: string; category: string | null }>(
    "SELECT DISTINCT ON (catalog_id) catalog_id, category FROM pos_item_sales_daily WHERE restaurant_id = $1 AND catalog_id <> '' AND day >= $2::date - 120 ORDER BY catalog_id, day DESC", [rid, today])).rows) if (r.category) out.set(r.catalog_id, r.category);
  const objects = (await db.query<{ data: any }>("SELECT data FROM pos_catalog WHERE restaurant_id = $1 AND type IN ('ITEM', 'CATEGORY')", [rid])).rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  const names = new Map(objects.filter((o) => o.type === 'CATEGORY').map((o) => [o.id, o.category_data?.name ?? '']));
  for (const o of objects) {
    if (o.type !== 'ITEM') continue;
    const d = o.item_data ?? {};
    const name = names.get(d.reporting_category?.id ?? d.categories?.[0]?.id ?? d.category_id);
    if (name) for (const v of d.variations ?? []) out.set(v.id, name);
  }
  return out;
}

/** Square's orders as the count reads them: ticket, source, and each line with the changes rung on it. */
export async function liveOrders(db: Db, rid: string, square: DoughSquare, since: string): Promise<LiveOrder[]> {
  const raw = await square.square.ordersSince(square.locationId, since);
  // Modifier → its list's name, for the modifier's key ("Crust|Gluten Free").
  const lists = (await db.query<{ data: any }>("SELECT data FROM pos_catalog WHERE restaurant_id = $1 AND type = 'MODIFIER_LIST'", [rid])).rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  const listOf = new Map<string, string>();
  for (const l of lists) for (const m of l.modifier_list_data?.modifiers ?? []) listOf.set(m.id, l.modifier_list_data?.name ?? '');
  return raw.map((o) => ({
    id: String(o.id),
    state: String(o.state ?? ''),
    ...(o.ticket_name ? { ticketName: String(o.ticket_name) } : {}),
    ...(o.source?.name ? { source: String(o.source.name) } : {}),
    lines: (o.line_items ?? []).map((l: any) => ({
      ...(l.catalog_object_id ? { catalogId: String(l.catalog_object_id) } : {}),
      name: String(l.name ?? ''),
      quantity: Number(l.quantity ?? 0),
      modifierKeys: (l.modifiers ?? []).map((m: any) => modifierKey({ listName: (m.catalog_object_id && listOf.get(m.catalog_object_id)) || '', name: String(m.name ?? '') })),
    })),
  }));
}

/** The restaurant's midnight today, as an ISO time. */
export function midnightOf(day: string, timezone: string): string {
  // How far the restaurant's clock is from UTC at a moment, from its own date and time then.
  const offset = (at: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - at;
  };
  const utc = Date.parse(`${day}T00:00:00Z`);
  const first = utc - offset(utc);
  return new Date(utc - offset(first)).toISOString();
}

/** Today's tally, read from Square at most once a minute; the last good one while a read fails. */
async function tallyFor(db: Db, rid: string, today: string, timezone: string, square: DoughSquare | undefined, fresh = false): Promise<Live> {
  let live = liveCache.get(rid);
  if (!live || live.day !== today) { live = { day: today, at: 0 }; liveCache.set(rid, live); }
  if (!square) return { ...live, error: 'Square isn’t connected for live orders.' };
  if (fresh || Date.now() - live.at >= REFRESH_MS) {
    const l = live;
    l.pending ??= (async () => {
      try {
        const rules = await rulesFor(db, rid, today);
        l.tally = tallyDough(await liveOrders(db, rid, square, midnightOf(today, timezone)), rules.doughOf);
        delete l.error;
      } catch (err) {
        console.error(`dough count: couldn’t read today’s orders from Square: ${(err as Error).message}`);
        l.error = 'Couldn’t reach Square just now. Showing the last count.';
      } finally { l.at = Date.now(); delete l.pending; }
    })();
    await l.pending;
  }
  return live;
}

const EMPTY: DoughTally = { used: 0, dineIn: 0, takeout: { online: 0, toGo: 0, total: 0 }, glutenFree: 0, orders: 0 };

/** Tonight's counts, as every board shows them: from the weekday's presets, or where the kitchen changed them. */
export async function doughView(db: Db, rid: string, today: string, timezone: string, square: DoughSquare | undefined, fresh = false) {
  const [settings, night, live] = await Promise.all([settingsOf(db, rid), nightOf(db, rid, today), tallyFor(db, rid, today, timezone, square, fresh)]);
  const preset = { dough: takeoutFor(today, settings.doughByWeekday), gf: takeoutFor(today, settings.gfByWeekday), takeout: takeoutFor(today, settings.takeoutByWeekday) };
  const from = { dough: night.dough ?? preset.dough, gf: night.gf ?? preset.gf, takeout: night.takeout ?? preset.takeout };
  const board = doughBoard({ ...(from.dough !== undefined ? { start: from.dough } : {}), ...(from.gf !== undefined ? { glutenFreeStart: from.gf } : {}), ...(from.takeout !== undefined ? { takeoutCap: from.takeout } : {}), tally: live.tally ?? EMPTY });
  return {
    day: today,
    ...board,
    // The weekday's presets, and which counts the kitchen changed tonight.
    preset,
    changed: { dough: night.dough !== undefined, gf: night.gf !== undefined, takeout: night.takeout !== undefined },
    asOf: live.at ? new Date(live.at).toISOString() : null,
    ...(live.error ? { problem: live.error } : {}),
  };
}

/** No takeout pizzas left tonight: online ordering stops. Never stops it on a failed read. */
export async function takeoutOut(db: Db, rid: string, today: string, timezone: string, square: DoughSquare | undefined): Promise<{ out: boolean; left?: number; asOf?: string }> {
  try {
    // No takeout number tonight: nothing to run out of, and no need to ask Square.
    const [settings, night] = await Promise.all([settingsOf(db, rid), nightOf(db, rid, today)]);
    if (night.takeout === undefined && takeoutFor(today, settings.takeoutByWeekday) === undefined) return { out: false };
    const v = await doughView(db, rid, today, timezone, square);
    // Not read from Square yet, or the last read failed: never closes online ordering on a guess.
    if (!v.asOf || v.problem) return { out: false };
    return { out: v.takeoutOut, ...(v.takeout.left !== undefined ? { left: v.takeout.left } : {}), asOf: v.asOf };
  } catch (err) {
    console.error(`dough count: ${(err as Error).message}`);
    return { out: false };
  }
}

const count = (v: unknown, what: string) => {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 2000) throw new HttpError(400, `${what} is a whole number.`);
  return n;
};

const COUNTS = { dough: 'dough', gf: 'gf', takeout: 'takeout' } as const;
type CountKey = keyof typeof COUNTS;

export async function doughRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: FloorContext, timezone: string, square: DoughSquare | undefined): Promise<boolean> {
  if (path !== '/api/floor/dough' && path !== '/api/floor/dough/settings') return false;
  const rid = ctx.restaurantId, today = ctx.today;

  if (path === '/api/floor/dough') {
    if (method === 'GET') return send(res, 200, await doughView(db, rid, today, timezone, square)), true;
    if (method !== 'POST') throw new HttpError(404, 'Not found.');
    if (!ctx.who) throw new HttpError(401, 'Sign in to change the counts.');
    const b = await body(req);
    if (typeof b.count !== 'string' || !(b.count in COUNTS)) throw new HttpError(400, 'Which count: dough, gluten-free or takeout?');
    const key = b.count as CountKey;
    let from: number | null;
    if (b.reset === true) from = null;
    else {
      // Counted from what's used so far, read fresh from Square, so "38 left" is 38 left now.
      const v = await doughView(db, rid, today, timezone, square, true);
      const used = key === 'dough' ? v.dough.used : key === 'gf' ? v.glutenFree.used : v.takeout.total;
      const left = key === 'dough' ? v.dough.left : key === 'gf' ? v.glutenFree.left : v.takeout.left;
      if ('left' in b) from = used + count(b.left, 'What’s left')!;
      else if ('add' in b) {
        const add = Number(b.add);
        if (!Number.isInteger(add) || Math.abs(add) > 500) throw new HttpError(400, 'Add or take off a whole number.');
        if (left === undefined) throw new HttpError(409, 'There’s no number to change tonight. Type what’s left instead.');
        from = Math.max(used, used + left + add);
      } else throw new HttpError(400, 'Nothing to change.');
    }
    await db.query(`INSERT INTO dough_nights (restaurant_id, day, ${COUNTS[key]}, changed_by, changed_at) VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (restaurant_id, day) DO UPDATE SET ${COUNTS[key]} = EXCLUDED.${COUNTS[key]}, changed_by = EXCLUDED.changed_by, changed_at = now()`, [rid, today, from, ctx.who.staffId]);
    return send(res, 200, await doughView(db, rid, today, timezone, square)), true;
  }

  // Settings: managers.
  if (!ctx.who || !atLeast(ctx.who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  if (method === 'POST') {
    const b = await body(req);
    await db.query('INSERT INTO dough_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [rid]);
    for (const [k, col] of Object.entries(WEEK_KEYS)) {
      if (!(k in b)) continue;
      const v = b[k];
      if (!Array.isArray(v) || v.length !== 7) throw new HttpError(400, 'A number (or none) for each day of the week, Sunday first.');
      await db.query(`UPDATE dough_settings SET ${col} = $2::jsonb, updated_by = $3, updated_at = now() WHERE restaurant_id = $1`, [rid, JSON.stringify(v.map((x) => (x === '' || x === undefined || x === null ? null : count(x, 'Each day’s number')))), ctx.who.staffId]);
    }
  } else if (method !== 'GET') throw new HttpError(404, 'Not found.');
  return send(res, 200, { today, ...(await settingsOf(db, rid)) }), true;
}
