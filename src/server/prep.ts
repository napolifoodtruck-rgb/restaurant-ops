/**
 * Station prep lists over HTTP: the nightly count, the chef's approval, the next day's work,
 * and editing the lists themselves.
 *
 *   GET  /api/prep                                   stations with today's and tomorrow's list status
 *   GET  /api/prep/:station/:date                    one station's list for a day (drafted on first look)
 *   POST /api/prep/:station/:date/count              { itemId, counted|null }          anyone signed in
 *   POST /api/prep/:station/:date/make               { itemId, toMake|null }           chef and up
 *   POST /api/prep/:station/:date/approve            { approved: boolean }             chef and up
 *   POST /api/prep/:station/:date/done               { itemId, state: start|done|undo } anyone signed in
 *   POST /api/prep/:station/:date/check              { checklistId, done }             anyone signed in
 *   GET  /api/prep/:station/setup                    items and cleaning tasks           chef and up
 *   POST /api/prep/:station/items | /checklist       add                               chef and up
 *   POST /api/prep/items/:id | /checklist/:id        change or { active: false }       chef and up
 *   POST /api/prep/:station/order                    { items: [ids], checklist: [ids] } chef and up
 *   POST /api/prep/import                            { format: 'prep-lists', stations } manager and up
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { dayLines, dayShare, weekdayOf, type StationItem } from '../core/stationLists.ts';

const UUID = '[0-9a-f-]{36}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface ItemRow { id: string; name: string; unit: string | null; kind: StationItem['kind']; par: string | null; weekdays: number[] | null; recipe_name: string | null; note: string | null; sort_order: number }
const toItem = (r: ItemRow): StationItem & { note?: string; recipeName?: string } => ({
  id: r.id, name: r.name, kind: r.kind,
  ...(r.unit ? { unit: r.unit } : {}),
  ...(r.par !== null && r.par !== undefined ? { par: Number(r.par) } : {}),
  ...(r.weekdays?.length ? { weekdays: r.weekdays.map(Number) } : {}),
  ...(r.note ? { note: r.note } : {}),
  ...(r.recipe_name ? { recipeName: r.recipe_name } : {}),
});
const arr = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

async function station(db: Db, restaurantId: string, id: string) {
  const r = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND id = $2 AND active', [restaurantId, id])).rows[0];
  if (!r) throw new HttpError(404, 'No such station.');
  return r;
}

async function items(db: Db, restaurantId: string, stationId: string) {
  return (await db.query<ItemRow>('SELECT id, name, unit, kind, par, weekdays, recipe_name, note, sort_order FROM station_items WHERE restaurant_id = $1 AND station_id = $2 AND active ORDER BY sort_order, name', [restaurantId, stationId])).rows.map((r) => toItem({ ...r, weekdays: arr(r.weekdays) }));
}

async function listFor(db: Db, restaurantId: string, stationId: string, date: string) {
  const found = (await db.query<{ id: string; status: string; counted_at: string | null; approved_at: string | null; approved_by: string | null; counted_by: string | null }>(
    'SELECT id, status, counted_at, approved_at, approved_by, counted_by FROM prep_lists WHERE restaurant_id = $1 AND station_id = $2 AND for_date = $3', [restaurantId, stationId, date])).rows[0];
  if (found) return found;
  return (await db.query<{ id: string; status: string; counted_at: string | null; approved_at: string | null; approved_by: string | null; counted_by: string | null }>(
    `INSERT INTO prep_lists (restaurant_id, station_id, for_date) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, station_id, for_date) DO UPDATE SET for_date = EXCLUDED.for_date
     RETURNING id, status, counted_at, approved_at, approved_by, counted_by`, [restaurantId, stationId, date])).rows[0]!;
}

/** Daily sales for the last 8 weeks, for scaling pars to the day. */
async function recentSales(db: Db, restaurantId: string, before: string) {
  return (await db.query<{ day: string; net: string }>(
    'SELECT day::text AS day, sum(net_sales) AS net FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day < $2 AND day >= $3 GROUP BY day', [restaurantId, before, addDays(before, -56)])).rows.map((r) => ({ date: r.day, netSales: Number(r.net) }));
}

