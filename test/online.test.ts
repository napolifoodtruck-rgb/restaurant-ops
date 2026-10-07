// Online ordering settings end to end against a real PostgreSQL: publishing, modifiers, pickup windows.
// Skipped when PostgreSQL binaries aren't installed or when running as root (initdb refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { localNow } from '../src/server/online.ts';
import { addDays } from '../src/core/forecast.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('online menu and pickup windows', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  const server = createServer(createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session: string[] = [];
  const call = async (method: string, path: string, body?: object) => {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (session.length) headers.cookie = session.join('; ');
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
    if (set.length) session = set;
    return { status: res.status, json: (await res.json()) as any };
  };

  assert.equal((await call('GET', '/api/online/menu')).status, 401);
  assert.equal((await call('POST', '/api/setup', { token: 'setup-secret', restaurantName: 'Napoli', name: 'Owner', email: 'owner@example.com', password: 'a long enough one' })).status, 200);
  const restaurantId = (await db!.query<{ id: string }>('SELECT id FROM restaurants')).rows[0]!.id;
  const objects = [
    { type: 'CATEGORY', id: 'cat-pizza', category_data: { name: 'Pizza' } },
    { type: 'MODIFIER_LIST', id: 'ml-cook', modifier_list_data: { name: 'How would you like it cooked?', selection_type: 'SINGLE', modifiers: [{ id: 'm-full', modifier_data: { name: 'Fully cooked' } }, { id: 'm-part', modifier_data: { name: 'Partially cooked' } }] } },
    { type: 'ITEM', id: 'item-marg', item_data: { name: 'Margherita', reporting_category: { id: 'cat-pizza' }, variations: [{ id: 'var-marg', item_variation_data: { name: 'Regular', price_money: { amount: 1500 } } }],
      modifier_list_info: [{ modifier_list_id: 'ml-cook', min_selected_modifiers: 1, max_selected_modifiers: 1 }] } },
  ];
  for (const o of objects) await db!.query('INSERT INTO pos_catalog (restaurant_id, object_id, type, data) VALUES ($1, $2, $3, $4::jsonb)', [restaurantId, o.id, o.type, JSON.stringify(o)]);

  // Publishing: nothing is online until it's turned on.
  let menu = (await call('GET', '/api/online/menu')).json;
  assert.deepEqual(menu.items.map((x: any) => [x.name, x.published, x.countsAsPizza]), [['Margherita', false, true]]);
  assert.equal((await call('POST', '/api/online/items/item-nope', { published: true })).status, 404);
  assert.equal((await call('POST', '/api/online/items/item-marg', {})).status, 400);
  assert.equal((await call('POST', '/api/online/items/item-marg', { published: true, soldOutToday: true })).status, 200);
  // Hiding both cooking choices would leave nothing to pick: the menu says so.
  for (const id of ['m-full', 'm-part']) assert.equal((await call('POST', `/api/online/modifiers/${id}`, { mode: 'hidden' })).status, 200);
  menu = (await call('GET', '/api/online/menu')).json;
  assert.deepEqual([menu.items[0].published, menu.items[0].soldOutToday], [true, true]);
  assert.equal(menu.items[0].problems.length, 1);
  assert.equal((await call('POST', '/api/online/modifiers/m-part', { mode: 'always' })).status, 200);
  assert.equal((await call('POST', '/api/online/modifiers/m-nope', { mode: 'hidden' })).status, 404);
  assert.equal((await call('POST', '/api/online/modifiers/m-part', { mode: 'sometimes' })).status, 400);
  assert.equal((await call('POST', '/api/online/items/item-marg', { countsAsPizza: false, soldOutToday: false })).status, 200);
  menu = (await call('GET', '/api/online/menu')).json;
  assert.deepEqual([menu.items[0].problems, menu.items[0].countsAsPizza, menu.items[0].soldOutToday], [[], false, false]);
  assert.equal((await call('POST', '/api/online/items/item-marg', { countsAsPizza: null })).status, 200);
  assert.equal((await call('GET', '/api/online/menu')).json.items[0].countsAsPizza, true);

  // Arranging: sections and items in the order dragged, with how many sold in the last 30 days.
  const more = [
    { type: 'CATEGORY', id: 'cat-gelato', category_data: { name: 'Gelato' } },
    { type: 'ITEM', id: 'item-diavola', item_data: { name: 'Diavola', reporting_category: { id: 'cat-pizza' }, variations: [{ id: 'var-diavola', item_variation_data: { name: 'Regular', price_money: { amount: 1700 } } }] } },
    { type: 'ITEM', id: 'item-pist', item_data: { name: 'Pistachio', reporting_category: { id: 'cat-gelato' }, variations: [{ id: 'var-pist', item_variation_data: { name: 'Regular', price_money: { amount: 600 } } }] } },
  ];
  for (const o of more) await db!.query('INSERT INTO pos_catalog (restaurant_id, object_id, type, data) VALUES ($1, $2, $3, $4::jsonb)', [restaurantId, o.id, o.type, JSON.stringify(o)]);
  for (const id of ['item-diavola', 'item-pist']) assert.equal((await call('POST', `/api/online/items/${id}`, { published: true })).status, 200);
  await db!.query("INSERT INTO pos_item_sales_daily (restaurant_id, day, catalog_id, item_name, quantity, net_sales) VALUES ($1, now()::date - 2, 'var-marg', 'Margherita', 12, 180), ($1, now()::date - 3, 'var-marg', 'Margherita', 3, 45), ($1, now()::date - 60, 'var-marg', 'Margherita', 50, 750)", [restaurantId]);
  const order = (m: any) => m.items.filter((x: any) => x.published).map((x: any) => x.name);
  menu = (await call('GET', '/api/online/menu')).json;
  assert.deepEqual(order(menu), ['Pistachio', 'Diavola', 'Margherita']);
  assert.deepEqual(menu.items.map((x: any) => x.sold30), [0, 0, 15]);
  assert.equal((await call('POST', '/api/online/arrange', { categories: 'Pizza' })).status, 400);
  assert.equal((await call('POST', '/api/online/arrange', { categories: ['Pizza', 'Gelato'], items: ['item-marg', 'item-diavola', 'item-pist'] })).status, 200);
  assert.deepEqual(order((await call('GET', '/api/online/menu')).json), ['Margherita', 'Diavola', 'Pistachio']);

  // The weekly plan: nothing until filled in.
  const today = localNow('America/New_York').date;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  let w = (await call('GET', `/api/online/windows?day=${today}`)).json;
  assert.equal(w.windows.length, 12);
  assert.ok(w.windows.every((x: any) => x.max === 0));
  assert.equal((await call('POST', '/api/online/windows/plan', { cells: [{ weekday, starts: '17:10', maxPizzas: 4 }] })).status, 400);
  assert.equal((await call('POST', '/api/online/windows/plan', { cells: [{ weekday, starts: '17:00', maxPizzas: 100 }] })).status, 400);
  assert.equal((await call('POST', '/api/online/windows/plan', { cells: w.starts.map((starts: string) => ({ weekday, starts, maxPizzas: 4 })) })).status, 200);
  assert.equal((await call('POST', '/api/online/windows/plan', { cells: [{ weekday, starts: '18:00', maxPizzas: 6 }] })).status, 200);
  w = (await call('GET', `/api/online/windows?day=${today}`)).json;
  assert.deepEqual(w.windows.slice(2, 4).map((x: any) => [x.starts, x.max]), [['17:40', 4], ['18:00', 6]]);

  // Tonight: close from 8 pm, and one window changed by hand; then back to the plan.
  assert.equal((await call('POST', '/api/online/windows/day', { day: today, closeFrom: '20:00', note: 'Big party' })).status, 200);
  assert.equal((await call('POST', '/api/online/windows/day', { day: today, cells: [{ starts: '17:00', maxPizzas: 2 }] })).status, 200);
  w = (await call('GET', `/api/online/windows?day=${today}`)).json;
  assert.deepEqual(w.windows.map((x: any) => x.max), [2, 4, 4, 6, 4, 4, 4, 4, 4, 0, 0, 0]);
  assert.deepEqual(w.changedDays, [{ day: today, windows: 4, closed: false, note: 'Big party' }]);
  assert.equal((await call('POST', '/api/online/windows/day', { day: today, cells: [{ starts: '17:00', maxPizzas: null }] })).status, 200);
  assert.equal((await call('GET', `/api/online/windows?day=${today}`)).json.windows[0].max, 4);
  // A whole date closed online.
  const later = addDays(today, 7);
  assert.equal((await call('POST', '/api/online/windows/day', { day: later, closeFrom: '17:00' })).status, 200);
  assert.deepEqual((await call('GET', '/api/online/windows')).json.changedDays.map((d: any) => [d.day, d.closed]), [[today, false], [later, true]]);
  assert.equal((await call('POST', '/api/online/windows/day', { day: today, reset: true })).status, 200);
  assert.equal((await call('POST', '/api/online/windows/day', { day: addDays(today, -1), reset: true })).status, 400);
  assert.ok((await call('GET', `/api/online/windows?day=${today}`)).json.windows.every((x: any) => !x.changed));
});
