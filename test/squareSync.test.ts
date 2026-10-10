import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SquareApi, type Fetch } from '../src/connectors/squareApi.ts';
import { squareItemSales, squareModifierSales } from '../src/connectors/square.ts';
import { guessRoleLevel, runSquareSync, storedItemSales, storedModifierSales } from '../src/server/squareSync.ts';
import { localDateHour, syncDue } from '../src/server/scheduler.ts';
import { migrate } from '../src/server/db.ts';
import { startTestDb } from './support/psqlDb.ts';

/** A pretend Square account. Records every call. */
function fakeSquare(state: { team: any[]; items: any[]; modifiers: any[]; orders?: any[]; orderLines?: any[]; timecards?: any[]; hourly?: any[] }) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let waited = false;
  const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  const fetch: Fetch = async (url, init) => {
    const path = url.replace('https://connect.squareup.com', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    if (path === '/v2/locations') return json(200, { locations: [{ id: 'L1', name: 'Napoli', status: 'ACTIVE', merchant_id: 'M1', timezone: 'America/New_York' }, { id: 'L0', name: 'Old truck', status: 'INACTIVE', merchant_id: 'M1' }] });
    if (path.startsWith('/v2/catalog/list')) {
      if (!path.includes('cursor=')) return json(200, { objects: [{ type: 'CATEGORY', id: 'C1', category_data: { name: 'Pizza' } }], cursor: 'p2' });
      return json(200, { objects: [{ type: 'ITEM', id: 'I1', item_data: { name: 'Margherita', variations: [{ id: 'V1', item_variation_data: { name: 'Regular', price_money: { amount: 1500 } } }] } }, { type: 'ITEM', id: 'GONE', is_deleted: true }] });
    }
    if (path === '/v2/team-members/search') return json(200, { team_members: state.team });
    const wage = path.match(/^\/v2\/team-members\/(.+)\/wage-setting$/);
    if (wage) {
      const m = state.team.find((t) => t.id === decodeURIComponent(wage[1]!));
      return m?.jobs ? json(200, { wage_setting: { job_assignments: m.jobs.map((j: string) => ({ job_title: j })) } }) : json(404, { errors: [{ code: 'NOT_FOUND' }] });
    }
    if (path === '/reporting/v1/load') {
      if (!waited) { waited = true; return json(200, { error: 'Continue wait' }); }
      const isModifiers = body.query.measures.includes('ItemSales.modifier_net_quantity');
      // Orders and order lines answer for the dates asked, like Square does.
      const [from, to] = body.query.timeDimensions?.[0]?.dateRange ?? [];
      const inRange = (rows: any[], cube: string) => rows.filter((x) => { const d = String(x[`${cube}.reporting_day.day`]).slice(0, 10); return (!from || d >= from) && (!to || d <= to); });
      const all = body.query.measures.includes('Labor.total_hours_worked') ? (state.timecards ?? []).filter((x) => { const d = String(x['Labor.clockin_timestamp']).slice(0, 10); return d >= from && d <= to; })
        : body.query.dimensions?.includes('Orders.local_hour') ? inRange(state.hourly ?? [], 'Orders')
        : body.query.measures.includes('Orders.cover_count') ? inRange(state.orders ?? [], 'Orders')
        : body.query.dimensions?.includes('ItemSales.order_id') ? inRange(state.orderLines ?? [], 'ItemSales')
        : isModifiers ? state.modifiers : state.items;
      return json(200, { data: all.slice(body.query.offset, body.query.offset + body.query.limit) });
    }
    return json(404, {});
  };
  return { fetch, calls };
}
const noSleep = async () => {};

test('job titles get a first-guess role level', () => {
  assert.equal(guessRoleLevel('Line Cook'), 'line');
  assert.equal(guessRoleLevel('Prep Cook'), 'line');
  assert.equal(guessRoleLevel('Pastry Chef'), 'line');
  assert.equal(guessRoleLevel('Sous Chef'), 'sous');
  assert.equal(guessRoleLevel('Executive Chef'), 'chef');
  assert.equal(guessRoleLevel('Kitchen Lead'), 'lead');
  assert.equal(guessRoleLevel('General Manager'), 'manager');
  assert.equal(guessRoleLevel('FOH Manager'), 'manager');
  assert.equal(guessRoleLevel('Server', true), 'owner');
});