async function view(db: Db, who: SignedIn, stationId: string, date: string) {
  const st = await station(db, who.restaurantId, stationId);
  const list = await listFor(db, who.restaurantId, stationId, date);
  const all = await items(db, who.restaurantId, stationId);
  const lines = (await db.query<{ item_id: string; counted: string | null; to_make: string | null; started_at: string | null; done_at: string | null; done_name: string | null; started_name: string | null }>(
    `SELECT l.item_id, l.counted, l.to_make, l.started_at, l.done_at, d.display_name AS done_name, s.display_name AS started_name
       FROM prep_list_lines l LEFT JOIN staff d ON d.id = l.done_by LEFT JOIN staff s ON s.id = l.started_by WHERE l.list_id = $1`, [list.id])).rows;
  const byItem = new Map(lines.map((l) => [l.item_id, l]));
  const counts = new Map(lines.filter((l) => l.counted !== null).map((l) => [l.item_id, Number(l.counted)]));
  const share = dayShare(await recentSales(db, who.restaurantId, date), weekdayOf(date));
  const day = dayLines(all, date, share, counts);

  // Cleaning: daily tasks, weekly ones on their day, and weekly ones with no day until done that week.
  const weekStart = addDays(date, -((weekdayOf(date) + 6) % 7)); // Monday
  const checklist = (await db.query<{ id: string; name: string; frequency: string; weekday: number | null; done_at: string | null; done_name: string | null; done_this_week: boolean }>(
    `SELECT c.id, c.name, c.frequency, c.weekday, k.done_at, s.display_name AS done_name,
            EXISTS (SELECT 1 FROM prep_list_checks k2 JOIN prep_lists p2 ON p2.id = k2.list_id
                     WHERE k2.checklist_id = c.id AND p2.for_date >= $3 AND p2.for_date <= $4 AND p2.id <> $2) AS done_this_week
       FROM station_checklist c
       LEFT JOIN prep_list_checks k ON k.checklist_id = c.id AND k.list_id = $2
       LEFT JOIN staff s ON s.id = k.done_by
      WHERE c.restaurant_id = $1 AND c.station_id = $5 AND c.active ORDER BY c.frequency, c.sort_order, c.name`,
    [who.restaurantId, list.id, weekStart, addDays(weekStart, 6), stationId])).rows
    .filter((c) => c.frequency === 'daily' || (c.weekday !== null ? Number(c.weekday) === weekdayOf(date) : !c.done_this_week || c.done_at));

  const names = new Map<string, string>();
  for (const id of [list.approved_by, list.counted_by].filter(Boolean) as string[]) {
    const n = (await db.query<{ display_name: string }>('SELECT display_name FROM staff WHERE id = $1', [id])).rows[0];
    if (n) names.set(id, n.display_name);
  }
  return {
    station: st,
    date,
    status: list.status,
    countedAt: list.counted_at,
    countedBy: list.counted_by ? names.get(list.counted_by) : undefined,
    approvedAt: list.approved_at,
    approvedBy: list.approved_by ? names.get(list.approved_by) : undefined,
    ...(share ? { share: Math.round(share.share * 100) / 100, busiest: share.busiest } : {}),
    canApprove: atLeast(who.roleLevel, 'chef'),
    lines: day.map((d) => {
      const l = byItem.get(d.item.id);
      const chosen = l?.to_make !== null && l?.to_make !== undefined ? Number(l.to_make) : undefined;
      return {
        ...d.item,
        ...(d.dayPar !== undefined ? { dayPar: d.dayPar } : {}),
        ...(l?.counted !== null && l?.counted !== undefined ? { counted: Number(l.counted) } : {}),
        ...(d.suggested !== undefined ? { suggested: d.suggested, reason: d.reason } : {}),
        ...(chosen !== undefined ? { chosen } : {}),
        // What the station will see: the chef's number, else the suggestion.
        ...(chosen !== undefined ? { toMake: chosen } : d.suggested !== undefined ? { toMake: d.suggested } : {}),
        ...(l?.started_at ? { startedAt: l.started_at, startedBy: l.started_name } : {}),
        ...(l?.done_at ? { doneAt: l.done_at, doneBy: l.done_name } : {}),
      };
    }),
    checklist: checklist.map((c) => ({ id: c.id, name: c.name, frequency: c.frequency, ...(c.done_at ? { doneAt: c.done_at, doneBy: c.done_name } : {}) })),
  };
}

