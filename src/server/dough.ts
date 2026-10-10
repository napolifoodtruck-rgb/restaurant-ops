/**
 * The dough count, live from Square, for the kitchen, counter and host iPads.
 *
 *   GET  /api/floor/dough             tonight's counts: dough and gluten-free left, takeout sold and left
 *   POST /api/floor/dough             { leftOver?, made?, gfLeftOver?, gfMade? } the night's start, counted by hand
 *                                     or { takeout: n } / { takeoutAdd: ±n } / { takeoutReset: true } tonight's takeout number
 *   GET  /api/floor/dough/settings    managers: the takeout number for each weekday, tonight's, and which recipes are the doughs
 *   POST /api/floor/dough/settings    { takeoutByWeekday?: (n | null)[7], tonight?: n | null, doughRecipeId?, gfRecipeId? }
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
import { nameKey } from '../core/menuLinks.ts';
import { doughBoard, takeoutFor, tallyDough, type DoughOf, type DoughTally, type LiveOrder } from '../core/dough.ts';
import type { SquareCheckout } from '../connectors/squareCheckout.ts';

/** Where the live orders come from: the online ordering's Square connection, read only. */
export interface DoughSquare { square: Pick<SquareCheckout, 'ordersSince'>; locationId: string }

const REFRESH_MS = 60_000;
const RULES_MS = 10 * 60_000;

const isGlutenFree = (name: string) => /gluten|\bgf\b/i.test(name);
const DOUGH_NAME = /^\s*pizza dough\s*$/i;

interface Rules { doughId?: string; gfId?: string; doughOf: DoughOf; at: number; day: string }
const rulesCache = new Map<string, Rules>();
interface Live { day: string; at: number; tally?: DoughTally; error?: string; pending?: Promise<void> }
const liveCache = new Map<string, Live>();

/** Forget what was read (tests, and a changed recipe choice). */
export function resetDoughCache(restaurantId?: string) {
  if (restaurantId) { rulesCache.delete(restaurantId); liveCache.delete(restaurantId); } else { rulesCache.clear(); liveCache.clear(); }
}

async function settingsOf(db: Db, rid: string) {
  const r = (await db.query<{ dough_recipe_id: string | null; gf_recipe_id: string | null; takeout_by_weekday: unknown }>(
    'SELECT dough_recipe_id, gf_recipe_id, takeout_by_weekday FROM dough_settings WHERE restaurant_id = $1', [rid])).rows[0];
  const week = (r ? (typeof r.takeout_by_weekday === 'string' ? JSON.parse(r.takeout_by_weekday) : r.takeout_by_weekday) : null) as (number | null)[] | null;
  return { doughRecipeId: r?.dough_recipe_id ?? null, gfRecipeId: r?.gf_recipe_id ?? null, takeoutByWeekday: (week ?? [null, null, null, null, null, null, null]).map((v) => (v === null ? null : Number(v))) };
}

async function nightOf(db: Db, rid: string, day: string) {
  const r = (await db.query<{ left_over: number | null; made: number | null; gf_left_over: number | null; gf_made: number | null; takeout: number | null; start_at: Date | null; takeout_at: Date | null }>(
    'SELECT left_over, made, gf_left_over, gf_made, takeout, start_at, takeout_at FROM dough_nights WHERE restaurant_id = $1 AND day = $2', [rid, day])).rows[0];
  const n = (v: number | null | undefined) => (v === null || v === undefined ? undefined : Number(v));
  return { leftOver: n(r?.left_over), made: n(r?.made), gfLeftOver: n(r?.gf_left_over), gfMade: n(r?.gf_made), takeout: n(r?.takeout) };
}

/**
 * Which items use a dough ball or a gluten-free crust, from the recipes: anything whose recipe uses
 * the dough (or the gluten-free dough), and the changes that swap one for the other.
 */