test('the Square client is read-only, retries, waits for reports and pages through them', async () => {
  const square = fakeSquare({ team: [], modifiers: [], items: Array.from({ length: 5 }, (_, i) => ({ 'ItemSales.item_name': `Item ${i}` })) });
  const api = new SquareApi('token', { fetch: square.fetch, sleep: noSleep });
  const rows = await api.report({ measures: ['ItemSales.items_sold_count'] }, 2);
  assert.equal(rows.length, 5);
  assert.deepEqual(square.calls.map((c) => c.body?.query.offset), [0, 0, 2, 4]); // one "Continue wait", then 3 pages
  assert.equal(square.calls[0]!.method, 'POST');

  let tries = 0;
  const flaky = new SquareApi('t', { sleep: noSleep, fetch: async () => (++tries < 3 ? { ok: false, status: 429, json: async () => ({}), text: async () => '' } : { ok: true, status: 200, json: async () => ({ locations: [] }), text: async () => '' }) });
  assert.deepEqual(await flaky.locations(), []);
  assert.equal(tries, 3);

  const denied = new SquareApi('t', { fetch: async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] }), text: async () => '' }) });
  await assert.rejects(denied.locations(), /failed \(401\): This request could not be authorized/);
});

test('local date and hour in the restaurant’s time zone', () => {
  // 2026-10-06 03:30 UTC is still Oct 5, 11:30 pm in Carrboro.
  assert.deepEqual(localDateHour('America/New_York', new Date('2026-10-06T03:30:00Z')), { date: '2026-10-05', hour: 23 });
});

const db = startTestDb();

