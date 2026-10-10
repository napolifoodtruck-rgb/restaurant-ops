// The dough count end to end against a real PostgreSQL, with Square's orders faked: the kitchen's
// counts, the takeout number, online ordering stopping when takeout runs out and starting again.
// Skipped when PostgreSQL binaries aren't installed or when running as root (initdb refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { resetDoughCache } from '../src/server/dough.ts';
import type { Fetch } from '../src/connectors/squareApi.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('the dough count', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  resetDoughCache();

  // Square, faked: today's orders, as the order search returns them; only reads come here.
  const orders: any[] = [];
  const searches: any[] = [];
  const fakeFetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    const body = JSON.parse(init.body ?? '{}');
    if (path === '/v2/orders/search') { searches.push(body); return reply(200, { orders: orders.filter((o) => body.query.filter.state_filter.states.includes(o.state)) }); }
    if (path === '/v2/catalog/batch-retrieve') return reply(200, { objects: [] });
    return reply(404, {});
  };
  const now = { date: '', time: '16:00' };
  const app = createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false,
    checkout: { token: 'sandbox-token', applicationId: 'sandbox-app', locationId: 'loc-1', environment: 'sandbox', fetch: fakeFetch, now: () => now, refundCheckMs: 0, catalogCheckMs: 0, triesPerFiveMinutes: 100 } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { body?: object; cookies?: string[] } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.cookies?.length) headers.cookie = opts.cookies.join('; ');
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]!) };
  };

  const owner = (await call('POST', '/api/setup', { body: { token: 'setup-secret', restaurantName: 'Napoli', name: 'Pat', email: 'pat@example.com', password: 'a long enough one' } })).cookies;
  const rid = (await db!.query<{ id: string }>('SELECT id FROM restaurants')).rows[0]!.id;
  for (const [id, name] of [['flour', 'Flour, 00'], ['rice', 'Flour, Rice'], ['mozz', 'Cheese, Mozzarella'], ['milk', 'Milk, Whole']]) {
    await db!.query("INSERT INTO ingredients (restaurant_id, id, name, base_unit, source) VALUES ($1, $2, $3, 'g', 'app')", [rid, id, name]);
  }
  const card = (name: string, lines: [number, string, string][], extra: object = {}) => ({ name, yields: [{ amount: 1, unit: 'each' }], ingredients: lines.map(([amount, unit, n]) => ({ amount, unit, name: n, yieldPercent: 100 })), unreadLines: [], layout: 'card', category: 'Menu items', ...extra });
  assert.equal((await call('POST', '/api/book/import', { cookies: owner, body: { format: 'kitchen-book', recipeCards: [
    card('Pizza Dough', [[250, 'g', 'Flour, 00']], { category: 'Prep', recipeType: 'Prep' }),
    card('Gluten Free Dough', [[250, 'g', 'Flour, Rice']], { category: 'Prep', recipeType: 'Prep' }),
    card('Margherita', [[1, 'each', 'Pizza Dough'], [80, 'g', 'Cheese, Mozzarella']], { recipeType: 'Pizza' }),
    card('Breadsticks', [[1, 'each', 'Pizza Dough']], { recipeType: 'Pizza' }),
    card('Gelato', [[120, 'g', 'Milk, Whole']]),
  ] } })).status, 200);

  // Square's categories, as last sold: the pizzas are in Pizza; the breadsticks and gelato aren't.
  for (const [id, name, category] of [['var-marg', 'Margherita', 'Pizza'], ['var-bread', 'Neapolitan Breadsticks', 'Apps'], ['var-gelato', 'Gelato', 'Gelato'], ['var-meat', 'Meatball App', 'Apps']]) {
    await db!.query("INSERT INTO pos_item_sales_daily (restaurant_id, day, catalog_id, item_name, category, quantity, net_sales) VALUES ($1, current_date - 3, $2, $3, $4, 1, 10)", [rid, id, name, category]);
  }

  // The front-of-house iPad at the counter, nobody signed in.
  const counter = (await call('POST', '/api/floor/posts', { cookies: owner, body: { name: 'Counter', kind: 'counter', tables: '' } })).json.id;
  const ipad = (await call('POST', '/api/devices', { cookies: owner, body: { name: 'Counter POS', floorPostId: counter } })).cookies;

  // Nothing yet: no start, no takeout number; it reads today from the restaurant's midnight.
  let v = (await call('GET', '/api/floor/dough', { cookies: ipad })).json;
  now.date = v.day;
  assert.equal(v.dough.left, undefined);
  assert.equal(v.takeout.cap, undefined);
  assert.equal(v.takeoutOut, false);
  assert.deepEqual(searches[0].query.filter.state_filter.states, ['OPEN', 'COMPLETED']);
  assert.match(searches[0].query.filter.date_time_filter.created_at.start_at, /T0[45]:00:00\.000Z$/);

  // Tonight's orders: two pizzas at a table, three online, a phone order with breadsticks and a
  // gluten-free pizza, a gelato at the counter, and a cancelled table.
  const at = (o: object) => ({ id: `o${orders.length}`, state: 'OPEN', ...o });
  orders.push(
    at({ ticket_name: 'T9 - 3', state: 'COMPLETED', line_items: [{ catalog_object_id: 'var-marg', name: 'Margherita', quantity: '2' }, { catalog_object_id: 'var-meat', name: 'Meatball App', quantity: '1', modifiers: [{ name: '-- No Focaccia; Sub Gluten Free' }] }] }),
    at({ source: { name: 'Square Online' }, line_items: [{ catalog_object_id: 'var-marg', name: 'Margherita', quantity: '3' }] }),
    at({ ticket_name: 'Sam to go', line_items: [{ catalog_object_id: 'var-bread', name: 'Neapolitan Breadsticks', quantity: '1' }, { catalog_object_id: 'var-marg', name: 'Margherita', quantity: '1', modifiers: [{ name: 'Gluten Sensitive Crust' }] }] }),
    at({ line_items: [{ catalog_object_id: 'var-gelato', name: 'Gelato', quantity: '1' }] }),
    at({ ticket_name: 'T2', state: 'CANCELED', line_items: [{ catalog_object_id: 'var-marg', name: 'Margherita', quantity: '4' }] }),
  );

  // Managers set each weekday's presets; the night starts from them, nothing typed.
  const weekday = new Date(`${now.date}T12:00:00Z`).getUTCDay();
  const preset = (n: number) => { const w = [null, null, null, null, null, null, null] as (number | null)[]; w[weekday] = n; return w; };
  assert.equal((await call('POST', '/api/floor/dough/settings', { cookies: ipad, body: { takeoutByWeekday: preset(5) } })).status, 403, 'not from a board with no one signed in');
  const s = (await call('POST', '/api/floor/dough/settings', { cookies: owner, body: { doughByWeekday: preset(120), gfByWeekday: preset(10), takeoutByWeekday: preset(5) } })).json;
  assert.equal(s.takeoutByWeekday[weekday], 5);
  assert.equal(s.doughByWeekday[weekday], 120);
  assert.equal(s.doughByWeekday[(weekday + 1) % 7], null);
  resetDoughCache();
  v = (await call('GET', '/api/floor/dough', { cookies: ipad })).json;
  assert.deepEqual(v.dough, { used: 6, usedDineIn: 2, usedTakeout: 4, start: 120, left: 114, spare: 5, forDineIn: 108, out: false });
  assert.deepEqual(v.glutenFree, { used: 1.25, start: 10, left: 8.75 }, 'a gluten-free pizza, and a quarter crust for the side');
  assert.deepEqual(v.takeout, { online: 3, toGo: 1, total: 4, cap: 5, left: 1 });
  assert.deepEqual(v.preset, { dough: 120, gf: 10, takeout: 5 });
  assert.deepEqual(v.changed, { dough: false, gf: false, takeout: false });
  assert.equal(v.takeoutOut, false);

  // The kitchen counts 100 left, not 114: the night counts down from 100 from here on.
  assert.equal((await call('POST', '/api/floor/dough', { cookies: ipad, body: { count: 'dough', left: 100 } })).status, 401, 'changing a count needs someone signed in');
  assert.equal((await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'dough', left: -1 } })).status, 400);
  assert.equal((await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'flour', left: 3 } })).status, 400);
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'dough', left: 100 } })).json;
  assert.deepEqual(v.dough, { used: 6, usedDineIn: 2, usedTakeout: 4, start: 106, left: 100, spare: 5, forDineIn: 94, out: false });
  assert.equal(v.changed.dough, true);
  orders.push(at({ ticket_name: 'T4', line_items: [{ catalog_object_id: 'var-marg', name: 'Margherita', quantity: '2' }] }));
  resetDoughCache();
  assert.equal((await call('GET', '/api/floor/dough', { cookies: ipad })).json.dough.left, 98, 'two more sold: 98');
  // Gluten-free by the quarter, from what's left now.
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'gf', left: 6 } })).json;
  assert.deepEqual(v.glutenFree, { used: 1.25, start: 7.25, left: 6 });
  // The kitchen's own iPad (a Kitchen post) changes counts with no one signed in; the counter's can't.
  const kitchen = (await call('POST', '/api/floor/posts', { cookies: owner, body: { name: 'Kitchen', kind: 'kitchen' } })).json.id;
  const kitchenIpad = (await call('POST', '/api/devices', { cookies: owner, body: { name: 'Pizza iPad', floorPostId: kitchen } })).cookies;
  assert.equal((await call('GET', '/api/floor/board', { cookies: kitchenIpad })).json.post.kind, 'kitchen');
  v = (await call('POST', '/api/floor/dough', { cookies: kitchenIpad, body: { count: 'gf', left: 5 } })).json;
  assert.equal(v.glutenFree.left, 5);
  assert.equal((await call('POST', '/api/floor/dough', { cookies: ipad, body: { count: 'gf', left: 9 } })).status, 401);
  // Back to the preset.
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'dough', reset: true } })).json;
  assert.equal(v.dough.left, 112);
  assert.equal(v.changed.dough, false);

  // Online ordering is on (a pickup window tonight) until takeout runs out.
  await call('POST', '/api/online/windows/plan', { cookies: owner, body: { cells: [{ weekday, starts: '17:00', maxPizzas: 20 }] } });
  let menu = (await call('GET', '/api/order/menu')).json;
  assert.equal(menu.open, true);
  orders.push(at({ source: { name: 'Online ordering' }, line_items: [{ catalog_object_id: 'var-marg', name: 'Margherita', quantity: '1' }] }));
  resetDoughCache();
  menu = (await call('GET', '/api/order/menu')).json;
  assert.equal(menu.open, false);
  assert.deepEqual(menu.paused, { until: null, soldOut: true });
  v = (await call('GET', '/api/floor/dough', { cookies: ipad })).json;
  assert.equal(v.takeout.left, 0);
  assert.ok(v.takeoutOut);

  // The kitchen adds three: online ordering is back on, and every board sees it.
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'takeout', add: 3 } })).json;
  assert.equal(v.takeout.cap, 8);
  assert.equal(v.takeout.left, 3);
  assert.equal(v.changed.takeout, true);
  assert.equal((await call('GET', '/api/order/menu')).json.open, true);
  assert.equal((await call('GET', '/api/floor/dough', { cookies: ipad })).json.takeout.left, 3);
  // "2 left" typed in; then back to the day's number.
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'takeout', left: 2 } })).json;
  assert.deepEqual([v.takeout.cap, v.takeout.left], [7, 2]);
  v = (await call('POST', '/api/floor/dough', { cookies: owner, body: { count: 'takeout', reset: true } })).json;
  assert.equal(v.takeout.cap, 5);

  // A failed read from Square never closes online ordering: the last count stays, flagged.
  const broken = createApp({ db: db!, setupToken: 'x', secureCookies: false, checkout: { token: 't', applicationId: 'a', locationId: 'l', fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }), now: () => now } });
  const s2 = createServer(broken);
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  t.after(() => s2.close());
  resetDoughCache();
  const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/order/menu`);
  assert.equal(((await res.json()) as any).open, true);
});
