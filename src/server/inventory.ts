/**
 * Inventory: count lists (Kitchen, Alcohol, Other), each in sections by where things are kept, and
 * the weekly count, entered the way things are stored ("2 cases + 5 lb") and worth what it's worth.
 *
 *   GET  /api/inventory                       the lists, their sections, the last count of each, what isn't on a list
 *   GET  /api/inventory/lists/:id             one list to count or arrange: sections, items, today's count, the last one
 *   GET  /api/inventory/search?q=             anything countable, and which list it's on
 *   POST /api/inventory/lists                 { id?, name, countedBy, active? }
 *   POST /api/inventory/sections              { id?, listId, name, holds?, active?, move?: 'up' | 'down' }
 *   POST /api/inventory/place                 { kind, itemId, sectionId | null, at? }: put an item on a list (or take it off)
 *   POST /api/inventory/move                  { kind, itemId, dir: 'up' | 'down' }
 *   POST /api/inventory/place-all             everything not on a list yet, onto the likeliest section
 *   POST /api/inventory/lists/:id/count       today's count of that list (started if need be)
 *   POST /api/inventory/counts/:id/line       { kind, itemId, parts: [{ amount, unit }] } ([] clears it)
 *   POST /api/inventory/counts/:id/finish
 *
 * The chef, managers and up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, type Model } from './model.ts';
import { unitsFor } from './cards.ts';
import { countUnits, countedAmount, looksLikeItHere, packsFrom, prepSpot, type CountPart, type Pack } from '../core/counts.ts';
import type { ItemConversions } from '../core/units.ts';

type Kind = 'product' | 'recipe';
interface Countable { kind: Kind; id: string; name: string; base: string; conversions?: ItemConversions; units: string[]; packs: Pack[]; category?: string; type?: string; unitPrice?: number }

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
const s = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const COUNTED_BY = ['kitchen', 'bar', 'foh'] as const;
const key = (kind: string, id: string) => `${kind}:${id}`;

/** Everything worth counting: ingredients used in a recipe or bought in the last half year, and preps. */
async function countables(db: Db, rid: string, model: Model, today: string): Promise<Map<string, Countable>> {
  const used = new Set<string>();
  for (const r of model.recipes) for (const l of r.ingredients) if (l.item.kind === 'product') used.add(l.item.id);
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 183 * 86_400_000).toISOString().slice(0, 10);
  const bought = new Set(model.purchasing.prices.filter((p) => p.date.slice(0, 10) >= since).map((p) => p.productExternalId));
  const meta = new Map(model.purchasing.products.map((p) => [p.externalId, p]));
  // The packs each comes in, newest invoice first.
  const lines = (await db.query<{ product_id: string; unit: string | null; per_amount: string; per_unit: string | null }>(
    `SELECT l.product_id, l.unit, l.per_amount::text AS per_amount, l.per_unit FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id
      WHERE i.restaurant_id = $1 AND l.product_id IS NOT NULL ORDER BY i.invoice_date DESC LIMIT 20000`, [rid])).rows;
  const byProduct = new Map<string, { unit: string | null; perAmount: number; perUnit: string | null }[]>();
  for (const l of lines) byProduct.set(l.product_id, [...(byProduct.get(l.product_id) ?? []), { unit: l.unit, perAmount: Number(l.per_amount), perUnit: l.per_unit }]);
  const out = new Map<string, Countable>();
  for (const p of model.products) {
    if (p.id.startsWith('free-') || p.id.includes(':') || !(used.has(p.id) || bought.has(p.id))) continue;
    const packs = packsFrom(byProduct.get(p.id) ?? []).filter((k) => countedAmount([{ amount: 1, unit: k.unit }], p.baseUnit, p.conversions, [k]) !== undefined);
    const m = meta.get(p.id);
    out.set(key('product', p.id), {
      kind: 'product', id: p.id, name: p.name, base: p.baseUnit, ...(p.conversions ? { conversions: p.conversions } : {}),
      units: unitsFor(p.baseUnit, p.conversions), packs, ...(m?.category ? { category: m.category } : {}), ...(m?.categoryType ? { type: m.categoryType } : {}),
      ...(model.book.unitCost(p.id) !== undefined ? { unitPrice: model.book.unitCost(p.id)! } : {}),
    });
  }
  for (const r of model.book.recipes.values()) {
    if (r.kind !== 'prep') continue;
    out.set(key('recipe', r.id), { kind: 'recipe', id: r.id, name: r.name, base: r.yield.unit, ...(r.conversions ? { conversions: r.conversions } : {}), units: unitsFor(r.yield.unit, r.conversions), packs: [], type: 'PREP' });
  }
  return out;
}