test('nightly Square sync into the database', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  const restaurantId = (await db!.query<{ id: string }>("INSERT INTO restaurants (name) VALUES ('Napoli') RETURNING id")).rows[0]!.id;
  // The owner set the app up by email before the first sync.
  await db!.query("INSERT INTO job_title_permissions (restaurant_id, job_title, role_level) VALUES ($1, 'Owner', 'owner')", [restaurantId]);
  await db!.query("INSERT INTO staff (restaurant_id, display_name, job_title, email) VALUES ($1, 'Owner', 'Owner', 'owner@napoli.example')", [restaurantId]);

  // Square's "items sold" counts each share of a split check as a whole item; net_quantity is the real amount.
  const row = (day: string, id: string, name: string, q: number, s: number, counted = q) => ({ 'ItemSales.reporting_day.day': `${day}T00:00:00.000`, 'ItemSales.item_variation_id': id, 'ItemSales.item_name': name, 'ItemSales.item_variation_name': 'Regular', 'ItemSales.category_name': 'Pizza', 'ItemSales.items_sold_count': counted, 'ItemSales.net_quantity': q, 'ItemSales.item_net_sales': s });
  const state = {
    team: [
      { id: 'T-OWNER', given_name: 'Pat', family_name: 'Owner', email_address: 'OWNER@napoli.example', is_owner: true },
      { id: 'T-MARCO', given_name: 'Marco', family_name: 'Rossi', jobs: ['Line Cook'] },
      { id: 'T-JESS', given_name: 'Jess', family_name: 'Lee', jobs: ['Sous Chef', 'Line Cook'] },
      { id: 'T-NEW', given_name: 'Sam' }, // no wage setting yet
    ],
    items: [row('2026-10-03', 'V1', 'Margherita', 20, 300), row('2026-10-03', 'V1', 'Margherita', 2, 30), row('2026-10-04', 'V1', 'Margherita', 25, 375, 31)],
    modifiers: [{ 'ItemSales.reporting_day.day': '2026-10-04T00:00:00.000', 'ItemSales.item_variation_id': 'V1', 'ItemSales.item_name': 'Margherita', 'ItemSales.item_variation_name': 'Regular', 'ItemSales.modifier_list_name': 'Extras', 'ItemSales.modifier_name': '++ Extra Mozzarella', 'ItemSales.modifier_net_quantity': 4.0000001, 'ItemSales.gross_sales': 12 }],
    // Orders: a table of four (split across two rows by Square), and an online order last year.
    orders: [
      { 'Orders.reporting_day.day': '2026-10-04T00:00:00.000', 'Orders.order_id': 'O1', 'Orders.table_name': 'T6', 'Orders.fulfillment_method': 'For Here', 'Orders.order_source': 'Point of Sale', 'Orders.team_member_attributed_to_id': 'T-MARCO', 'Orders.team_member_attributed_to_name': 'Marco Rossi', 'Orders.cover_count': 4, 'Orders.net_sales': 80, 'Orders.tips_amount': 16, 'Orders.auto_gratuity_amount': 0 },
      { 'Orders.reporting_day.day': '2026-10-04T00:00:00.000', 'Orders.order_id': 'O1', 'Orders.cover_count': 0, 'Orders.net_sales': 10, 'Orders.tips_amount': 2, 'Orders.auto_gratuity_amount': 0 },
      { 'Orders.reporting_day.day': '2025-10-10T00:00:00.000', 'Orders.order_id': 'O0', 'Orders.order_source': 'Square Online', 'Orders.cover_count': 0, 'Orders.net_sales': 30, 'Orders.tips_amount': 3, 'Orders.auto_gratuity_amount': 0 },
    ],
    timecards: [{ 'Labor.team_member_id': 'T-MARCO', 'Labor.job_title': 'Pizza Maker', 'Labor.clockin_timestamp': '2026-10-04T15:00:00.000', 'Labor.clockout_timestamp': '2026-10-04T22:30:00.000', 'Labor.hourly_wage': 12, 'Labor.total_hours_worked': 7.5, 'Labor.total_labor_cost': 90 }],
    hourly: [{ 'Orders.reporting_day.day': '2026-10-04T00:00:00.000', 'Orders.local_hour': 18, 'Orders.count': 9, 'Orders.cover_count': 20, 'Orders.net_sales': 700 }],
    orderLines: [{ 'ItemSales.reporting_day.day': '2026-10-04T00:00:00.000', 'ItemSales.order_id': 'O1', 'ItemSales.item_variation_id': 'V1', 'ItemSales.item_name': 'Margherita', 'ItemSales.item_variation_name': 'Regular', 'ItemSales.category_name': 'Pizza', 'ItemSales.items_sold_count': 2, 'ItemSales.net_quantity': 1.5000001, 'ItemSales.item_net_sales': 30 }],
  };
  const square = fakeSquare(state);
  const api = new SquareApi('token', { fetch: square.fetch, sleep: noSleep });

  const first = await runSquareSync(db!, api, restaurantId, { today: '2026-10-05' });
  assert.equal(first.locationName, 'Napoli');
  assert.equal(first.from, '2026-06-08'); // 120 days back
  assert.equal(first.catalogObjects, 2);
  assert.deepEqual(first.team, { added: 3, updated: 1, deactivated: 0 });
  assert.equal(first.itemRows, 2); // the two Oct 3 rows merge
  // Orders go back about a year the first time, a month at a time; one row per order.
  assert.deepEqual([first.orders, first.ordersFrom], [2, '2025-09-01']);
  const stored = (await db!.query<{ order_id: string; table_name: string | null; covers: number; net_sales: string; tips: string }>('SELECT order_id, table_name, covers, net_sales, tips FROM pos_orders WHERE restaurant_id = $1 ORDER BY day', [restaurantId])).rows;
  assert.deepEqual(stored.map((o) => [o.order_id, o.table_name, o.covers, Number(o.net_sales), Number(o.tips)]), [['O0', null, 0, 30, 3], ['O1', 'T6', 4, 90, 18]]);
  assert.deepEqual((await db!.query<{ quantity: string }>('SELECT quantity FROM pos_order_lines WHERE restaurant_id = $1', [restaurantId])).rows.map((x) => Number(x.quantity)), [1.5]); // a pizza split between checks
  // Timecards in local clock time, and sales by hour.
  const card = (await db!.query<{ day: string; clock_in: string; hours: string; labor_cost: string }>("SELECT day::text AS day, to_char(clock_in, 'YYYY-MM-DD HH24:MI') AS clock_in, hours, labor_cost FROM pos_timecards WHERE restaurant_id = $1", [restaurantId])).rows;
  assert.deepEqual(card.map((c) => [c.day, c.clock_in, Number(c.hours), Number(c.labor_cost)]), [['2026-10-04', '2026-10-04 15:00', 7.5, 90]]);
  assert.equal(Number((await db!.query<{ net_sales: string }>('SELECT net_sales FROM pos_sales_hourly WHERE restaurant_id = $1 AND hour = 18', [restaurantId])).rows[0]!.net_sales), 700);

  const staff = (await db!.query<{ display_name: string; job_title: string | null; pos_team_member_id: string; email: string | null }>('SELECT display_name, job_title, pos_team_member_id, email FROM staff WHERE restaurant_id = $1 ORDER BY display_name', [restaurantId])).rows;
  assert.deepEqual(staff.map((s) => [s.display_name, s.job_title, s.pos_team_member_id]), [['Jess L.', 'Sous Chef', 'T-JESS'], ['Marco R.', 'Line Cook', 'T-MARCO'], ['Owner', 'Owner', 'T-OWNER'], ['Sam', null, 'T-NEW']]);
  const levels = Object.fromEntries((await db!.query<{ job_title: string; role_level: string }>('SELECT job_title, role_level FROM job_title_permissions WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.job_title, r.role_level]));
  assert.deepEqual(levels, { Owner: 'owner', 'Line Cook': 'line', 'Sous Chef': 'sous' });
  const r = (await db!.query<{ pos_location_id: string; pos_merchant_id: string }>('SELECT pos_location_id, pos_merchant_id FROM restaurants WHERE id = $1', [restaurantId])).rows[0]!;
  assert.deepEqual([r.pos_location_id, r.pos_merchant_id], ['L1', 'M1']);

  // Stored rows read back exactly as square.ts expects them from the API.
  const lines = squareItemSales(await storedItemSales(db!, restaurantId, '2026-10-01', '2026-10-05'));
  assert.deepEqual(lines.map((l) => [l.date, l.name, l.quantity, l.netSales]), [['2026-10-03', 'Margherita', 22, 330], ['2026-10-04', 'Margherita', 25, 375]]);
  const mods = squareModifierSales(await storedModifierSales(db!, restaurantId, '2026-10-01', '2026-10-05'));
  assert.deepEqual(mods.map((m) => [m.date, m.modifier.name, m.quantity, m.modifier.price]), [['2026-10-04', '++ Extra Mozzarella', 4, 3]]);

  // Next night: only recent days are fetched again; a late ticket on Oct 4 replaces that day; Sam left.
  state.items = [row('2026-10-03', 'V1', 'Margherita', 22, 330), row('2026-10-04', 'V1', 'Margherita', 26, 390), row('2026-10-05', 'V1', 'Margherita', 18, 270)];
  state.team = state.team.filter((m) => m.id !== 'T-NEW');
  const second = await runSquareSync(db!, api, restaurantId, { today: '2026-10-05' });
  assert.equal(second.from, '2026-10-01');
  assert.equal(second.ordersFrom, '2026-10-01'); // orders too: just the last few days again
  assert.equal((await db!.query('SELECT 1 FROM pos_orders WHERE restaurant_id = $1', [restaurantId])).rows.length, 2);
  assert.deepEqual(second.team, { added: 0, updated: 3, deactivated: 1 });
  const after = squareItemSales(await storedItemSales(db!, restaurantId, '2026-10-01', '2026-10-05'));
  assert.deepEqual(after.map((l) => [l.date, l.quantity]), [['2026-10-03', 22], ['2026-10-04', 26], ['2026-10-05', 18]]);

  // Rows saved with the old split-check count are pulled again, from the first of them.
  await db!.query("INSERT INTO pos_item_sales_daily (restaurant_id, day, catalog_id, item_name, variation_name, category, quantity, net_sales) VALUES ($1, '2026-09-01', 'V1', 'Margherita', 'Regular', 'Pizza', 8, 30)", [restaurantId]);
  await db!.query("INSERT INTO pos_order_lines (restaurant_id, order_id, day, catalog_id, item_name, quantity, net_sales) VALUES ($1, 'O0', '2025-10-10', 'V1', 'Margherita', 8, 30)", [restaurantId]);
  const third = await runSquareSync(db!, api, restaurantId, { today: '2026-10-05' });
  assert.deepEqual([third.from, third.ordersFrom], ['2026-09-01', '2025-10-10']);
  assert.equal((await db!.query('SELECT 1 FROM pos_item_sales_daily WHERE restaurant_id = $1 AND NOT true_quantity UNION ALL SELECT 1 FROM pos_order_lines WHERE restaurant_id = $1 AND NOT true_quantity', [restaurantId])).rows.length, 0);

  // Nothing but reads went to Square.
  assert.ok(square.calls.every((c) => c.method === 'GET' || c.path === '/reporting/v1/load' || c.path === '/v2/team-members/search'));

  // The scheduler: due after 4 am local when today's sync hasn't run; quiet otherwise.
  const runs = (await db!.query<{ status: string }>("SELECT status FROM sync_runs WHERE source = 'square'")).rows;
  assert.deepEqual(runs.map((x) => x.status), ['ok', 'ok', 'ok']);
  assert.equal(await syncDue(db!, { square: { token: 'later' }, marginedge: {} }, new Date('2026-10-06T09:00:00Z')), 0); // not connected
});
