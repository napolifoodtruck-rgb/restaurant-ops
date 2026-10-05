/**
 * Kitchen and bar. Every POS category belongs to one side of the menu, or to neither (merch,
 * gift cards). A guess from the category's name covers most; an administrator can change any.
 * People work the kitchen, the bar or both, which decides where Menu, Performance and Today
 * open for them; anyone can switch sides.
 *
 *   GET  /api/areas      categories that sold in the last 120 days, with their side (manager or up)
 *   POST /api/areas      { category, area: kitchen|bar|none } (owner or admin)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send, str } from './http.ts';
import { atLeast, canAdminister, type SignedIn } from './auth.ts';

export type Area = 'kitchen' | 'bar' | 'none';
export type AreaOf = (category: string | undefined) => Area;

/** The likely side from a category's name. */
export function guessArea(category: string | undefined): Area {
  const c = (category ?? '').trim().toLowerCase();
  if (!c) return 'none';
  if (/gelato|pizza|app(etizer)?s?\b|dessert|salad|food|special|frozen|kids/.test(c)) return 'kitchen';
  if (/beer|wine|cocktail|spirit|liquor|drink|beverage|non-?alcoholic|coffee|\btea\b|soda|bar\b/.test(c)) return 'bar';
  if (/merch|gift|retail|card|fee|tip/.test(c)) return 'none';
  return 'kitchen';
}

export async function loadAreas(db: Db, restaurantId: string): Promise<AreaOf> {
  const set = new Map((await db.query<{ category: string; area: Area }>('SELECT category, area FROM category_areas WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.category, r.area]));
  return (category) => set.get(category ?? '') ?? guessArea(category);
}

/** The side a request asks for (?area=), else the person's own (kitchen when they do both). */
export function areaFor(who: SignedIn, asked: string | null): 'kitchen' | 'bar' {
  if (asked === 'kitchen' || asked === 'bar') return asked;
  return who.area === 'bar' ? 'bar' : 'kitchen';
}

export async function areaRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, method: string, who: SignedIn, today: string): Promise<boolean> {
  if (path !== '/api/areas') return false;
  if (method === 'GET') {
    if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
    const areaOf = await loadAreas(db, who.restaurantId);
    const since = new Date(Date.parse(`${today}T12:00:00Z`) - 120 * 86_400_000).toISOString().slice(0, 10);
    const rows = (await db.query<{ category: string; net: string }>(
      "SELECT category, sum(net_sales) AS net FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day >= $2 AND category <> '' GROUP BY category ORDER BY sum(net_sales) DESC", [who.restaurantId, since])).rows;
    const set = new Set((await db.query<{ category: string }>('SELECT category FROM category_areas WHERE restaurant_id = $1', [who.restaurantId])).rows.map((r) => r.category));
    return send(res, 200, { canEdit: canAdminister(who), categories: rows.map((r) => ({ category: r.category, netSales: Math.round(Number(r.net)), area: areaOf(r.category), guessed: !set.has(r.category) })) }), true;
  }
  if (method === 'POST') {
    if (!canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator sorts categories.');
    const b = await body(req);
    const category = str(b, 'category');
    if (!category) throw new HttpError(400, 'Which category?');
    if (!['kitchen', 'bar', 'none'].includes(String(b.area))) throw new HttpError(400, 'Kitchen, bar or neither.');
    await db.query('INSERT INTO category_areas (restaurant_id, category, area) VALUES ($1, $2, $3) ON CONFLICT (restaurant_id, category) DO UPDATE SET area = EXCLUDED.area', [who.restaurantId, category, b.area]);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}
