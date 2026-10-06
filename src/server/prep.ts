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
 *   POST /api/prep/stations                          { name }: a new station               chef and up
 *   POST /api/prep/import                            { format: 'prep-lists', stations } manager and up
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel } from './model.ts';
import { nameSimilarity } from '../core/menuLinks.ts';
import { cookPace, itemTimes, itemUsuals, listSpan, median, minutesLeft, stationItemUsual, type ItemUsual, type Mark, type WorkedList } from '../core/prepTiming.ts';
import { batchSuggestion, dayLines, dayShare, onHandFrom, weekdayOf, type BulkOnHand, type StationItem, type StationNeed } from '../core/stationLists.ts';

const UUID = '[0-9a-f-]{36}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface ItemRow { id: string; name: string; unit: string | null; kind: StationItem['kind']; par: string | null; weekdays: number[] | null; recipe_name: string | null; note: string | null; sort_order: number; source_item_id: string | null; per_batch: string | null; bulk_unit: string | null; batch_yield: string | null; holds: string | null; active_from: string | null; active_until: string | null }
const toItem = (r: ItemRow): StationItem & { note?: string; recipeName?: string; sourceItemId?: string; bulkUnit?: string; batchYield?: number; holds?: number } => ({
  id: r.id, name: r.name, kind: r.kind,
  ...(r.unit ? { unit: r.unit } : {}),
  ...(r.par !== null && r.par !== undefined ? { par: Number(r.par) } : {}),
  ...(r.weekdays?.length ? { weekdays: r.weekdays.map(Number) } : {}),
  ...(r.note ? { note: r.note } : {}),
  ...(r.recipe_name ? { recipeName: r.recipe_name } : {}),
  ...(r.source_item_id ? { sourceItemId: r.source_item_id } : {}),
  ...(r.bulk_unit ? { bulkUnit: r.bulk_unit } : {}),
  ...(r.batch_yield !== null && r.batch_yield !== undefined ? { batchYield: Number(r.batch_yield) } : {}),
  ...(r.holds !== null && r.holds !== undefined ? { holds: Number(r.holds) } : {}),
  ...(r.active_from ? { activeFrom: String(r.active_from).slice(0, 10) } : {}),
  ...(r.active_until ? { activeUntil: String(r.active_until).slice(0, 10) } : {}),
});
type Item = ReturnType<typeof toItem>;
const arr = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

async function station(db: Db, restaurantId: string, id: string) {
  const r = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND id = $2 AND active', [restaurantId, id])).rows[0];
  if (!r) throw new HttpError(404, 'No such station.');
  return r;
}

async function items(db: Db, restaurantId: string, stationId: string) {
  return (await db.query<ItemRow>('SELECT id, name, unit, kind, par, weekdays, recipe_name, note, sort_order, source_item_id, per_batch, bulk_unit, batch_yield, holds, active_from::text AS active_from, active_until::text AS active_until FROM station_items WHERE restaurant_id = $1 AND station_id = $2 AND active ORDER BY sort_order, name', [restaurantId, stationId])).rows.map((r) => toItem({ ...r, weekdays: arr(r.weekdays) }));
}

async function listFor(db: Db, restaurantId: string, stationId: string, date: string) {
  type Row = { id: string; status: string; counted_at: string | null; approved_at: string | null; approved_by: string | null; counted_by: string | null; work_started_at: string | null; work_started_by: string | null };
  const found = (await db.query<Row>(
    'SELECT id, status, counted_at, approved_at, approved_by, counted_by, work_started_at, work_started_by FROM prep_lists WHERE restaurant_id = $1 AND station_id = $2 AND for_date = $3', [restaurantId, stationId, date])).rows[0];
  if (found) return found;
  return (await db.query<Row>(
    `INSERT INTO prep_lists (restaurant_id, station_id, for_date) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, station_id, for_date) DO UPDATE SET for_date = EXCLUDED.for_date
     RETURNING id, status, counted_at, approved_at, approved_by, counted_by, work_started_at, work_started_by`, [restaurantId, stationId, date])).rows[0]!;
}

