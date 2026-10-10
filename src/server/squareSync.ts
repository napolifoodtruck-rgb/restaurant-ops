/**
 * Nightly copy from Square: the location, the catalog, the team with their job titles, and
 * item and modifier sales by day. Recent days are pulled again each night, since late
 * tickets and refunds land on earlier days.
 */

import type { Db } from './db.ts';
import type { SquareApi } from '../connectors/squareApi.ts';
import type { SquareItemSalesRow } from '../connectors/square.ts';
import type { RoleLevel } from '../core/stationPrep.ts';
import { midnightOf } from './dough.ts';
import { addDays } from '../core/dashboard.ts';

export interface SquareSyncOptions {
  /** Days to fetch on the first sync. Default 120. */
  firstDays?: number;
  /** Days to fetch again on later syncs. Default 4. */
  refreshDays?: number;
  /** Days of orders to fetch the first time, for reports against last year. Default 400. */
  orderDays?: number;
  /** Which location, when the account has several. Default: the only active one. */
  locationId?: string;
  today?: string;
}

export interface SquareSyncResult {
  locationName: string;
  from: string;
  to: string;
  catalogObjects: number;
  team: { added: number; updated: number; deactivated: number };
  itemRows: number;
  modifierRows: number;
  orders?: number;
  ordersFrom?: string;
}

/** A first guess at what a Square job title can see; a manager can change it. */
export function guessRoleLevel(jobTitle: string, isOwner = false): RoleLevel {
  const t = jobTitle.toLowerCase();
  if (isOwner || /\bowner\b|\bproprietor\b/.test(t)) return 'owner';
  if (/\bsous\b/.test(t)) return 'sous';
  if (/(executive|head)\s+chef|chef de cuisine|\bchef\b/.test(t) && !/\bline\b|\bprep\b|\bpastry\b/.test(t)) return 'chef';
  if (/\b(gm|general manager|manager|director)\b/.test(t)) return 'manager';
  if (/\blead\b|\bsupervisor\b|\bkey ?holder\b/.test(t)) return 'lead';
  return 'line';
}

const dayOf = (iso: Date) => iso.toISOString().slice(0, 10);
function minusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return dayOf(d);
}

export async function insertMany(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const per = Math.floor(30000 / columns.length);
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const values = chunk.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, params);
  }
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const number = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const rowDay = (r: SquareItemSalesRow) => text(r['ItemSales.reporting_day.day'] ?? r['ItemSales.reporting_day']).slice(0, 10);

/** Sums rows that collapse to the same key (Square can split one item across rows). */
function merge<K extends string>(rows: { key: string; values: Record<K, number>; cols: unknown[] }[]): { cols: unknown[]; values: Record<K, number> }[] {
  const out = new Map<string, { cols: unknown[]; values: Record<K, number> }>();
  for (const r of rows) {
    const seen = out.get(r.key);
    if (!seen) out.set(r.key, { cols: r.cols, values: { ...r.values } });
    else for (const k of Object.keys(r.values) as K[]) seen.values[k] += r.values[k];
  }
  return [...out.values()];
}

/** Square's business day starts an hour after midnight (its Reporting setting): a 12:30am sale is the night before's. */
const DAY_START_MINUTES = 60;

export interface OpenLine { orderId: string; day: string; catalogId: string; itemName: string; variationName: string; quantity: number; netSales: number; modifiers: { id: string; name: string; quantity: number; gross: number }[] }

/**
 * What's on orders still open in Square with money still to collect, line by line: a gelato at the
 * counter whose card was authorized but the check never closed. Square's item reports leave them out
 * (its Net sales doesn't). Each on its business day; net of discounts, before tax.
 */
