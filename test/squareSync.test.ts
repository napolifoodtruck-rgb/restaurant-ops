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
function fakeSquare(state: { team: any[]; items: any[]; modifiers: any[] }) {
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
      const all = isModifiers ? state.modifiers : state.items;
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

  const row = (day: string, id: string, name: string, q: number, s: number) => ({ 'ItemSales.reporting_day.day': `${day}T00:00:00.000`, 'ItemSales.item_variation_id': id, 'ItemSales.item_name': name, 'ItemSales.item_variation_name': 'Regular', 'ItemSales.category_name': 'Pizza', 'ItemSales.items_sold_count': q, 'ItemSales.item_net_sales': s });
  const state = {
    team: [
      { id: 'T-OWNER', given_name: 'Pat', family_name: 'Owner', email_address: 'OWNER@napoli.example', is_owner: true },
      { id: 'T-MARCO', given_name: 'Marco', family_name: 'Rossi', jobs: ['Line Cook'] },
      { id: 'T-JESS', given_name: 'Jess', family_name: 'Lee', jobs: ['Sous Chef', 'Line Cook'] },
      { id: 'T-NEW', given_name: 'Sam' }, // no wage setting yet
    ],
    items: [row('2026-10-03', 'V1', 'Margherita', 20, 300), row('2026-10-03', 'V1', 'Margherita', 2, 30), row('2026-10-04', 'V1', 'Margherita', 25, 375)],
    modifiers: [{ 'ItemSales.reporting_day.day': '2026-10-04T00:00:00.000', 'ItemSales.item_variation_id': 'V1', 'ItemSales.item_name': 'Margherita', 'ItemSales.item_variation_name': 'Regular', 'ItemSales.modifier_list_name': 'Extras', 'ItemSales.modifier_name': '++ Extra Mozzarella', 'ItemSales.modifier_net_quantity': 4.0000001, 'ItemSales.gross_sales': 12 }],
  };
  const square = fakeSquare(state);
  const api = new SquareApi('token', { fetch: square.fetch, sleep: noSleep });

  const first = await runSquareSync(db!, api, restaurantId, { today: '2026-10-05' });
  assert.equal(first.locationName, 'Napoli');
  assert.equal(first.from, '2026-06-08'); // 120 days back
  assert.equal(first.catalogObjects, 2);
  assert.deepEqual(first.team, { added: 3, updated: 1, deactivated: 0 });
  assert.equal(first.itemRows, 2); // the two Oct 3 rows merge

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
  assert.deepEqual(second.team, { added: 0, updated: 3, deactivated: 1 });
  const after = squareItemSales(await storedItemSales(db!, restaurantId, '2026-10-01', '2026-10-05'));
  assert.deepEqual(after.map((l) => [l.date, l.quantity]), [['2026-10-03', 22], ['2026-10-04', 26], ['2026-10-05', 18]]);

  // Nothing but reads went to Square.
  assert.ok(square.calls.every((c) => c.method === 'GET' || c.path === '/reporting/v1/load' || c.path === '/v2/team-members/search'));

  // The scheduler: due after 4 am local when today's sync hasn't run; quiet otherwise.
  const runs = (await db!.query<{ status: string }>("SELECT status FROM sync_runs WHERE source = 'square'")).rows;
  assert.deepEqual(runs.map((x) => x.status), ['ok', 'ok']);
  assert.equal(await syncDue(db!, { square: { token: 'later' }, marginedge: {} }, new Date('2026-10-06T09:00:00Z')), 0); // not connected
});