/** What a count line comes to: the amount in the item's own unit, and its value at today's prices. */
function worth(item: Countable, parts: CountPart[], model: Model): { amount?: number; value?: number } {
  const amount = countedAmount(parts, item.base, item.conversions, item.packs);
  if (amount === undefined) return {};
  const cost = model.book.costOf({ kind: item.kind, id: item.id }, { amount, unit: item.base });
  return { amount, ...(cost.complete ? { value: Math.round(cost.total * 100) / 100 } : {}) };
}

const STANDARD = new Set(['each', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal', 'dash']);
/** How much one of each of its own units holds, in its base unit: "bag" → 55.1 (lb). */
const sizesOf = (c: Countable) => Object.fromEntries(countUnits(c.base, c.units, c.packs).filter((u) => !STANDARD.has(u) && u !== c.base).map((u) => [u, countedAmount([{ amount: 1, unit: u }], c.base, c.conversions, c.packs)]).filter(([, v]) => v !== undefined));
const view = (c: Countable) => ({ kind: c.kind, id: c.id, name: c.name, base: c.base, units: countUnits(c.base, c.units, c.packs), sizes: sizesOf(c), packs: c.packs.map((p) => ({ unit: p.unit, label: p.label })), ...(c.type ? { type: c.type } : {}), ...(c.unitPrice !== undefined ? { unitPrice: c.unitPrice } : {}) });

/** The list an item belongs on, by what it is: drinks with alcohol to Alcohol, supplies to Other, food to Kitchen. */
const listFor = (c: Countable): (typeof COUNTED_BY)[number] => (['WINE', 'BEER', 'LIQUOR'].includes(c.type ?? '') ? 'bar' : c.type === 'OTHER' || c.type === 'NA_BEVERAGES' ? 'foh' : 'kitchen');

export async function inventoryRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/inventory')) return false;
  if (!atLeast(who.roleLevel, 'chef')) throw new HttpError(403, 'The chef and managers count inventory.');
  const rid = who.restaurantId;

  const lists = async () => (await db.query<{ id: string; name: string; counted_by: string; sort_order: number }>('SELECT id, name, counted_by, sort_order FROM storage_areas WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [rid])).rows;
  const sections = async () => (await db.query<{ id: string; area_id: string; name: string; holds: string | null; sort_order: number }>('SELECT id, area_id, name, holds, sort_order FROM storage_spots WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [rid])).rows;
  const placed = async () => (await db.query<{ item_kind: Kind; item_id: string; spot_id: string; sort_order: number }>('SELECT item_kind, item_id, spot_id, sort_order FROM storage_items WHERE restaurant_id = $1 ORDER BY sort_order', [rid])).rows;

  if (method === 'GET' && path === '/api/inventory') {
    const model = await getModel(db, rid, today);
    const [ls, ss, ps, items] = await Promise.all([lists(), sections(), placed(), countables(db, rid, model, today)]);
    const last = (await db.query<{ area_id: string; id: string; day: string; finished_at: string | null; value: string | null; lines: string; unpriced: string }>(
      `SELECT DISTINCT ON (c.area_id) c.area_id, c.id, c.day::text AS day, c.finished_at::text AS finished_at, sum(l.value)::text AS value, count(l.*)::text AS lines, count(l.*) FILTER (WHERE l.value IS NULL)::text AS unpriced
         FROM inventory_counts c LEFT JOIN inventory_count_lines l ON l.count_id = c.id WHERE c.restaurant_id = $1 GROUP BY c.id ORDER BY c.area_id, c.day DESC`, [rid])).rows;
    const live = new Set(ps.filter((p) => items.has(key(p.item_kind, p.item_id))).map((p) => p.spot_id + key(p.item_kind, p.item_id)));
    const onList = new Set(ps.map((p) => key(p.item_kind, p.item_id)));
    return send(res, 200, {
      today,
      lists: ls.map((l) => {
        const c = last.find((x) => x.area_id === l.id);
        const secs = ss.filter((x) => x.area_id === l.id);
        return { id: l.id, name: l.name, countedBy: l.counted_by, sections: secs.map((x) => ({ id: x.id, name: x.name, holds: x.holds, items: ps.filter((p) => p.spot_id === x.id && live.has(x.id + key(p.item_kind, p.item_id))).length })),
          ...(c ? { last: { id: c.id, day: c.day, finished: Boolean(c.finished_at), value: Number(c.value ?? 0), lines: Number(c.lines), unpriced: Number(c.unpriced) } } : {}) };
      }),
      notOnAList: [...items.values()].filter((c) => !onList.has(key(c.kind, c.id))).length,
    }), true;
  }

  if (method === 'GET' && path === '/api/inventory/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
    const model = await getModel(db, rid, today);
    const [items, ps, ss, ls] = await Promise.all([countables(db, rid, model, today), placed(), sections(), lists()]);
    const where = new Map(ps.map((p) => [key(p.item_kind, p.item_id), p.spot_id]));
    const hits = [...items.values()].filter((c) => !q || c.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
    return send(res, 200, { items: hits.map((c) => { const spot = ss.find((x) => x.id === where.get(key(c.kind, c.id))); return { ...view(c), ...(spot ? { section: spot.name, list: ls.find((l) => l.id === spot.area_id)?.name } : {}) }; }) }), true;
  }

  const listPath = path.match(/^\/api\/inventory\/lists\/([0-9a-f-]{36})(\/count)?$/);
  if (method === 'GET' && listPath && !listPath[2]) {
    const listId = listPath[1]!;
    const model = await getModel(db, rid, today);
    const [ls, ss, ps, items] = await Promise.all([lists(), sections(), placed(), countables(db, rid, model, today)]);
    const list = ls.find((l) => l.id === listId);
    if (!list) throw new HttpError(404, 'No such list.');
    const count = (await db.query<{ id: string; day: string; finished_at: string | null }>('SELECT id, day::text AS day, finished_at::text AS finished_at FROM inventory_counts WHERE restaurant_id = $1 AND area_id = $2 AND day = $3', [rid, listId, today])).rows[0];
    const lines = count ? (await db.query<{ item_kind: Kind; item_id: string; parts: unknown; amount: string | null; value: string | null }>('SELECT item_kind, item_id, parts, amount::text AS amount, value::text AS value FROM inventory_count_lines WHERE count_id = $1', [count.id])).rows : [];
    // The last time each item was counted (any list), before today.
    const before = (await db.query<{ item_kind: Kind; item_id: string; parts: unknown; day: string }>(
      `SELECT DISTINCT ON (l.item_kind, l.item_id) l.item_kind, l.item_id, l.parts, c.day::text AS day FROM inventory_count_lines l JOIN inventory_counts c ON c.id = l.count_id
        WHERE l.restaurant_id = $1 AND c.day < $2 ORDER BY l.item_kind, l.item_id, c.day DESC`, [rid, today])).rows;
    const js = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const lineOf = new Map(lines.map((l) => [key(l.item_kind, l.item_id), l]));
    const lastOf = new Map(before.map((l) => [key(l.item_kind, l.item_id), l]));
    return send(res, 200, {
      today, list: { id: list.id, name: list.name, countedBy: list.counted_by },
      lists: ls.map((l) => ({ id: l.id, name: l.name, sections: ss.filter((x) => x.area_id === l.id).map((x) => ({ id: x.id, name: x.name })) })),
      ...(count ? { count: { id: count.id, day: count.day, finished: Boolean(count.finished_at) } } : {}),
      sections: ss.filter((x) => x.area_id === listId).map((x) => ({
        id: x.id, name: x.name, holds: x.holds,
        items: ps.filter((p) => p.spot_id === x.id).map((p) => items.get(key(p.item_kind, p.item_id))).filter((c): c is Countable => Boolean(c)).map((c) => {
          const l = lineOf.get(key(c.kind, c.id)), was = lastOf.get(key(c.kind, c.id));
          return { ...view(c), ...(l ? { counted: { parts: js(l.parts), ...(l.amount !== null ? { amount: Number(l.amount) } : {}), ...(l.value !== null ? { value: Number(l.value) } : {}) } } : {}), ...(was ? { last: { parts: js(was.parts), day: was.day } } : {}) };
        }),
      })),
    }), true;
  }

  // Everything below changes things.
  if (method !== 'POST') return false;
  const b: Record<string, any> = String(req.headers['content-type'] ?? '').includes('json') ? await body(req) : {};

  if (path === '/api/inventory/lists') {
    const name = s(b.name, 60);
    const countedBy = COUNTED_BY.includes(b.countedBy as never) ? String(b.countedBy) : 'kitchen';
    if (isUuid(b.id)) {
      if (b.active === false) await db.query('UPDATE storage_areas SET active = false WHERE restaurant_id = $1 AND id = $2', [rid, b.id]);
      else await db.query('UPDATE storage_areas SET name = coalesce($3, name), counted_by = $4 WHERE restaurant_id = $1 AND id = $2', [rid, b.id, name ?? null, countedBy]);
      return send(res, 200, { ok: true }), true;
    }
    if (!name) throw new HttpError(400, 'Name the list.');
    const r = await db.query<{ id: string }>('INSERT INTO storage_areas (restaurant_id, name, counted_by, sort_order) VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order), 0) + 1 FROM storage_areas WHERE restaurant_id = $1)) RETURNING id', [rid, name, countedBy]);
    return send(res, 201, { id: r.rows[0]!.id }), true;
  }

  if (path === '/api/inventory/sections') {
    if (isUuid(b.id)) {
      const sec = (await db.query<{ area_id: string; sort_order: number }>('SELECT area_id, sort_order FROM storage_spots WHERE restaurant_id = $1 AND id = $2', [rid, b.id])).rows[0];
      if (!sec) throw new HttpError(404, 'No such section.');
      if (b.active === false) {
        if ((await db.query('SELECT 1 FROM storage_items WHERE spot_id = $1 LIMIT 1', [b.id])).rows.length) throw new HttpError(409, 'Move what’s in it first.');
        await db.query('UPDATE storage_spots SET active = false WHERE id = $1', [b.id]);
      } else if (b.move === 'up' || b.move === 'down') {
        const all = (await sections()).filter((x) => x.area_id === sec.area_id);
        const i = all.findIndex((x) => x.id === b.id), j = b.move === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < all.length) { [all[i], all[j]] = [all[j]!, all[i]!]; for (const [n, x] of all.entries()) await db.query('UPDATE storage_spots SET sort_order = $2 WHERE id = $1', [x.id, n]); }
      } else await db.query('UPDATE storage_spots SET name = coalesce($2, name), holds = $3 WHERE id = $1', [b.id, s(b.name, 80) ?? null, s(b.holds, 200) ?? null]);
      return send(res, 200, { ok: true }), true;
    }
    // Dragged into a new order: the list's sections, top to bottom.
    if (Array.isArray(b.order) && isUuid(b.listId)) {
      const mine = new Set((await sections()).filter((x) => x.area_id === b.listId).map((x) => x.id));
      const ids = b.order.map(String).filter((id: string) => mine.has(id));
      for (const [n, id] of ids.entries()) await db.query('UPDATE storage_spots SET sort_order = $3 WHERE restaurant_id = $1 AND id = $2', [rid, id, n]);
      return send(res, 200, { ok: true }), true;
    }
    const name = s(b.name, 80);
    if (!isUuid(b.listId) || !name) throw new HttpError(400, 'Which list, and what’s the section called?');
    const r = await db.query<{ id: string }>('INSERT INTO storage_spots (restaurant_id, area_id, name, holds, sort_order) VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM storage_spots WHERE restaurant_id = $1 AND area_id = $2)) RETURNING id', [rid, b.listId, name, s(b.holds, 200) ?? null]);
    return send(res, 201, { id: r.rows[0]!.id }), true;
  }

  if (path === '/api/inventory/place') {
    const kind = b.kind === 'recipe' ? 'recipe' : 'product', itemId = String(b.itemId ?? '');
    if (!itemId) throw new HttpError(400, 'Which item?');
    if (b.sectionId === null) { await db.query('DELETE FROM storage_items WHERE restaurant_id = $1 AND item_kind = $2 AND item_id = $3', [rid, kind, itemId]); return send(res, 200, { ok: true }), true; }
    if (!isUuid(b.sectionId)) throw new HttpError(400, 'Which section?');
    const there = (await placed()).filter((p) => p.spot_id === b.sectionId && !(p.item_kind === kind && p.item_id === itemId));
    const at = Number.isInteger(b.at) ? Math.max(0, Math.min(Number(b.at), there.length)) : there.length;
    await db.query('INSERT INTO storage_items (restaurant_id, item_kind, item_id, spot_id, sort_order) VALUES ($1, $2, $3, $4, 0) ON CONFLICT (restaurant_id, item_kind, item_id) DO UPDATE SET spot_id = EXCLUDED.spot_id', [rid, kind, itemId, b.sectionId]);
    const order = [...there.slice(0, at), { item_kind: kind, item_id: itemId }, ...there.slice(at)];
    for (const [n, p] of order.entries()) await db.query('UPDATE storage_items SET sort_order = $4 WHERE restaurant_id = $1 AND item_kind = $2 AND item_id = $3', [rid, p.item_kind, p.item_id, n]);
    return send(res, 200, { ok: true }), true;
  }

  if (path === '/api/inventory/move') {
    const kind = b.kind === 'recipe' ? 'recipe' : 'product', itemId = String(b.itemId ?? '');
    const all = await placed();
    const me = all.find((p) => p.item_kind === kind && p.item_id === itemId);
    if (!me) throw new HttpError(404, 'That item isn’t on a list.');
    const here = all.filter((p) => p.spot_id === me.spot_id);
    const i = here.indexOf(me), j = b.dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < here.length) {
      [here[i], here[j]] = [here[j]!, here[i]!];
      for (const [n, p] of here.entries()) await db.query('UPDATE storage_items SET sort_order = $4 WHERE restaurant_id = $1 AND item_kind = $2 AND item_id = $3', [rid, p.item_kind, p.item_id, n]);
    }
    return send(res, 200, { ok: true }), true;
  }

  // Everything not on a list yet, onto its likeliest section: the right list by what it is, the section by
  // what that section holds, else the list's "To sort" at the end.
  if (path === '/api/inventory/place-all') {
    const model = await getModel(db, rid, today);
    const [ls, ss, ps, items] = await Promise.all([lists(), sections(), placed(), countables(db, rid, model, today)]);
    if (!ls.length) throw new HttpError(409, 'Make the lists first.');
    const onList = new Set(ps.map((p) => key(p.item_kind, p.item_id)));
    let placedNow = 0;
    const toSort = new Map<string, string>();
    for (const c of [...items.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (onList.has(key(c.kind, c.id))) continue;
      const list = ls.find((l) => l.counted_by === listFor(c)) ?? ls[0]!;
      const secs = ss.filter((x) => x.area_id === list.id);
      const spot = c.kind === 'recipe' ? prepSpot(c.name, secs) : secs.find((x) => looksLikeItHere(x.holds, c.name, c.category));
      let spotId = spot?.id;
      if (!spotId) {
        spotId = toSort.get(list.id) ?? secs.find((x) => /^to sort$/i.test(x.name))?.id;
        if (!spotId) spotId = (await db.query<{ id: string }>("INSERT INTO storage_spots (restaurant_id, area_id, name, holds, sort_order) VALUES ($1, $2, 'To sort', NULL, 1000) RETURNING id", [rid, list.id])).rows[0]!.id;
        toSort.set(list.id, spotId);
      }
      await db.query('INSERT INTO storage_items (restaurant_id, item_kind, item_id, spot_id, sort_order) VALUES ($1, $2, $3, $4, 1000 + $5) ON CONFLICT DO NOTHING', [rid, c.kind, c.id, spotId, placedNow]);
      placedNow++;
    }
    return send(res, 200, { placed: placedNow }), true;
  }

  if (listPath && listPath[2]) {
    const listId = listPath[1]!;
    if (!(await lists()).some((l) => l.id === listId)) throw new HttpError(404, 'No such list.');
    const r = await db.query<{ id: string }>('INSERT INTO inventory_counts (restaurant_id, area_id, day, started_by) VALUES ($1, $2, $3, $4) ON CONFLICT (area_id, day) DO UPDATE SET finished_at = NULL RETURNING id', [rid, listId, today, who.staffId]);
    return send(res, 200, { id: r.rows[0]!.id }), true;
  }

  const countPath = path.match(/^\/api\/inventory\/counts\/([0-9a-f-]{36})\/(line|finish)$/);
  if (countPath) {
    const count = (await db.query<{ id: string }>('SELECT id FROM inventory_counts WHERE restaurant_id = $1 AND id = $2', [rid, countPath[1]])).rows[0];
    if (!count) throw new HttpError(404, 'No such count.');
    if (countPath[2] === 'finish') {
      await db.query('UPDATE inventory_counts SET finished_at = now(), finished_by = $2 WHERE id = $1', [count.id, who.staffId]);
      const t = (await db.query<{ value: string | null; lines: string }>('SELECT sum(value)::text AS value, count(*)::text AS lines FROM inventory_count_lines WHERE count_id = $1', [count.id])).rows[0]!;
      return send(res, 200, { value: Number(t.value ?? 0), lines: Number(t.lines) }), true;
    }
    const kind: Kind = b.kind === 'recipe' ? 'recipe' : 'product', itemId = String(b.itemId ?? '');
    const parts = (Array.isArray(b.parts) ? b.parts : []).map((p: any) => ({ amount: Number(p?.amount), unit: String(p?.unit ?? '') })).filter((p: CountPart) => p.unit && Number.isFinite(p.amount) && p.amount >= 0);
    if (!parts.length) {
      await db.query('DELETE FROM inventory_count_lines WHERE count_id = $1 AND item_kind = $2 AND item_id = $3', [count.id, kind, itemId]);
      return send(res, 200, { ok: true }), true;
    }
    const model = await getModel(db, rid, today);
    const items = await countables(db, rid, model, today);
    const item = items.get(key(kind, itemId));
    if (!item) throw new HttpError(404, 'That isn’t something we count.');
    const w = worth(item, parts, model);
    await db.query(`INSERT INTO inventory_count_lines (restaurant_id, count_id, item_kind, item_id, name, parts, amount, base_unit, value, counted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (count_id, item_kind, item_id) DO UPDATE SET parts = EXCLUDED.parts, amount = EXCLUDED.amount, base_unit = EXCLUDED.base_unit, value = EXCLUDED.value, counted_by = EXCLUDED.counted_by, counted_at = now()`,
      [rid, count.id, kind, itemId, item.name, JSON.stringify(parts), w.amount ?? null, item.base, w.value ?? null, who.staffId]);
    return send(res, 200, { ...(w.amount !== undefined ? { amount: w.amount, base: item.base } : { problem: `Can’t tell how much that is in ${item.base}.` }), ...(w.value !== undefined ? { value: w.value } : {}) }), true;
  }

  return false;
}