async function setLine(db: Db, who: SignedIn, stationId: string, date: string, itemId: string, set: Record<string, unknown>) {
  const list = await listFor(db, who.restaurantId, stationId, date);
  const item = (await db.query('SELECT 1 FROM station_items WHERE restaurant_id = $1 AND station_id = $2 AND id = $3', [who.restaurantId, stationId, itemId])).rows[0];
  if (!item) throw new HttpError(404, 'That item isn’t on this station.');
  await db.query('INSERT INTO prep_list_lines (restaurant_id, list_id, item_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [who.restaurantId, list.id, itemId]);
  const keys = Object.keys(set);
  await db.query(`UPDATE prep_list_lines SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE list_id = $1 AND item_id = $2`, [list.id, itemId, ...keys.map((k) => set[k])]);
  return list;
}

const num = (v: unknown, what: string): number | null => {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be a number, 0 or more.`);
  return n;
};

function itemFields(b: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) throw new HttpError(400, 'Name it.');
    out.name = b.name.trim();
  }
  if (b.unit !== undefined) out.unit = typeof b.unit === 'string' && b.unit.trim() ? b.unit.trim() : null;
  if (b.kind !== undefined) {
    if (!['count', 'task', 'batch'].includes(String(b.kind))) throw new HttpError(400, 'Kind is count, task or batch.');
    out.kind = b.kind;
  }
  if (b.par !== undefined) out.par = num(b.par, 'Par');
  if (b.weekdays !== undefined) {
    if (b.weekdays !== null && !(Array.isArray(b.weekdays) && b.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) throw new HttpError(400, 'Days are 0 (Sunday) to 6.');
    out.weekdays = b.weekdays && (b.weekdays as number[]).length ? `{${(b.weekdays as number[]).join(',')}}` : null;
  }
  if (b.note !== undefined) out.note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
  if (b.recipeName !== undefined) out.recipe_name = typeof b.recipeName === 'string' && b.recipeName.trim() ? b.recipeName.trim() : null;
  if (b.active === false) out.active = false;
  return out;
}

function checklistFields(b: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) throw new HttpError(400, 'Name it.');
    out.name = b.name.trim();
  }
  if (b.frequency !== undefined) {
    if (!['daily', 'weekly'].includes(String(b.frequency))) throw new HttpError(400, 'Daily or weekly.');
    out.frequency = b.frequency;
  }
  if (b.weekday !== undefined) {
    if (b.weekday !== null && !(Number.isInteger(b.weekday) && (b.weekday as number) >= 0 && (b.weekday as number) <= 6)) throw new HttpError(400, 'Day is 0 (Sunday) to 6.');
    out.weekday = b.weekday;
  }
  if (b.active === false) out.active = false;
  return out;
}

export interface PrepImport {
  format: 'prep-lists';
  stations: { name: string; items: Record<string, unknown>[]; checklist?: Record<string, unknown>[] }[];
}

/** Loads stations, their items and cleaning tasks. A station's existing list is replaced. */
export async function importPrep(db: Db, restaurantId: string, data: PrepImport) {
  let n = 0;
  for (const [i, s] of data.stations.entries()) {
    if (typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.items)) throw new HttpError(400, 'Each station needs a name and items.');
    const st = (await db.query<{ id: string }>(
      `INSERT INTO stations (restaurant_id, name, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (restaurant_id, name) DO UPDATE SET active = true, sort_order = EXCLUDED.sort_order RETURNING id`, [restaurantId, s.name.trim(), i])).rows[0]!;
    await db.query('UPDATE station_items SET active = false WHERE restaurant_id = $1 AND station_id = $2', [restaurantId, st.id]);
    await db.query('UPDATE station_checklist SET active = false WHERE restaurant_id = $1 AND station_id = $2', [restaurantId, st.id]);
    for (const [j, it] of s.items.entries()) {
      const f = itemFields(it, false);
      const keys = Object.keys(f);
      await db.query(`INSERT INTO station_items (restaurant_id, station_id, sort_order, ${keys.join(', ')}) VALUES ($1, $2, $3, ${keys.map((_, k) => `$${k + 4}`).join(', ')})`, [restaurantId, st.id, j, ...keys.map((k) => f[k])]);
      n++;
    }
    for (const [j, c] of (s.checklist ?? []).entries()) {
      const f = checklistFields(c, false);
      const keys = Object.keys(f);
      await db.query(`INSERT INTO station_checklist (restaurant_id, station_id, sort_order, ${keys.join(', ')}) VALUES ($1, $2, $3, ${keys.map((_, k) => `$${k + 4}`).join(', ')})`, [restaurantId, st.id, j, ...keys.map((k) => f[k])]);
    }
  }
  return { stations: data.stations.length, items: n };
}

/** Handles /api/prep routes. Returns false when the path isn't one of them. */
export async function prepRoutes(db: Db, req: IncomingMessage, res: ServerResponse, path: string, method: string, who: SignedIn, today: string): Promise<boolean> {
  const chef = () => { if (!atLeast(who.roleLevel, 'chef')) throw new HttpError(403, 'A chef or manager does that.'); };
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/prep') {
    const tomorrow = addDays(today, 1);
    const stations = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [who.restaurantId])).rows;
    const lists = (await db.query<{ station_id: string; for_date: string; status: string; counted_at: string | null; lines: string; done: string; counted: string }>(
      `SELECT p.station_id, p.for_date::text AS for_date, p.status, p.counted_at,
              (SELECT count(*) FROM prep_list_lines l WHERE l.list_id = p.id) AS lines,
              (SELECT count(*) FROM prep_list_lines l WHERE l.list_id = p.id AND l.done_at IS NOT NULL) AS done,
              (SELECT count(*) FROM prep_list_lines l WHERE l.list_id = p.id AND l.counted IS NOT NULL) AS counted
         FROM prep_lists p WHERE p.restaurant_id = $1 AND p.for_date IN ($2, $3)`, [who.restaurantId, today, tomorrow])).rows;
    const itemCounts = new Map((await db.query<{ station_id: string; n: string }>("SELECT station_id, count(*) AS n FROM station_items WHERE restaurant_id = $1 AND active AND kind = 'count' GROUP BY station_id", [who.restaurantId])).rows.map((r) => [r.station_id, Number(r.n)]));
    const at = (id: string, d: string) => lists.find((l) => l.station_id === id && l.for_date === d);
    return send(res, 200, {
      today, tomorrow, canApprove: atLeast(who.roleLevel, 'chef'), canEdit: atLeast(who.roleLevel, 'chef'),
      stations: stations.map((s) => ({ id: s.id, name: s.name, toCount: itemCounts.get(s.id) ?? 0, today: at(s.id, today) ?? null, tomorrow: at(s.id, tomorrow) ?? null })),
    }), true;
  }

  if (method === 'POST' && path === '/api/prep/import') {
    if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
    const b = await body(req, 2 * 1024 * 1024);
    if (b.format !== 'prep-lists' || !Array.isArray(b.stations)) throw new HttpError(400, 'That isn’t a prep-lists file.');
    return send(res, 200, await importPrep(db, who.restaurantId, b as unknown as PrepImport)), true;
  }

  if ((m = path.match(new RegExp(`^/api/prep/(items|checklist)/(${UUID})$`))) && method === 'POST') {
    chef();
    const b = await body(req);
    const f = m[1] === 'items' ? itemFields(b, true) : checklistFields(b, true);
    const keys = Object.keys(f);
    if (!keys.length) throw new HttpError(400, 'Nothing to change.');
    const table = m[1] === 'items' ? 'station_items' : 'station_checklist';
    const r = await db.query(`UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE restaurant_id = $1 AND id = $2 RETURNING id`, [who.restaurantId, m[2], ...keys.map((k) => f[k])]);
    if (!r.rows.length) throw new HttpError(404, 'Not found.');
    return send(res, 200, { ok: true }), true;
  }

  if ((m = path.match(new RegExp(`^/api/prep/(${UUID})/setup$`))) && method === 'GET') {
    chef();
    const st = await station(db, who.restaurantId, m[1]!);
    const checklist = (await db.query('SELECT id, name, frequency, weekday FROM station_checklist WHERE restaurant_id = $1 AND station_id = $2 AND active ORDER BY frequency, sort_order, name', [who.restaurantId, st.id])).rows;
    return send(res, 200, { station: st, items: await items(db, who.restaurantId, st.id), checklist }), true;
  }

  if ((m = path.match(new RegExp(`^/api/prep/(${UUID})/(items|checklist)$`))) && method === 'POST') {
    chef();
    const st = await station(db, who.restaurantId, m[1]!);
    const b = await body(req);
    const f = m[2] === 'items' ? itemFields(b, false) : checklistFields(b, false);
    const table = m[2] === 'items' ? 'station_items' : 'station_checklist';
    const keys = Object.keys(f);
    const r = await db.query<{ id: string }>(
      `INSERT INTO ${table} (restaurant_id, station_id, sort_order, ${keys.join(', ')})
       VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 1 FROM ${table} WHERE restaurant_id = $1 AND station_id = $2), ${keys.map((_, k) => `$${k + 3}`).join(', ')}) RETURNING id`,
      [who.restaurantId, st.id, ...keys.map((k) => f[k])]);
    return send(res, 201, { id: r.rows[0]!.id }), true;
  }

  if ((m = path.match(new RegExp(`^/api/prep/(${UUID})/order$`))) && method === 'POST') {
    chef();
    const st = await station(db, who.restaurantId, m[1]!);
    const b = await body(req);
    for (const [table, ids] of [['station_items', b.items], ['station_checklist', b.checklist]] as const) {
      if (!Array.isArray(ids)) continue;
      for (const [i, id] of ids.entries()) await db.query(`UPDATE ${table} SET sort_order = $1 WHERE restaurant_id = $2 AND station_id = $3 AND id = $4`, [i, who.restaurantId, st.id, String(id)]);
    }
    return send(res, 200, { ok: true }), true;
  }

  if ((m = path.match(new RegExp(`^/api/prep/(${UUID})/(${DATE})(?:/(count|make|approve|done|check))?$`)))) {
    const [, stationId, date, action] = m as unknown as [string, string, string, string | undefined];
    if (method === 'GET' && !action) return send(res, 200, await view(db, who, stationId, date)), true;
    if (method !== 'POST' || !action) return false;
    const b = await body(req);
    const list = await listFor(db, who.restaurantId, stationId, date);
    if (action === 'count') {
      if (list.status === 'approved') throw new HttpError(409, 'This list is already approved. A chef can reopen it.');
      await setLine(db, who, stationId, date, String(b.itemId), { counted: num(b.counted, 'Count') });
      await db.query('UPDATE prep_lists SET counted_at = now(), counted_by = $1 WHERE id = $2', [who.staffId, list.id]);
    } else if (action === 'make') {
      chef();
      await setLine(db, who, stationId, date, String(b.itemId), { to_make: num(b.toMake, 'Amount') });
    } else if (action === 'approve') {
      chef();
      if (b.approved === false) await db.query("UPDATE prep_lists SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1", [list.id]);
      else await db.query("UPDATE prep_lists SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2", [who.staffId, list.id]);
    } else if (action === 'done') {
      if (list.status !== 'approved') throw new HttpError(409, 'This list hasn’t been approved yet.');
      const state = String(b.state);
      const set = state === 'start' ? { started_at: new Date(), started_by: who.staffId }
        : state === 'done' ? { done_at: new Date(), done_by: who.staffId }
        : { done_at: null, done_by: null, started_at: null, started_by: null };
      await setLine(db, who, stationId, date, String(b.itemId), set);
    } else if (action === 'check') {
      const c = (await db.query('SELECT 1 FROM station_checklist WHERE restaurant_id = $1 AND station_id = $2 AND id = $3', [who.restaurantId, stationId, String(b.checklistId)])).rows[0];
      if (!c) throw new HttpError(404, 'Not on this station’s checklist.');
      if (b.done === false) await db.query('DELETE FROM prep_list_checks WHERE list_id = $1 AND checklist_id = $2', [list.id, String(b.checklistId)]);
      else await db.query('INSERT INTO prep_list_checks (restaurant_id, list_id, checklist_id, done_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [who.restaurantId, list.id, String(b.checklistId), who.staffId]);
    }
    return send(res, 200, await view(db, who, stationId, date)), true;
  }
  return false;
}
