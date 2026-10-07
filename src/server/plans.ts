/**
 * Dishes coming to the menu, planned before they sell. A plan names the dish, its start day,
 * its recipe card (if there is one yet) and the dish it replaces. The app works out which
 * preps it needs and where they'd go, and which of the old dish's preps nothing else uses;
 * a chef applies it, and the station lists change on the right days.
 *
 *   GET  /api/plans                 plans with what applying each would do
 *   POST /api/plans                 { name, startsOn, recipeName?, replaces?, section?, note? }
 *   POST /api/plans/:id             { cancel: true }
 *   POST /api/plans/:id/apply       { add: [{ recipeName, stationId, unit?, par? }], end: [stationItemId] }
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, type Model } from './model.ts';
import { onMenu } from '../core/menu.ts';

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface PlanRow { id: string; name: string; recipe_name: string | null; section: string | null; starts_on: string; replaces: string | null; note: string | null; status: string }
interface StationItemRow { id: string; name: string; station_id: string; station: string; recipe_name: string | null; unit: string | null; par: string | null; active_until: string | null }

/** The prep recipes a dish uses directly. */
function prepsOf(model: Model, recipeName: string | undefined): string[] {
  const dish = model.recipes.find((r) => r.name === recipeName);
  if (!dish) return [];
  return [...new Set(dish.ingredients.filter((i) => i.item.kind === 'recipe').map((i) => model.book.recipes.get(i.item.id)?.name).filter((n): n is string => Boolean(n)))];
}

