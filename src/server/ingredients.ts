/**
 * The app's own ingredient list (table ingredients). MarginEdge's products are copied in with
 * their own ids and kept current while MarginEdge syncs; nothing is removed when it stops.
 * Ingredients added in the app get app:<uuid> ids.
 *
 *   POST /api/ingredients   { name, baseUnit, type } → the new ingredient (managers)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { invalidate } from './model.ts';
import { insertMany } from './squareSync.ts';
import type { PurchasedProduct } from '../core/purchasing.ts';
import { dimensionOf, normalizeUnit, type ItemConversions } from '../core/units.ts';
import { mergeConversions } from '../core/units.ts';

interface Row { id: string; name: string; base_unit: string | null; raw_unit: string | null; conversions: any; category: string | null; category_type: string | null; reference_price: string | null; source: string; active: boolean }

const asProduct = (r: Row): PurchasedProduct => ({
  externalId: r.id, name: r.name, conversions: typeof r.conversions === 'string' ? JSON.parse(r.conversions) : (r.conversions ?? {}),
  ...(r.base_unit ? { baseUnit: r.base_unit } : {}), ...(r.raw_unit ? { rawUnit: r.raw_unit } : {}), ...(r.category ? { category: r.category } : {}),
  ...(r.category_type ? { categoryType: r.category_type } : {}), ...(r.reference_price !== null && r.reference_price !== undefined ? { referencePrice: Number(r.reference_price) } : {}),
});
/** JSON with keys in order, so a stored copy (jsonb reorders keys) compares equal to a fresh one. */
const canon = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v ?? null));
const same = (a: PurchasedProduct, b: PurchasedProduct) => canon([a.name, a.baseUnit ?? null, a.rawUnit ?? null, a.conversions ?? {}, a.category ?? null, a.categoryType ?? null, a.referencePrice ?? null])
  === canon([b.name, b.baseUnit ?? null, b.rawUnit ?? null, b.conversions ?? {}, b.category ?? null, b.categoryType ?? null, b.referencePrice ?? null]);

/** A stamp that changes whenever the list does, for the model's cache. */
export async function ingredientsStamp(db: Db, restaurantId: string): Promise<string> {
  const r = (await db.query<{ n: string; t: string | null }>('SELECT count(*)::text AS n, max(updated_at)::text AS t FROM ingredients WHERE restaurant_id = $1', [restaurantId])).rows[0];
  return `${r?.n ?? 0}:${r?.t ?? ''}`;
}

/**
 * MarginEdge's products, joined to the list (the importer calls this): new ones added, details
 * of ones that came from MarginEdge refreshed, ones merged into another taken off. Ingredients
 * made in the app (and those from an earlier answer, offInvoiceProducts) are added if missing.
 */
export async function syncIngredients(db: Db, restaurantId: string, fromMe: readonly PurchasedProduct[], madeHere: readonly PurchasedProduct[] = [], mergedAway: ReadonlySet<string> = new Set()): Promise<void> {
  const rows = (await db.query<Row>('SELECT id, name, base_unit, raw_unit, conversions, category, category_type, reference_price, source, active FROM ingredients WHERE restaurant_id = $1', [restaurantId])).rows;
  const have = new Map(rows.map((r) => [r.id, r]));
  const write = async (p: PurchasedProduct, source: 'marginedge' | 'app') => db.query(
    `INSERT INTO ingredients (restaurant_id, id, name, base_unit, raw_unit, conversions, category, category_type, reference_price, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (restaurant_id, id) DO UPDATE SET name = EXCLUDED.name, base_unit = EXCLUDED.base_unit, raw_unit = EXCLUDED.raw_unit, conversions = EXCLUDED.conversions, category = EXCLUDED.category,
       category_type = EXCLUDED.category_type, reference_price = EXCLUDED.reference_price, active = true, updated_at = now()`,
    [restaurantId, p.externalId, p.name, p.baseUnit ?? null, p.rawUnit ?? null, JSON.stringify(p.conversions ?? {}), p.category ?? null, p.categoryType ?? null, p.referencePrice ?? null, source]);
  // New ones in one go (the first import is the whole list); changed ones one by one.
  const fresh = fromMe.filter((p) => !have.has(p.externalId));
  await insertMany(db, 'ingredients', ['restaurant_id', 'id', 'name', 'base_unit', 'raw_unit', 'conversions', 'category', 'category_type', 'reference_price', 'source'],
    fresh.map((p) => [restaurantId, p.externalId, p.name, p.baseUnit ?? null, p.rawUnit ?? null, JSON.stringify(p.conversions ?? {}), p.category ?? null, p.categoryType ?? null, p.referencePrice ?? null, 'marginedge']));
  for (const p of fromMe) {
    const r = have.get(p.externalId);
    if (r && r.source === 'marginedge' && (!r.active || !same(asProduct(r), p))) await write(p, 'marginedge');
  }
  for (const p of madeHere) if (!have.has(p.externalId) && !fromMe.some((x) => x.externalId === p.externalId)) await write(p, 'app');
  for (const id of mergedAway) if (have.get(id)?.active) await db.query('UPDATE ingredients SET active = false, updated_at = now() WHERE restaurant_id = $1 AND id = $2', [restaurantId, id]);
}

/** The list as the app uses it: every active ingredient, with what managers told about its units on top. */
export async function loadIngredients(db: Db, restaurantId: string, told: Record<string, ItemConversions> = {}): Promise<PurchasedProduct[]> {
  const rows = (await db.query<Row>('SELECT id, name, base_unit, raw_unit, conversions, category, category_type, reference_price, source, active FROM ingredients WHERE restaurant_id = $1 AND active ORDER BY name', [restaurantId])).rows;
  return rows.map((r) => { const p = asProduct(r); return told[p.externalId] ? { ...p, conversions: mergeConversions(told[p.externalId]!, p.conversions) } : p; });
}

const TYPES: Record<string, string> = { food: 'FOOD', wine: 'WINE', beer: 'BEER', liquor: 'LIQUOR', na: 'NA_BEVERAGES', other: 'OTHER' };

export async function ingredientRoutes(db: Db, req: IncomingMessage, res: ServerResponse, method: string, path: string, who: SignedIn): Promise<boolean> {
  if (path !== '/api/ingredients') return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  if (method !== 'POST') throw new HttpError(405, 'POST only.');
  const b = await body(req);
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim();
  const unit = normalizeUnit(String(b.baseUnit ?? ''));
  const type = TYPES[String(b.type ?? 'food')];
  if (!name) throw new HttpError(400, 'What’s it called?');
  if (!unit || (!dimensionOf(unit) && unit !== 'each')) throw new HttpError(400, 'Count it by weight (lb, oz, g), volume (gal, qt, l, ml) or each.');
  if (!type) throw new HttpError(400, 'Food, drink or other?');
  const dupe = (await db.query<{ id: string }>('SELECT id FROM ingredients WHERE restaurant_id = $1 AND active AND lower(name) = lower($2)', [who.restaurantId, name])).rows[0];
  if (dupe) throw new HttpError(409, `${name} is already on the list.`);
  const id = crypto.randomUUID();
  await db.query("INSERT INTO ingredients (restaurant_id, id, name, base_unit, category_type, source) VALUES ($1, $2, $3, $4, $5, 'app')", [who.restaurantId, id, name, unit, type]);
  invalidate(who.restaurantId);
  return send(res, 200, { id, name, unit }), true;
}