/** Daily sales for the last 8 weeks, for scaling pars to the day. */
async function recentSales(db: Db, restaurantId: string, before: string) {
  return (await db.query<{ day: string; net: string }>(
    'SELECT day::text AS day, sum(net_sales) AS net FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day < $2 AND day >= $3 GROUP BY day', [restaurantId, before, addDays(before, -56)])).rows.map((r) => ({ date: r.day, netSales: Number(r.net) }));
}

/** What each item on a station will be made for a date: the chef's number, else the suggestion. */
async function stationToMake(db: Db, restaurantId: string, stationId: string, date: string, share: ReturnType<typeof dayShare>) {
  const list = (await db.query<{ id: string }>('SELECT id FROM prep_lists WHERE restaurant_id = $1 AND station_id = $2 AND for_date = $3', [restaurantId, stationId, date])).rows[0];
  const lines = list ? (await db.query<{ item_id: string; counted: string | null; to_make: string | null }>('SELECT item_id, counted, to_make FROM prep_list_lines WHERE list_id = $1', [list.id])).rows : [];
  const counts = new Map(lines.filter((l) => l.counted !== null).map((l) => [l.item_id, Number(l.counted)]));
  const chosen = new Map(lines.filter((l) => l.to_make !== null).map((l) => [l.item_id, Number(l.to_make)]));
  const out = new Map<string, number | undefined>();
  for (const d of dayLines(await items(db, restaurantId, stationId), date, share, counts)) out.set(d.item.id, chosen.get(d.item.id) ?? d.suggested);
  return out;
}

/** Bulk on hand from the ledger, per bulk item. */
async function bulkOnHand(db: Db, restaurantId: string, ids: string[]): Promise<Map<string, BulkOnHand>> {
  const out = new Map<string, BulkOnHand>();
  if (!ids.length) return out;
  const rows = (await db.query<{ item_id: string; at: string; kind: 'made' | 'filled' | 'counted' | 'waste'; change: string | null; set_to: string | null }>(
    'SELECT item_id, at, kind, change, set_to FROM bulk_ledger WHERE restaurant_id = $1 AND item_id = ANY(string_to_array($2, \',\')::uuid[])', [restaurantId, ids.join(',')])).rows;
  for (const id of ids) {
    const mine = rows.filter((r) => r.item_id === id).map((r) => ({ at: new Date(r.at).toISOString(), kind: r.kind, ...(r.change !== null ? { change: Number(r.change) } : {}), ...(r.set_to !== null ? { setTo: Number(r.set_to) } : {}) }));
    const oh = onHandFrom(mine);
    if (oh) out.set(id, oh);
  }
  return out;
}

/** For each bulk item on a station: what the stations it fills will draw, as a batch suggestion. */
async function bulkSuggestions(db: Db, restaurantId: string, batchItems: Item[], date: string, share: ReturnType<typeof dayShare>, onHand: Map<string, BulkOnHand>) {
  const out = new Map<string, ReturnType<typeof batchSuggestion>>();
  if (!batchItems.length) return out;
  const linked = (await db.query<ItemRow & { station_id: string; station_name: string }>(
    `SELECT i.id, i.name, i.unit, i.kind, i.par, i.weekdays, i.recipe_name, i.note, i.sort_order, i.source_item_id, i.per_batch, i.bulk_unit, i.batch_yield, i.holds, i.active_from::text AS active_from, i.active_until::text AS active_until, i.station_id, s.name AS station_name
       FROM station_items i JOIN stations s ON s.id = i.station_id
      WHERE i.restaurant_id = $1 AND i.active AND i.source_item_id = ANY(string_to_array($2, ',')::uuid[])`,
    [restaurantId, batchItems.map((b) => b.id).join(',')])).rows;
  const byStation = new Map<string, Map<string, number | undefined>>();
  for (const sid of new Set(linked.map((l) => l.station_id))) byStation.set(sid, await stationToMake(db, restaurantId, sid, date, share));
  for (const b of batchItems) {
    const needs: StationNeed[] = linked.filter((l) => l.source_item_id === b.id).map((l) => {
      const made = byStation.get(l.station_id)!;
      return { station: l.station_name, item: l.name, ...(l.unit ? { unit: l.unit } : {}), ...(made.has(l.id) ? { toMake: made.get(l.id) } : { toMake: 0 }), ...(l.holds ? { holds: Number(l.holds) } : {}) };
    });
    const s = batchSuggestion(needs, onHand.get(b.id), { name: b.name, ...(b.bulkUnit ? { unit: b.bulkUnit } : {}), ...(b.batchYield ? { batchYield: b.batchYield } : {}) });
    if (s) out.set(b.id, s);
  }
  return out;
}