async function rulesFor(db: Db, rid: string, today: string): Promise<Rules> {
  const had = rulesCache.get(rid);
  if (had && had.day === today && Date.now() - had.at < RULES_MS) return had;
  const settings = await settingsOf(db, rid);
  const model = await getModel(db, rid, today);
  const recipes = model.book.recipes;
  const all = [...recipes.values()];
  const doughId = settings.doughRecipeId ?? all.find((r) => DOUGH_NAME.test(r.name))?.id ?? all.find((r) => /dough/i.test(r.name) && !isGlutenFree(r.name))?.id;
  const gfId = settings.gfRecipeId ?? all.find((r) => /dough|crust/i.test(r.name) && isGlutenFree(r.name))?.id;
  const uses = (recipeId: string | undefined, target: string | undefined) => Boolean(recipeId && target && (recipeId === target || usesRecipe(recipeId, target, recipes)));
  const answers = model.modifierAnswers;
  const addsGf = (key: string) => (answers.adds[key] ?? []).some((a) => a.item.kind === 'recipe' && uses(a.item.id, gfId));
  const takesDough = (recipeId: string, key: string) => {
    const r = answers.removes[`${recipeId}|${key}`] ?? answers.removes[`*|${key}`];
    return Boolean(r && r.kind === 'recipe' && uses(recipeId, r.id) && uses(r.id, doughId));
  };
  const byName = new Map(all.filter((r) => r.kind !== 'prep').map((r) => [nameKey(r.name), r.id]));
  // Each item's Square category, as last sold; the categories that sell dough items.
  const categoryOf = new Map((await db.query<{ catalog_id: string; item_name: string; category: string | null }>(
    "SELECT DISTINCT ON (catalog_id) catalog_id, item_name, category FROM pos_item_sales_daily WHERE restaurant_id = $1 AND catalog_id <> '' AND day >= $2::date - 120 ORDER BY catalog_id, day DESC", [rid, today])).rows
    .map((r) => [r.catalog_id, { name: r.item_name, category: r.category ?? '' }]));
  const doughCategories = new Set([...categoryOf].filter(([id, x]) => uses(model.lookup(id, x.name, today)?.recipeId ?? byName.get(nameKey(x.name)), doughId)).map(([, x]) => x.category).filter(Boolean));
  const cache = new Map<string, ReturnType<DoughOf>>();
  const doughOf: DoughOf = (line) => {
    const k = `${line.catalogId ?? ''}|${line.name}|${line.modifierKeys.join(',')}`;
    const hit = cache.get(k);
    if (hit) return hit;
    // Linked to its recipe on Menu; else a recipe of the very same name (a special rung tonight, not linked yet).
    const recipeId = (line.catalogId ? model.lookup(line.catalogId, line.name, today)?.recipeId : undefined) ?? byName.get(nameKey(line.name));
    let out: ReturnType<DoughOf> = { balls: 0, glutenFree: 0 };
    const gfRung = line.modifierKeys.some((key) => addsGf(key) || isGlutenFree(key.split('|')[1] ?? ''));
    if (recipeId) {
      const dough = uses(recipeId, doughId);
      const swapped = dough && (gfRung || line.modifierKeys.some((key) => takesDough(recipeId, key)));
      out = { balls: dough && !swapped ? 1 : 0, glutenFree: uses(recipeId, gfId) || swapped ? 1 : 0 };
    } else {
      // No recipe yet: a pizza by its Square category still takes a ball; something else sold beside the dough items is flagged.
      const category = (line.catalogId && categoryOf.get(line.catalogId)?.category) || '';
      if (/pizza/i.test(category)) out = { balls: gfRung ? 0 : 1, glutenFree: gfRung ? 1 : 0, guessed: true };
      else if (category && doughCategories.has(category)) out = { balls: 0, glutenFree: 0, unknown: true };
    }
    cache.set(k, out);
    return out;
  };
  const rules = { ...(doughId ? { doughId } : {}), ...(gfId ? { gfId } : {}), doughOf, at: Date.now(), day: today };
  rulesCache.set(rid, rules);
  return rules;
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

const EMPTY: DoughTally = { used: 0, dineIn: 0, takeout: { online: 0, toGo: 0, total: 0 }, glutenFree: 0, orders: 0, guessed: {}, notCounted: {} };

/** Tonight's counts, as every board shows them. */
export async function doughView(db: Db, rid: string, today: string, timezone: string, square: DoughSquare | undefined, fresh = false) {
  const [settings, night, live] = await Promise.all([settingsOf(db, rid), nightOf(db, rid, today), tallyFor(db, rid, today, timezone, square, fresh)]);
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const start = sum(night.leftOver, night.made), gfStart = sum(night.gfLeftOver, night.gfMade);
  const planned = takeoutFor(today, settings.takeoutByWeekday);
  const cap = takeoutFor(today, settings.takeoutByWeekday, night.takeout);
  const board = doughBoard({ ...(start !== undefined ? { start } : {}), ...(gfStart !== undefined ? { glutenFreeStart: gfStart } : {}), ...(cap !== undefined ? { takeoutCap: cap } : {}), tally: live.tally ?? EMPTY });
  return {
    day: today,
    ...board,
    night: { ...night, ...(planned !== undefined ? { planned } : {}), changed: night.takeout !== undefined && night.takeout !== planned },
    // For managers to fix on Menu: items with no recipe, counted by category or not at all.
    ...(Object.keys(live.tally?.guessed ?? {}).length || Object.keys(live.tally?.notCounted ?? {}).length ? { check: { guessed: live.tally!.guessed, notCounted: live.tally!.notCounted } } : {}),
    asOf: live.at ? new Date(live.at).toISOString() : null,
    ...(live.error ? { problem: live.error } : {}),
  };
}

/** No takeout pizzas left tonight: online ordering stops. Never stops it on a failed read. */
export async function takeoutOut(db: Db, rid: string, today: string, timezone: string, square: DoughSquare | undefined): Promise<{ out: boolean; left?: number; asOf?: string }> {
  try {
    // No takeout number tonight: nothing to run out of, and no need to ask Square.
    const [settings, night] = await Promise.all([settingsOf(db, rid), nightOf(db, rid, today)]);
    if (takeoutFor(today, settings.takeoutByWeekday, night.takeout) === undefined) return { out: false };
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

export async function doughRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: FloorContext, timezone: string, square: DoughSquare | undefined): Promise<boolean> {
  if (path !== '/api/floor/dough' && path !== '/api/floor/dough/settings') return false;
  const rid = ctx.restaurantId, today = ctx.today;

  if (path === '/api/floor/dough') {
    if (method === 'GET') return send(res, 200, await doughView(db, rid, today, timezone, square)), true;
    if (method !== 'POST') throw new HttpError(404, 'Not found.');
    if (!ctx.who) throw new HttpError(401, 'Sign in to change the counts.');
    const b = await body(req);
    const staff = ctx.who.staffId;
    await db.query('INSERT INTO dough_nights (restaurant_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rid, today]);
    const startKeys = { leftOver: 'left_over', made: 'made', gfLeftOver: 'gf_left_over', gfMade: 'gf_made' } as const;
    const startChanges = Object.entries(startKeys).filter(([k]) => k in b);
    for (const [k, col] of startChanges) await db.query(`UPDATE dough_nights SET ${col} = $3, start_by = $4, start_at = now() WHERE restaurant_id = $1 AND day = $2`, [rid, today, count(b[k], 'A count'), staff]);
    let takeout: number | null | undefined;
    if (b.takeoutReset === true) takeout = null;
    else if ('takeout' in b) takeout = count(b.takeout, 'Takeout pizzas');
    else if ('takeoutAdd' in b) {
      const add = Number(b.takeoutAdd);
      if (!Number.isInteger(add) || Math.abs(add) > 500) throw new HttpError(400, 'Add or take off a whole number of pizzas.');
      const v = await doughView(db, rid, today, timezone, square);
      if (v.takeout.cap === undefined) throw new HttpError(409, 'There’s no takeout number tonight. A manager sets one in Settings, or type one in.');
      takeout = Math.max(0, v.takeout.cap + add);
    }
    if (takeout !== undefined) await db.query('UPDATE dough_nights SET takeout = $3, takeout_by = $4, takeout_at = now() WHERE restaurant_id = $1 AND day = $2', [rid, today, takeout, staff]);
    if (!startChanges.length && takeout === undefined) throw new HttpError(400, 'Nothing to change.');
    return send(res, 200, await doughView(db, rid, today, timezone, square, takeout !== undefined)), true;
  }

  // Settings: managers.
  if (!ctx.who || !atLeast(ctx.who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  if (method === 'POST') {
    const b = await body(req);
    await db.query('INSERT INTO dough_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [rid]);
    if ('takeoutByWeekday' in b) {
      if (!Array.isArray(b.takeoutByWeekday) || b.takeoutByWeekday.length !== 7) throw new HttpError(400, 'A number (or none) for each day of the week, Sunday first.');
      await db.query('UPDATE dough_settings SET takeout_by_weekday = $2::jsonb, updated_by = $3, updated_at = now() WHERE restaurant_id = $1', [rid, JSON.stringify(b.takeoutByWeekday.map((v) => (v === '' || v === undefined ? null : count(v, 'Takeout pizzas')))), ctx.who.staffId]);
    }
    for (const [k, col] of [['doughRecipeId', 'dough_recipe_id'], ['gfRecipeId', 'gf_recipe_id']] as const) {
      if (!(k in b)) continue;
      const id = b[k];
      if (id !== null && (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new HttpError(400, 'Pick a recipe.');
      await db.query(`UPDATE dough_settings SET ${col} = $2, updated_by = $3, updated_at = now() WHERE restaurant_id = $1`, [rid, id, ctx.who.staffId]);
      rulesCache.delete(rid);
      liveCache.delete(rid);
    }
    if ('tonight' in b) {
      await db.query('INSERT INTO dough_nights (restaurant_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rid, today]);
      await db.query('UPDATE dough_nights SET takeout = $3, takeout_by = $4, takeout_at = now() WHERE restaurant_id = $1 AND day = $2', [rid, today, count(b.tonight, 'Takeout pizzas'), ctx.who.staffId]);
    }
  } else if (method !== 'GET') throw new HttpError(404, 'Not found.');
  const settings = await settingsOf(db, rid);
  const rules = await rulesFor(db, rid, today);
  const model = await getModel(db, rid, today);
  const doughs = [...model.book.recipes.values()].filter((r) => /dough|crust/i.test(r.name)).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name));
  const night = await nightOf(db, rid, today);
  return send(res, 200, { today, ...settings, doughRecipeId: rules.doughId ?? null, gfRecipeId: rules.gfId ?? null, chosen: { dough: settings.doughRecipeId !== null, gf: settings.gfRecipeId !== null }, doughs, tonight: night.takeout ?? null }), true;
}