export function openOrderLines(orders: readonly any[], timezone: string): OpenLine[] {
  const dayOf = (iso: string) => new Date(Date.parse(iso) - DAY_START_MINUTES * 60_000).toLocaleDateString('en-CA', { timeZone: timezone });
  const cents = (m: any) => Number(m?.amount ?? 0) / 100;
  // Fully paid ones (an online pickup paid in full) count as closed checks: Square's item report has them already.
  return orders.filter((o) => o.state === 'OPEN' && o.created_at && Number(o.net_amount_due_money?.amount ?? 0) > 0).flatMap((o) => (o.line_items ?? []).map((l: any) => ({
    orderId: String(o.id), day: dayOf(o.created_at), catalogId: text(l.catalog_object_id), itemName: text(l.name), variationName: text(l.variation_name),
    quantity: number(l.quantity), netSales: Math.round((cents(l.total_money) - cents(l.total_tax_money)) * 100) / 100,
    modifiers: (l.modifiers ?? []).map((m: any) => ({ id: text(m.catalog_object_id), name: text(m.name), quantity: number(m.quantity ?? 1) * number(l.quantity), gross: cents(m.total_price_money) })),
  })));
}

/** Open orders' lines for these business days; none if Square won't say (a sync never fails on it). */
async function openLinesFor(api: SquareApi, locationId: string, from: string, to: string, timezone: string): Promise<OpenLine[]> {
  try {
    const shift = (iso: string) => new Date(Date.parse(iso) + DAY_START_MINUTES * 60_000).toISOString();
    const lines = openOrderLines(await api.openOrders(locationId, shift(midnightOf(from, timezone)), shift(midnightOf(addDays(to, 1), timezone))), timezone);
    return lines.filter((l) => l.day >= from && l.day <= to);
  } catch (err) {
    console.error(`square sync: couldn’t read open orders: ${(err as Error).message}`);
    return [];
  }
}

export async function runSquareSync(db: Db, api: SquareApi, restaurantId: string, options: SquareSyncOptions = {}): Promise<SquareSyncResult> {
  const run = await db.query<{ id: string }>("INSERT INTO sync_runs (restaurant_id, source) VALUES ($1, 'square') RETURNING id", [restaurantId]);
  const runId = run.rows[0]!.id;
  try {
    const result = await sync(db, api, restaurantId, options);
    await db.query("UPDATE sync_runs SET status = 'ok', finished_at = now(), detail = $1 WHERE id = $2", [JSON.stringify(result), runId]);
    return result;
  } catch (err) {
    await db.query("UPDATE sync_runs SET status = 'failed', finished_at = now(), detail = $1 WHERE id = $2", [JSON.stringify({ error: (err as Error).message }), runId]);
    throw err;
  }
}