export async function view(db: Db, who: SignedIn, stationId: string, date: string) {
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
  const batchItems = all.filter((i) => i.kind === 'batch');
  const onHand = await bulkOnHand(db, who.restaurantId, batchItems.map((b) => b.id));
  const bulk = await bulkSuggestions(db, who.restaurantId, batchItems, date, share, onHand);

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
  for (const id of [list.approved_by, list.counted_by, list.work_started_by].filter(Boolean) as string[]) {
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
    ...(list.work_started_at ? { workStartedAt: list.work_started_at, workStartedBy: list.work_started_by ? names.get(list.work_started_by) : undefined } : {}),
    usualMinutes: (await prepTiming(db, who.restaurantId, date, 'UTC', { stationId })).stations.get(stationId)?.usualMinutes,
    ...(share ? { share: Math.round(share.share * 100) / 100, busiest: share.busiest } : {}),
    canApprove: atLeast(who.roleLevel, 'chef'),
    lines: day.map((d) => {
      const l = byItem.get(d.item.id);
      const chosen = l?.to_make !== null && l?.to_make !== undefined ? Number(l.to_make) : undefined;
      const b = bulk.get(d.item.id);
      if (b) { if (b.suggested !== undefined) d.suggested = b.suggested; d.reason = b.reason + (b.missing.length ? ` Left out: ${b.missing.join(', ')}.` : ''); }
      const oh = onHand.get(d.item.id);
      return {
        ...(oh ? { onHand: { amount: Math.round(oh.amount * 100) / 100, estimated: oh.estimated, ...(oh.countedAt ? { countedAt: oh.countedAt } : {}) } } : {}),
        ...(d.reason && d.suggested === undefined ? { reason: d.reason } : {}),
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
  if (b.sourceItemId !== undefined) {
    if (b.sourceItemId !== null && !(typeof b.sourceItemId === 'string' && /^[0-9a-f-]{36}$/.test(b.sourceItemId))) throw new HttpError(400, 'Pick a bulk item.');
    out.source_item_id = b.sourceItemId;
  }
  for (const [key, col, what] of [['batchYield', 'batch_yield', 'A batch'], ['holds', 'holds', 'A container']] as const) {
    if (b[key] === undefined) continue;
    const n = num(b[key], what);
    if (n === 0) throw new HttpError(400, `${what} holds more than 0.`);
    out[col] = n;
  }
  for (const [key, col] of [['activeFrom', 'active_from'], ['activeUntil', 'active_until']] as const) {
    if (b[key] === undefined) continue;
    if (b[key] !== null && !(typeof b[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b[key] as string))) throw new HttpError(400, 'Dates are YYYY-MM-DD.');
    out[col] = b[key];
  }
  if (b.bulkUnit !== undefined) out.bulk_unit = typeof b.bulkUnit === 'string' && b.bulkUnit.trim() ? b.bulkUnit.trim() : null;
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

/** A time of day where the restaurant is ("9:10 am"), and minutes past midnight for averaging. */
function clockOf(ms: number, tz: string): { text: string; minute: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return { text: clockText(minute), minute };
}
const clockText = (minute: number) => { const h = Math.floor(minute / 60) % 24, m = Math.round(minute % 60); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

/**
 * How long prep has been taking: each station's lists over the last few weeks (time, start,
 * finish), and across stations the items that take longest and each cook's pace against the
 * usual for the same items. Today's list is in progress, so it's left out of the usuals.
 */
export async function prepTiming(db: Db, restaurantId: string, today: string, tz: string, opts: { days?: number; stationId?: string } = {}) {
  const days = opts.days ?? 28;
  const where = `p.restaurant_id = $1 AND p.for_date > $2::date - $3::int AND p.for_date <= $2::date${opts.stationId ? ' AND p.station_id = $4' : ''}`;
  const args = [restaurantId, today, days, ...(opts.stationId ? [opts.stationId] : [])];
  const rows = (await db.query<{ list_id: string; station_id: string; for_date: string; work_started_at: string | null; item_id: string; name: string; unit: string | null; made: string | null; started_at: string | null; done_at: string; done_by: string | null; by_name: string | null }>(
    `SELECT p.id AS list_id, p.station_id, p.for_date::text AS for_date, p.work_started_at, l.item_id, i.name, i.unit, l.made, l.started_at, l.done_at, l.done_by, s.display_name AS by_name
       FROM prep_lists p JOIN prep_list_lines l ON l.list_id = p.id JOIN station_items i ON i.id = l.item_id LEFT JOIN staff s ON s.id = l.done_by
      WHERE ${where} AND l.done_at IS NOT NULL`, args)).rows;
  const checks = (await db.query<{ list_id: string; station_id: string; for_date: string; work_started_at: string | null; done_at: string; done_by: string | null }>(
    `SELECT p.id AS list_id, p.station_id, p.for_date::text AS for_date, p.work_started_at, k.done_at, k.done_by
       FROM prep_lists p JOIN prep_list_checks k ON k.list_id = p.id WHERE ${where}`, args)).rows;
  const lists = new Map<string, WorkedList>();
  const listOf = (r: { list_id: string; station_id: string; for_date: string; work_started_at: string | null }) => {
    let l = lists.get(r.list_id);
    if (!l) { l = { listId: r.list_id, stationId: r.station_id, date: r.for_date, ...(r.work_started_at ? { startedAt: Date.parse(r.work_started_at) } : {}), marks: [] }; lists.set(r.list_id, l); }
    return l;
  };
  for (const r of rows) {
    const m: Mark = { itemId: r.item_id, name: r.name, doneAt: Date.parse(r.done_at), ...(r.unit ? { unit: r.unit } : {}), ...(r.made !== null ? { amount: Number(r.made) } : {}),
      ...(r.started_at ? { startedAt: Date.parse(r.started_at) } : {}), ...(r.done_by ? { by: r.done_by } : {}), ...(r.by_name ? { byName: r.by_name } : {}) };
    listOf(r).marks.push(m);
  }
  for (const c of checks) listOf(c).marks.push({ doneAt: Date.parse(c.done_at), ...(c.done_by ? { by: c.done_by } : {}) });

  // A finished day's list counts once a few things were checked off on it.
  const past = [...lists.values()].filter((l) => l.date < today && l.marks.filter((m) => m.itemId).length >= 3);
  const stations = new Map<string, { usualMinutes?: number; usualStart?: string; usualEnd?: string; lists: { date: string; minutes: number; start: string; end: string }[] }>();
  for (const l of past.sort((a, b) => a.date.localeCompare(b.date))) {
    const span = listSpan(l)!;
    const st = stations.get(l.stationId) ?? { lists: [] };
    st.lists.push({ date: l.date, minutes: span.minutes, start: clockOf(span.start, tz).text, end: clockOf(span.end, tz).text });
    stations.set(l.stationId, st);
  }
  for (const [id, st] of stations) {
    const spans = past.filter((l) => l.stationId === id).map((l) => listSpan(l)!);
    st.usualMinutes = Math.round(median(spans.map((x) => x.minutes)));
    st.usualStart = clockText(median(spans.map((x) => clockOf(x.start, tz).minute)));
    st.usualEnd = clockText(median(spans.map((x) => clockOf(x.end, tz).minute)));
    st.lists = st.lists.slice(-14);
  }
  const times = itemTimes(past);
  const usuals = itemUsuals(times);
  // A cleaning task's usual time: the gap between one cook's cleaning check-offs, one after another.
  const cleaningGaps: number[] = [];
  for (const l of past) {
    const byCook = new Map<string, number[]>();
    for (const m of l.marks.filter((x) => !x.itemId)) byCook.set(m.by ?? '', [...(byCook.get(m.by ?? '') ?? []), m.doneAt]);
    for (const ts of byCook.values()) { ts.sort((a, b) => a - b); for (let i = 1; i < ts.length; i++) { const g = (ts[i]! - ts[i - 1]!) / 60000; if (g > 0 && g <= 20) cleaningGaps.push(g); } }
  }
  const stationOfItem = new Map(times.map((t) => [t.itemId, t.stationId]));
  return {
    days,
    stations,
    usuals,
    perCleaning: cleaningGaps.length >= 5 ? median(cleaningGaps) : 1.5,
    timed: times.length,
    exact: times.filter((t) => t.exact).length,
    slowItems: [...usuals.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 6)
      .map((u) => ({ name: u.name, stationId: stationOfItem.get(u.itemId), minutes: Math.round(u.minutes), times: u.times, ...(u.amount ? { amount: u.amount } : {}), ...(u.unit ? { unit: u.unit } : {}) })),
    cooks: cookPace(times, usuals).map((c) => ({ name: c.name, items: c.items, ratio: c.ratio, hours: c.hours })),
  };
}

/** A list in progress, for the live view: done so far, what's on now, and the finish it's heading for. */
function liveOf(v: Awaited<ReturnType<typeof view>>, startedAt: number, usuals: Map<string, ItemUsual>, usualMinutes: number | undefined, tz: string, perCleaning: number, now = Date.now()) {
  const work = v.lines.filter((l) => l.kind === 'task' || (l.toMake ?? 0) > 0);
  const left = work.filter((l) => !l.doneAt);
  const cleaningLeft = v.checklist.filter((c) => !c.doneAt).length;
  const done = work.length - left.length;
  const minutesIn = Math.max(0, Math.round((now - startedAt) / 60000));
  const lastDone = [...work.map((l) => l.doneAt), ...v.checklist.map((c) => c.doneAt)].filter(Boolean).map((x) => Date.parse(String(x))).sort((a, b) => a - b).pop();
  if (!left.length && !cleaningLeft) {
    return { finished: true, done, total: work.length, doneAt: lastDone ? clockOf(lastDone, tz).text : undefined, took: lastDone ? Math.round((lastDone - startedAt) / 60000) : minutesIn, ...(usualMinutes ? { usualMinutes } : {}) };
  }
  const fallback = stationItemUsual(usuals, work.map((l) => l.id));
  const leftMinutes = minutesLeft(left.map((l) => ({ itemId: l.id, ...(l.toMake ? { amount: l.toMake } : {}), ...(l.startedAt ? { startedAt: Date.parse(String(l.startedAt)) } : {}) })), cleaningLeft, usuals, now, { perCleaning, ...(fallback ? { fallback } : {}) });
  return {
    finished: false, done, total: work.length, cleaningLeft, minutesIn, leftMinutes,
    finishAt: clockOf(now + leftMinutes * 60000, tz).text,
    ...(usualMinutes ? { usualMinutes, behind: minutesIn + leftMinutes - usualMinutes } : {}),
    // What's being made right now: started and not checked off.
    now: left.filter((l) => l.startedAt).map((l) => ({ name: l.name, ...(l.startedBy ? { by: l.startedBy } : {}), minutes: Math.round((now - Date.parse(String(l.startedAt))) / 60000) })),
    next: left.filter((l) => !l.startedAt).slice(0, 3).map((l) => l.name),
  };
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
    const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
    const timing = await prepTiming(db, who.restaurantId, today, tz);
    // Today's lists so far: when each started and how many minutes it's been going.
    const going = new Map((await db.query<{ station_id: string; started: string | null; last: string | null; by_name: string | null }>(
      `SELECT p.station_id, least(p.work_started_at, (SELECT min(coalesce(l.started_at, l.done_at)) FROM prep_list_lines l WHERE l.list_id = p.id)) AS started,
              (SELECT max(l.done_at) FROM prep_list_lines l WHERE l.list_id = p.id) AS last, s.display_name AS by_name
         FROM prep_lists p LEFT JOIN staff s ON s.id = p.work_started_by WHERE p.restaurant_id = $1 AND p.for_date = $2`, [who.restaurantId, today])).rows
      .filter((r) => r.started).map((r) => [r.station_id, { startedAt: r.started!, start: clockOf(Date.parse(r.started!), tz).text, ...(r.by_name ? { by: r.by_name } : {}), ...(r.last ? { lastDoneAt: r.last } : {}) }]));
    // Live: each list under way today, how far along, what's being made, and when it should finish.
    const live = new Map<string, unknown>();
    for (const [stationId, g] of going) {
      const v = await view(db, who, stationId, today);
      if (v.status !== 'approved') continue;
      live.set(stationId, liveOf(v, Date.parse(g.startedAt), timing.usuals, timing.stations.get(stationId)?.usualMinutes, tz, timing.perCleaning));
    }
    const manager = atLeast(who.roleLevel, 'manager');
    return send(res, 200, {
      today, tomorrow, canApprove: atLeast(who.roleLevel, 'chef'), canEdit: atLeast(who.roleLevel, 'chef'),
      stations: stations.map((s) => ({ id: s.id, name: s.name, toCount: itemCounts.get(s.id) ?? 0, today: at(s.id, today) ?? null, tomorrow: at(s.id, tomorrow) ?? null,
        ...(timing.stations.get(s.id) ? { timing: timing.stations.get(s.id) } : {}), ...(going.get(s.id) ? { going: going.get(s.id) } : {}), ...(live.get(s.id) ? { live: live.get(s.id) } : {}) })),
      // How the team's doing: for managers (who's quicker or slower is theirs to see, not the line's).
      ...(manager ? { insights: { days: timing.days, timed: timing.timed, exact: timing.exact, slowItems: timing.slowItems.map((x) => ({ ...x, station: stations.find((s) => s.id === x.stationId)?.name })), cooks: timing.cooks } } : {}),
    }), true;
  }

  if (method === 'POST' && path === '/api/prep/stations') {
    chef();
    const b = await body(req);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw new HttpError(400, 'Name the station.');
    const r = await db.query<{ id: string }>(
      `INSERT INTO stations (restaurant_id, name, sort_order) VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 1 FROM stations WHERE restaurant_id = $1))
       ON CONFLICT (restaurant_id, name) DO UPDATE SET active = true RETURNING id`, [who.restaurantId, name]);
    return send(res, 201, { id: r.rows[0]!.id }), true;
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
    const batchItems = (await db.query<{ id: string; name: string; station: string; bulk_unit: string | null }>(
      "SELECT i.id, i.name, s.name AS station, i.bulk_unit FROM station_items i JOIN stations s ON s.id = i.station_id WHERE i.restaurant_id = $1 AND i.active AND i.kind = 'batch' ORDER BY s.sort_order, i.sort_order", [who.restaurantId])).rows;
    // Recipe cards to tie items to, with a best guess by name for items not tied yet.
    const model = await getModel(db, who.restaurantId, today);
    const recipes = model.recipes.map((r) => ({ name: r.name, kind: r.kind })).sort((a, b) => a.name.localeCompare(b.name));
    const list = (await items(db, who.restaurantId, st.id)).map((it) => {
      if (it.recipeName) return it;
      const plain = it.name.replace(/\(.*?\)/g, ' ').replace(/\bGF\b/gi, 'gluten free');
      // Station items are preps, not dishes: only prep cards are offered, and only close matches.
      const best = model.recipes.filter((r) => r.kind === 'prep').map((r) => ({ name: r.name, score: nameSimilarity(plain, r.name) })).sort((a, b) => b.score - a.score)[0];
      return best && best.score >= 0.7 ? { ...it, recipeSuggestion: best.name } : it;
    });
    return send(res, 200, { station: st, items: list, checklist, batchItems, recipes }), true;
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

  if ((m = path.match(new RegExp(`^/api/prep/(${UUID})/(${DATE})(?:/(count|make|approve|done|check|start))?$`)))) {
    const [, stationId, date, action] = m as unknown as [string, string, string, string | undefined];
    if (method === 'GET' && !action) return send(res, 200, await view(db, who, stationId, date)), true;
    if (method !== 'POST' || !action) return false;
    const b = await body(req);
    const list = await listFor(db, who.restaurantId, stationId, date);
    if (action === 'count') {
      const kind = (await db.query<{ kind: string }>('SELECT kind FROM station_items WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, String(b.itemId)])).rows[0]?.kind;
      if (list.status === 'approved' && kind !== 'batch') throw new HttpError(409, 'This list is already approved. A chef can reopen it.');
      const counted = num(b.counted, 'Count');
      await setLine(db, who, stationId, date, String(b.itemId), { counted });
      // A bulk count resets what's on hand.
      if (kind === 'batch' && counted !== null) await db.query("INSERT INTO bulk_ledger (restaurant_id, item_id, kind, set_to, by_staff) VALUES ($1, $2, 'counted', $3, $4)", [who.restaurantId, String(b.itemId), counted, who.staffId]);
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
      const itemId = String(b.itemId);
      const before = (await view(db, who, stationId, date)).lines.find((l) => l.id === itemId);
      // What was made is kept with the check-off, so its time can be compared with the same amount another day.
      const set = state === 'start' ? { started_at: new Date(), started_by: who.staffId }
        : state === 'done' ? { done_at: new Date(), done_by: who.staffId, made: before?.toMake ?? null }
        : { done_at: null, done_by: null, started_at: null, started_by: null, made: null };
      await setLine(db, who, stationId, date, itemId, set);
      // Bulk moves: a batch made adds to it; a station fill takes out of it; an undo reverses.
      await db.query("DELETE FROM bulk_ledger WHERE list_id = $1 AND line_item_id = $2 AND kind IN ('made', 'filled')", [list.id, itemId]);
      if (state === 'done' && before && (before.toMake ?? 0) > 0) {
        const item = (await db.query<{ kind: string; source_item_id: string | null; holds: string | null; batch_yield: string | null }>('SELECT kind, source_item_id, holds, batch_yield FROM station_items WHERE id = $1', [itemId])).rows[0]!;
        if (item.kind === 'batch' && item.batch_yield) await db.query("INSERT INTO bulk_ledger (restaurant_id, item_id, kind, change, list_id, line_item_id, by_staff) VALUES ($1, $2, 'made', $3, $4, $2, $5)", [who.restaurantId, itemId, before.toMake! * Number(item.batch_yield), list.id, who.staffId]);
        if (item.source_item_id && item.holds) await db.query("INSERT INTO bulk_ledger (restaurant_id, item_id, kind, change, list_id, line_item_id, by_staff) VALUES ($1, $2, 'filled', $3, $4, $5, $6)", [who.restaurantId, item.source_item_id, -before.toMake! * Number(item.holds), list.id, itemId, who.staffId]);
      }
    } else if (action === 'start') {
      // The list's own clock: "Start prep", tapped once when the station begins.
      if (list.status !== 'approved') throw new HttpError(409, 'This list hasn’t been approved yet.');
      if (b.undo === true) await db.query('UPDATE prep_lists SET work_started_at = NULL, work_started_by = NULL WHERE id = $1', [list.id]);
      else await db.query('UPDATE prep_lists SET work_started_at = coalesce(work_started_at, now()), work_started_by = coalesce(work_started_by, $1) WHERE id = $2', [who.staffId, list.id]);
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
