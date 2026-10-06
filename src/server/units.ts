/**
 * Units: the fixed conversions (shown, never edited) and the restaurant's containers (1/9 pan, deep
 * 1/9 pan, deli quart…), seeded with typical sizes the first time and edited by managers.
 *
 *   GET  /api/units                          { fixed, containers }
 *   POST /api/units/containers               { id?, name, aliases, volumeMl, note }
 *   POST /api/units/containers/:id/delete
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { HttpError, body, send } from './http.ts';
import { DEFAULT_CONTAINERS, FIXED_CONVERSIONS, type Container } from '../core/containers.ts';

export async function loadContainers(db: Db, restaurantId: string): Promise<Container[]> {
  let rows = (await db.query<{ id: string; name: string; aliases: string[] | string; volume_ml: string | null; note: string | null }>(
    'SELECT id, name, aliases, volume_ml, note FROM unit_containers WHERE restaurant_id = $1 ORDER BY sort_order, name', [restaurantId])).rows;
  if (!rows.length) {
    // The first time: the usual pans, delis and Cambros at typical sizes, to check against yours.
    for (const [i, c] of DEFAULT_CONTAINERS.entries()) {
      await db.query('INSERT INTO unit_containers (restaurant_id, name, aliases, volume_ml, note, sort_order) VALUES ($1, $2, $3::text[], $4, $5, $6) ON CONFLICT DO NOTHING',
        [restaurantId, c.name, `{${c.aliases.map((a) => `"${a.replace(/"/g, '')}"`).join(',')}}`, c.volumeMl ?? null, c.note ?? null, i]);
    }
    rows = (await db.query<{ id: string; name: string; aliases: string[] | string; volume_ml: string | null; note: string | null }>(
      'SELECT id, name, aliases, volume_ml, note FROM unit_containers WHERE restaurant_id = $1 ORDER BY sort_order, name', [restaurantId])).rows;
  }
  const list = (v: string[] | string) => (Array.isArray(v) ? v : String(v).replace(/^{|}$/g, '').split(',').filter(Boolean).map((x) => x.replace(/^"|"$/g, '')));
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: list(r.aliases), ...(r.volume_ml !== null ? { volumeMl: Number(r.volume_ml) } : {}), ...(r.note ? { note: r.note } : {}) }));
}

export async function unitRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, who: SignedIn): Promise<boolean> {
  if (!path.startsWith('/api/units')) return false;
  if (req.method === 'GET' && path === '/api/units') return send(res, 200, { fixed: FIXED_CONVERSIONS, containers: await loadContainers(db, who.restaurantId) }), true;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  if (req.method === 'POST' && path === '/api/units/containers') {
    const b = await body(req);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw new HttpError(400, 'A name for it?');
    const aliases = (Array.isArray(b.aliases) ? b.aliases : typeof b.aliases === 'string' ? b.aliases.split(',') : []).map((a) => String(a).trim()).filter(Boolean).slice(0, 12);
    const vol = b.volumeMl === null || b.volumeMl === undefined || b.volumeMl === '' ? null : Number(b.volumeMl);
    if (vol !== null && !(vol > 0)) throw new HttpError(400, 'What it holds, more than 0.');
    const arr = `{${aliases.map((a) => `"${a.replace(/["\\{}]/g, '')}"`).join(',')}}`;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 80) : null;
    const id = typeof b.id === 'string' && b.id ? b.id : undefined;
    const same = await db.query<{ id: string }>('SELECT id FROM unit_containers WHERE restaurant_id = $1 AND lower(name) = lower($2)', [who.restaurantId, name]);
    if (same.rows.some((r) => r.id !== id)) throw new HttpError(409, `There's already a container called ${name}.`);
    let saved = id;
    try {
      if (id) {
        const r = await db.query('UPDATE unit_containers SET name = $3, aliases = $4::text[], volume_ml = $5, note = $6 WHERE restaurant_id = $1 AND id = $2 RETURNING id', [who.restaurantId, id, name, arr, vol, note]);
        if (!r.rows.length) throw new HttpError(404, 'No such container.');
      } else {
        saved = (await db.query<{ id: string }>('INSERT INTO unit_containers (restaurant_id, name, aliases, volume_ml, note, sort_order) VALUES ($1, $2, $3::text[], $4, $5, 1000) RETURNING id', [who.restaurantId, name, arr, vol, note])).rows[0]!.id;
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, `There's already a container called ${name}.`);
      throw err;
    }
    return send(res, 200, { ok: true, id: saved }), true;
  }
  const m = path.match(/^\/api\/units\/containers\/([0-9a-f-]{36})\/delete$/);
  if (req.method === 'POST' && m) {
    await db.query('DELETE FROM unit_containers WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, m[1]]);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}