/** What applying a plan would do: preps to add (and where), preps the replaced dish alone used. */
function proposal(model: Model, plan: PlanRow, stationItems: StationItemRow[], stations: { id: string; name: string }[]) {
  const live = stationItems.filter((s) => !s.active_until || s.active_until >= plan.starts_on);
  const preps = prepsOf(model, plan.recipe_name ?? undefined).map((recipe) => {
    const on = live.filter((s) => s.recipe_name === recipe);
    return { recipe, onStations: on.map((s) => ({ station: s.station, item: s.name })) };
  });
  // Where the dish's other preps live is the likeliest station for a new one.
  const homes = new Map<string, number>();
  for (const p of preps) for (const s of live.filter((x) => x.recipe_name === p.recipe)) homes.set(s.station_id, (homes.get(s.station_id) ?? 0) + 1);
  // Otherwise, the station named like the dish's section (a pizza's preps go to Pizza).
  const section = (plan.section ?? model.margins.dishes.find((d) => model.book.recipes.get(d.recipeId)?.name === plan.recipe_name || d.name === plan.replaces)?.category ?? '').toLowerCase();
  const bySection = stations.find((s) => section && (s.name.toLowerCase().includes(section) || section.includes(s.name.toLowerCase())))?.id;
  const likelyStation = [...homes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? bySection ?? stations[0]?.id;

  // The replaced dish: its sales, and the preps nothing else on the menu (or the new dish) uses.
  let replaced: { name: string; soldPerDay?: number; exclusive: { recipe: string; items: { id: string; station: string; item: string }[] }[] } | undefined;
  if (plan.replaces) {
    const margin = model.margins.dishes.find((d) => d.name === plan.replaces);
    const recipe = margin ? model.book.recipes.get(margin.recipeId)?.name : model.recipes.find((r) => r.name === plan.replaces)?.name;
    const others = onMenu(model.entries, model.today).filter((e) => e.recipeId && model.book.recipes.get(e.recipeId)?.name !== recipe).map((e) => model.book.recipes.get(e.recipeId!)?.name);
    const stillUsed = new Set([...others.flatMap((n) => prepsOf(model, n)), ...preps.map((p) => p.recipe)]);
    const openDays = new Set(model.sales.filter((l) => l.date && l.quantity > 0).map((l) => l.date)).size || 1;
    replaced = {
      name: plan.replaces,
      ...(margin ? { soldPerDay: Math.round((margin.quantity / openDays) * 10) / 10 } : {}),
      exclusive: prepsOf(model, recipe).filter((p) => !stillUsed.has(p)).map((p) => ({ recipe: p, items: live.filter((s) => s.recipe_name === p).map((s) => ({ id: s.id, station: s.station, item: s.name })) })),
    };
  }
  return { preps, likelyStation, ...(replaced ? { replaced } : {}) };
}

export async function planRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, method: string, who: SignedIn, today: string): Promise<boolean> {
  if (!path.startsWith('/api/plans')) return false;
  if (!atLeast(who.roleLevel, 'chef')) throw new HttpError(403, 'A chef or manager plans the menu.');
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/plans') {
    const model = await getModel(db, who.restaurantId, today);
    const plans = (await db.query<PlanRow>("SELECT id, name, recipe_name, section, starts_on::text AS starts_on, replaces, note, status FROM menu_plans WHERE restaurant_id = $1 AND status <> 'cancelled' AND (status = 'planned' OR starts_on >= $2) ORDER BY starts_on", [who.restaurantId, addDays(today, -14)])).rows;
    const stations = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND active ORDER BY sort_order', [who.restaurantId])).rows;
    const stationItems = (await db.query<StationItemRow>('SELECT i.id, i.name, i.station_id, s.name AS station, i.recipe_name, i.unit, i.par, i.active_until::text AS active_until FROM station_items i JOIN stations s ON s.id = i.station_id WHERE i.restaurant_id = $1 AND i.active', [who.restaurantId])).rows;
    const current = [...new Set(model.margins.dishes.filter((d) => (model.sales.some((l) => l.date && l.date >= addDays(today, -7) && model.lookup(l.catalogId, l.name, l.date)?.recipeId === d.recipeId))).map((d) => d.name))].sort();
    return send(res, 200, {
      today,
      stations,
      dishCards: model.recipes.filter((r) => r.kind === 'dish').map((r) => r.name).sort(),
      currentDishes: current,
      plans: plans.map((p) => ({ id: p.id, name: p.name, recipeName: p.recipe_name, section: p.section, startsOn: p.starts_on, replaces: p.replaces, note: p.note, status: p.status, ...(p.status === 'planned' ? { proposal: proposal(model, p, stationItems, stations) } : {}) })),
    }), true;
  }

  if (method === 'POST' && path === '/api/plans') {
    const b = await body(req);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new HttpError(400, 'Name the dish.');
    if (typeof b.startsOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.startsOn)) throw new HttpError(400, 'Pick a start date.');
    const opt = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
    const r = await db.query<{ id: string }>('INSERT INTO menu_plans (restaurant_id, name, recipe_name, section, starts_on, replaces, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [who.restaurantId, b.name.trim(), opt('recipeName'), opt('section'), b.startsOn, opt('replaces'), opt('note'), who.staffId]);
    return send(res, 201, { id: r.rows[0]!.id }), true;
  }

  if ((m = path.match(/^\/api\/plans\/([0-9a-f-]{36})$/)) && method === 'POST') {
    const b = await body(req);
    if (b.cancel === true) await db.query("UPDATE menu_plans SET status = 'cancelled' WHERE restaurant_id = $1 AND id = $2", [who.restaurantId, m[1]]);
    return send(res, 200, { ok: true }), true;
  }

  if ((m = path.match(/^\/api\/plans\/([0-9a-f-]{36})\/apply$/)) && method === 'POST') {
    const plan = (await db.query<PlanRow>('SELECT id, name, recipe_name, section, starts_on::text AS starts_on, replaces, note, status FROM menu_plans WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, m[1]])).rows[0];
    if (!plan) throw new HttpError(404, 'No such plan.');
    if (plan.status !== 'planned') throw new HttpError(409, 'This plan was already applied or cancelled.');
    const b = await body(req);
    const add = Array.isArray(b.add) ? (b.add as Record<string, unknown>[]) : [];
    const end = Array.isArray(b.end) ? (b.end as unknown[]).map(String) : [];
    for (const a of add) if (typeof a.recipeName !== 'string' || typeof a.stationId !== 'string') throw new HttpError(400, 'Each prep needs a recipe and a station.');
    // Claimed first: applied from two devices at once, only one adds the preps.
    const claimed = await db.query("UPDATE menu_plans SET status = 'applied' WHERE restaurant_id = $1 AND id = $2 AND status = 'planned' RETURNING id", [who.restaurantId, plan.id]);
    if (!claimed.rows.length) throw new HttpError(409, 'This plan was already applied or cancelled.');
    try {
    // New preps go on the list the day before the dish starts; the replaced dish's own preps are last made the day before.
    const from = addDays(plan.starts_on, -1);
    for (const a of add) {
      if (typeof a.recipeName !== 'string' || typeof a.stationId !== 'string') throw new HttpError(400, 'Each prep needs a recipe and a station.');
      const par = a.par === undefined || a.par === null || a.par === '' ? null : Number(a.par);
      if (par !== null && !(par >= 0)) throw new HttpError(400, 'Par must be a number.');
      await db.query(
        `INSERT INTO station_items (restaurant_id, station_id, name, unit, kind, par, recipe_name, active_from, note, sort_order)
         VALUES ($1, $2, $3, $4, 'count', $5, $3, $6, $7, (SELECT coalesce(max(sort_order), 0) + 1 FROM station_items WHERE restaurant_id = $1 AND station_id = $2))`,
        [who.restaurantId, a.stationId, a.recipeName, typeof a.unit === 'string' && a.unit.trim() ? a.unit.trim() : null, par, from, `For ${plan.name}, from ${plan.starts_on}`]);
    }
    for (const id of end) await db.query('UPDATE station_items SET active_until = $1 WHERE restaurant_id = $2 AND id = $3', [from, who.restaurantId, id]);
    } catch (err) {
      // It didn't go through: back to planned, to try again.
      await db.query("UPDATE menu_plans SET status = 'planned' WHERE id = $1", [plan.id]);
      throw err;
    }
    return send(res, 200, { added: add.length, ended: end.length }), true;
  }
  return false;
}