async function sync(db: Db, api: SquareApi, restaurantId: string, options: SquareSyncOptions): Promise<SquareSyncResult> {
  // Location.
  const locations = (await api.locations()).filter((l) => l.status === 'ACTIVE');
  const location = options.locationId ? locations.find((l) => l.id === options.locationId) : locations.length === 1 ? locations[0] : undefined;
  if (!location) {
    throw new Error(options.locationId
      ? `Square location ${options.locationId} isn't active on this account.`
      : `This Square account has ${locations.length} active locations (${locations.map((l) => `${l.name}: ${l.id}`).join(', ')}). Set SQUARE_LOCATION_ID to pick one.`);
  }
  await db.query('UPDATE restaurants SET pos_merchant_id = $1, pos_location_id = $2, timezone = coalesce($3, timezone) WHERE id = $4', [location.merchantId, location.id, location.timezone ?? null, restaurantId]);

  // Catalog: replaced as a whole.
  const catalog = (await api.catalog()).filter((o) => !o.is_deleted);
  await db.query('DELETE FROM pos_catalog WHERE restaurant_id = $1', [restaurantId]);
  await insertMany(db, 'pos_catalog', ['restaurant_id', 'object_id', 'type', 'data'], catalog.map((o) => [restaurantId, o.id, o.type, JSON.stringify(o)]));

  // Team: matched on Square's id; people no longer active in Square are deactivated, not deleted.
  const team = await api.teamMembers(location.id);
  const existing = new Map((await db.query<{ id: string; pos_team_member_id: string | null; active: boolean }>('SELECT id, pos_team_member_id, active FROM staff WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.pos_team_member_id, r]));
  const known = new Set((await db.query<{ job_title: string }>('SELECT job_title FROM job_title_permissions WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => r.job_title));
  let added = 0, updated = 0;
  for (const m of team) {
    const jobTitle = m.isOwner ? 'Owner' : m.jobTitles[0] ?? null;
    for (const title of m.isOwner ? ['Owner'] : m.jobTitles) {
      if (known.has(title)) continue;
      await db.query('INSERT INTO job_title_permissions (restaurant_id, job_title, role_level) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [restaurantId, title, guessRoleLevel(title, m.isOwner)]);
      known.add(title);
    }
    if (existing.has(m.id)) {
      await db.query('UPDATE staff SET display_name = $1, job_title = $2, active = true WHERE restaurant_id = $3 AND pos_team_member_id = $4', [m.name, jobTitle, restaurantId, m.id]);
      updated++;
    } else {
      // The owner who set the app up may already exist by email: link rather than duplicate.
      const byEmail = m.email ? await db.query<{ id: string }>('UPDATE staff SET pos_team_member_id = $1 WHERE restaurant_id = $2 AND lower(email) = lower($3) AND pos_team_member_id IS NULL RETURNING id', [m.id, restaurantId, m.email]) : { rows: [] };
      if (byEmail.rows.length) updated++;
      else {
        await db.query('INSERT INTO staff (restaurant_id, pos_team_member_id, display_name, job_title) VALUES ($1, $2, $3, $4)', [restaurantId, m.id, m.name, jobTitle]);
        added++;
      }
    }
  }
  const activeIds = team.map((m) => m.id);
  const gone = await db.query('UPDATE staff SET active = false WHERE restaurant_id = $1 AND active AND pos_team_member_id IS NOT NULL AND NOT (pos_team_member_id = ANY(string_to_array($2, \',\'))) RETURNING id', [restaurantId, activeIds.join(',')]);

  // Sales by day: the first sync goes back further; later syncs redo the last few days.
  const today = options.today ?? dayOf(new Date());
  const last = (await db.query<{ day: string | null }>('SELECT max(day)::text AS day FROM pos_item_sales_daily WHERE restaurant_id = $1', [restaurantId])).rows[0]?.day;
  // Days saved with the old split-check count are pulled again, all of them.
  const stale = (await db.query<{ day: string | null }>('SELECT min(day)::text AS day FROM pos_item_sales_daily WHERE restaurant_id = $1 AND NOT true_quantity', [restaurantId])).rows[0]?.day;
  const recent = last ? minusDays(last < today ? last : today, (options.refreshDays ?? 4) - 1) : minusDays(today, (options.firstDays ?? 120) - 1);
  const from = stale && stale < recent ? stale : recent;
  const to = today;

  const tz = location.timezone ?? (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [restaurantId])).rows[0]?.timezone ?? 'America/New_York';
  const itemRows = (await api.itemSalesByDay(location.id, from, to)).filter(rowDay);
  // Orders still open (paid at the counter or online, never marked done) are left out of Square's item
  // report: added from the orders themselves, with each item's category as Square reports it.
  const categoryOf = await categoriesFrom(db, restaurantId, catalog, itemRows);
  const listOf = modifierListsOf(catalog);
  const open = await openLinesFor(api, location.id, from, to, tz);
  const items = merge([
    ...itemRows.map((r) => {
      const cols = [restaurantId, rowDay(r), text(r['ItemSales.item_variation_id']), text(r['ItemSales.item_name']), text(r['ItemSales.item_variation_name']), text(r['ItemSales.category_name'])];
      return { key: cols.join('\u0000'), cols, values: { quantity: quantityOf(r), sales: number(r['ItemSales.item_net_sales']) } };
    }),
    ...open.map((l) => {
      const cols = [restaurantId, l.day, l.catalogId, l.itemName, l.variationName, categoryOf(l.catalogId)];
      return { key: cols.join('\u0000'), cols, values: { quantity: l.quantity, sales: l.netSales } };
    }),
  ]);
  const modifiers = merge([
    ...(await api.modifierSalesByDay(location.id, from, to)).filter((r) => rowDay(r) && text(r['ItemSales.modifier_name'])).map((r) => {
      const cols = [restaurantId, rowDay(r), text(r['ItemSales.item_variation_id']), text(r['ItemSales.item_name']), text(r['ItemSales.item_variation_name']), text(r['ItemSales.modifier_list_name']), text(r['ItemSales.modifier_name'])];
      return { key: cols.join('\u0000'), cols, values: { quantity: number(r['ItemSales.modifier_net_quantity']), sales: number(r['ItemSales.gross_sales']) } };
    }),
    ...open.flatMap((l) => l.modifiers.filter((m) => m.name).map((m) => {
      const cols = [restaurantId, l.day, l.catalogId, l.itemName, l.variationName, listOf.get(m.id) ?? '', m.name];
      return { key: cols.join('\u0000'), cols, values: { quantity: m.quantity, sales: m.gross } };
    })),
  ]);
  await db.query('DELETE FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
  await db.query('DELETE FROM pos_modifier_sales_daily WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
  await insertMany(db, 'pos_item_sales_daily', ['restaurant_id', 'day', 'catalog_id', 'item_name', 'variation_name', 'category', 'quantity', 'net_sales', 'true_quantity'], items.map((r) => [...r.cols, Math.round(r.values.quantity * 1000) / 1000, Math.round(r.values.sales * 100) / 100, true]));
  await insertMany(db, 'pos_modifier_sales_daily', ['restaurant_id', 'day', 'catalog_id', 'item_name', 'variation_name', 'modifier_list', 'modifier_name', 'quantity', 'gross_sales'], modifiers.map((r) => [...r.cols, r.values.quantity, Math.round(r.values.sales * 100) / 100]));

  const orders = await syncOrders(db, api, restaurantId, location.id, today, options, tz, categoryOf);

  return {
    locationName: location.name,
    from,
    to,
    catalogObjects: catalog.length,
    team: { added, updated, deactivated: gone.rows.length },
    itemRows: items.length,
    modifierRows: modifiers.length,
    orders: orders.count,
    ordersFrom: orders.from,
  };
}

/** Each size's category as Square's item report names it: from its rows, what's saved, or the catalog. */
async function categoriesFrom(db: Db, restaurantId: string, catalog: readonly any[], rows: readonly SquareItemSalesRow[]): Promise<(catalogId: string) => string> {
  const out = new Map<string, string>();
  const names = new Map(catalog.filter((o) => o.type === 'CATEGORY').map((o) => [o.id, text(o.category_data?.name)]));
  for (const o of catalog) {
    if (o.type !== 'ITEM') continue;
    const d = o.item_data ?? {};
    const name = names.get(d.reporting_category?.id ?? d.categories?.[0]?.id ?? d.category_id);
    if (name) for (const v of d.variations ?? []) out.set(v.id, name);
  }
  for (const r of (await db.query<{ catalog_id: string; category: string | null }>('SELECT DISTINCT ON (catalog_id) catalog_id, category FROM pos_item_sales_daily WHERE restaurant_id = $1 ORDER BY catalog_id, day DESC', [restaurantId])).rows) if (r.category) out.set(r.catalog_id, r.category);
  for (const r of rows) { const id = text(r['ItemSales.item_variation_id']), c = text(r['ItemSales.category_name']); if (id && c) out.set(id, c); }
  return (id) => (id && out.get(id)) || '';
}

/** Modifier id → its list's name. */
function modifierListsOf(catalog: readonly any[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of catalog) if (o.type === 'MODIFIER_LIST') for (const m of o.modifier_list_data?.modifiers ?? []) out.set(m.id, text(o.modifier_list_data?.name));
  return out;
}

/** How many sold: Square's real quantity (a bottle split four ways is four quarters, one bottle). */
const quantityOf = (r: SquareItemSalesRow) => number(r['ItemSales.net_quantity'] ?? r['ItemSales.items_sold_count']);

const orderDay = (r: SquareItemSalesRow, cube: string) => text(r[`${cube}.reporting_day.day`] ?? r[`${cube}.reporting_day`]).slice(0, 10);

/**
 * Orders and what was on them, for reports. The first sync goes back about a year (so a period
 * can be set against the same one last year), a month at a time; later syncs redo the last few days.
 */
async function syncOrders(db: Db, api: SquareApi, restaurantId: string, locationId: string, today: string, options: SquareSyncOptions, tz: string, categoryOf: (catalogId: string) => string): Promise<{ count: number; from: string }> {
  // Each kind keeps its own window, so a kind added later still goes back a year the first time.
  const startFor = async (table: string) => {
    const last = (await db.query<{ day: string | null }>(`SELECT max(day)::text AS day FROM ${table} WHERE restaurant_id = $1`, [restaurantId])).rows[0]?.day;
    return last ? minusDays(last < today ? last : today, (options.refreshDays ?? 4) - 1) : minusDays(today, (options.orderDays ?? 400) - 1);
  };
  // Order lines saved with the old split-check count are pulled again, from the first of them.
  const staleLines = (await db.query<{ day: string | null }>('SELECT min(day)::text AS day FROM pos_order_lines WHERE restaurant_id = $1 AND NOT true_quantity', [restaurantId])).rows[0]?.day;
  const recentOrders = await startFor('pos_orders');
  const start = staleLines && staleLines < recentOrders ? staleLines : recentOrders;
  const laborStart = await startFor('pos_sales_hourly');
  let count = 0;
  for (let from = start < laborStart ? start : laborStart; from <= today; from = minusDays(from, -31)) {
    const to = minusDays(from, -30) < today ? minusDays(from, -30) : today;
    const cents = (x: number) => Math.round(x * 100) / 100;
    if (to >= start) {
      const orders = (await api.ordersByDay(locationId, from, to)).filter((r) => text(r['Orders.order_id']) && orderDay(r, 'Orders'));
      const lines = (await api.orderLinesByDay(locationId, from, to)).filter((r) => text(r['ItemSales.order_id']) && orderDay(r, 'ItemSales'));
      await db.query('DELETE FROM pos_orders WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
      await db.query('DELETE FROM pos_order_lines WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
      // One row per order (Square can split one across rows).
      type Row = { cols: (string | null)[]; covers: number; sales: number; tips: number; grat: number };
      const byId = new Map<string, Row>();
      for (const r of orders) {
        const id = text(r['Orders.order_id']);
        const row = byId.get(id) ?? { cols: [id, orderDay(r, 'Orders'), text(r['Orders.table_name']) || null, text(r['Orders.fulfillment_method']) || null, text(r['Orders.order_source']) || null,
          text(r['Orders.team_member_attributed_to_id']) || null, text(r['Orders.team_member_attributed_to_name']) || null], covers: 0, sales: 0, tips: 0, grat: 0 };
        row.covers += number(r['Orders.cover_count']); row.sales += number(r['Orders.net_sales_minus_auto_gratuity']);
        row.tips += number(r['Orders.tips_amount']); row.grat += number(r['Orders.auto_gratuity_amount']);
        byId.set(id, row);
      }
      await insertMany(db, 'pos_orders', ['restaurant_id', 'order_id', 'day', 'table_name', 'fulfillment', 'source', 'server_id', 'server_name', 'covers', 'net_sales', 'tips', 'auto_gratuity'],
        [...byId.values()].map((o) => [restaurantId, ...o.cols, Math.round(o.covers), cents(o.sales), cents(o.tips), cents(o.grat)]));
      // What's on orders still open, which Square's item report leaves out (the order itself is in the orders above).
      const seen = new Set(lines.map((r) => text(r['ItemSales.order_id'])));
      const open = (await openLinesFor(api, locationId, from, to, tz)).filter((l) => !seen.has(l.orderId));
      await insertMany(db, 'pos_order_lines', ['restaurant_id', 'order_id', 'day', 'catalog_id', 'item_name', 'variation_name', 'category', 'quantity', 'net_sales', 'true_quantity'], [
        ...lines.map((r) => [restaurantId, text(r['ItemSales.order_id']), orderDay(r, 'ItemSales'), text(r['ItemSales.item_variation_id']) || null, text(r['ItemSales.item_name']), text(r['ItemSales.item_variation_name']) || null,
          text(r['ItemSales.category_name']) || null, Math.round(quantityOf(r) * 1000) / 1000, Math.round(number(r['ItemSales.item_net_sales']) * 100) / 100, true]),
        ...open.map((l) => [restaurantId, l.orderId, l.day, l.catalogId || null, l.itemName, l.variationName || null, categoryOf(l.catalogId) || null, Math.round(l.quantity * 1000) / 1000, l.netSales, true])]);
      count += byId.size;
    }

    if (to < laborStart) continue;
    // Timecards (clocked in on these days) and sales by hour, for labor and the day-and-hour view.
    const local = (v: unknown) => text(v).replace('T', ' ').slice(0, 19);
    const cards = (await api.timecards(locationId, from, to, tz)).filter((r) => text(r['Labor.clockin_timestamp']) && text(r['Labor.clockout_timestamp']));
    await db.query('DELETE FROM pos_timecards WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
    const seenCard = new Set<string>();
    await insertMany(db, 'pos_timecards', ['restaurant_id', 'team_member_id', 'day', 'job_title', 'clock_in', 'clock_out', 'hourly_wage', 'hours', 'labor_cost'],
      cards.filter((r) => { const k = `${text(r['Labor.team_member_id'])}|${local(r['Labor.clockin_timestamp'])}`; if (seenCard.has(k)) return false; seenCard.add(k); return true; })
        .map((r) => [restaurantId, text(r['Labor.team_member_id']), local(r['Labor.clockin_timestamp']).slice(0, 10), text(r['Labor.job_title']) || null, local(r['Labor.clockin_timestamp']), local(r['Labor.clockout_timestamp']),
          r['Labor.hourly_wage'] === null || r['Labor.hourly_wage'] === undefined ? null : number(r['Labor.hourly_wage']), Math.round(number(r['Labor.total_hours_worked']) * 1000) / 1000, cents(number(r['Labor.total_labor_cost']))]));
    const hourly = new Map<string, { day: string; hour: number; orders: number; covers: number; sales: number }>();
    for (const r of await api.salesByHour(locationId, from, to)) {
      const day = orderDay(r, 'Orders'), hour = Number(r['Orders.local_hour']);
      if (!day || !(hour >= 0 && hour <= 23)) continue;
      const k = `${day}|${hour}`;
      const x = hourly.get(k) ?? { day, hour, orders: 0, covers: 0, sales: 0 };
      x.orders += number(r['Orders.count']); x.covers += number(r['Orders.cover_count']); x.sales += number(r['Orders.net_sales_minus_auto_gratuity']);
      hourly.set(k, x);
    }
    await db.query('DELETE FROM pos_sales_hourly WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3', [restaurantId, from, to]);
    await insertMany(db, 'pos_sales_hourly', ['restaurant_id', 'day', 'hour', 'orders', 'covers', 'net_sales'], [...hourly.values()].map((x) => [restaurantId, x.day, x.hour, Math.round(x.orders), Math.round(x.covers), cents(x.sales)]));
  }
  return { count, from: start };
}

/** Sales rows back out of the database in the Reporting API's shape, for square.ts to read. */
export async function storedItemSales(db: Db, restaurantId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
  const { rows } = await db.query<{ day: string; catalog_id: string; item_name: string; variation_name: string; category: string; quantity: string; net_sales: string }>(
    'SELECT day::text AS day, catalog_id, item_name, variation_name, category, quantity, net_sales FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day',
    [restaurantId, from, to],
  );
  return rows.map((r) => ({
    'ItemSales.reporting_day.day': r.day,
    'ItemSales.item_variation_id': r.catalog_id,
    'ItemSales.item_name': r.item_name,
    'ItemSales.item_variation_name': r.variation_name || null,
    'ItemSales.category_name': r.category || null,
    'ItemSales.items_sold_count': Number(r.quantity),
    'ItemSales.item_net_sales': Number(r.net_sales),
  }));
}

export async function storedModifierSales(db: Db, restaurantId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
  const { rows } = await db.query<{ day: string; catalog_id: string; item_name: string; variation_name: string; modifier_list: string; modifier_name: string; quantity: string; gross_sales: string }>(
    'SELECT day::text AS day, catalog_id, item_name, variation_name, modifier_list, modifier_name, quantity, gross_sales FROM pos_modifier_sales_daily WHERE restaurant_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day',
    [restaurantId, from, to],
  );
  return rows.map((r) => ({
    'ItemSales.reporting_day.day': r.day,
    'ItemSales.item_variation_id': r.catalog_id,
    'ItemSales.item_name': r.item_name,
    'ItemSales.item_variation_name': r.variation_name || null,
    'ItemSales.modifier_list_name': r.modifier_list || null,
    'ItemSales.modifier_name': r.modifier_name,
    'ItemSales.modifier_net_quantity': Number(r.quantity),
    'ItemSales.gross_sales': Number(r.gross_sales),
  }));
}
