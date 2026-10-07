// Customer checkout end to end against a real PostgreSQL, with Square faked: menu, holds, pickup windows, payment.
// Skipped when PostgreSQL binaries aren't installed or when running as root (initdb refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { localNow } from '../src/server/online.ts';
import type { Fetch } from '../src/connectors/squareApi.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('customer checkout', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));

  // Square, faked: 7.5% tax on orders; a card token ending "declined" is declined.
  const square: { path: string; body: any }[] = [];
  const fakeFetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body ?? '{}');
    square.push({ path, body });
    const reply = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (path === '/v2/orders') {
      const subtotal = body.order.line_items.reduce((s: number, l: any) => s + Number(l.quantity) * (l.base_price_money.amount + l.modifiers.reduce((m: number, x: any) => m + x.base_price_money.amount, 0)), 0);
      const tax = Math.round(subtotal * 0.075);
      return reply(200, { order: { id: `sq-order-${square.length}`, version: 1, total_money: { amount: subtotal + tax }, total_tax_money: { amount: tax } } });
    }
    if (path === '/v2/payments') {
      if (body.source_id.endsWith('declined')) return reply(400, { errors: [{ code: 'GENERIC_DECLINE', category: 'PAYMENT_METHOD_ERROR' }] });
      return reply(200, { payment: { id: `sq-pay-${square.length}`, status: 'COMPLETED', receipt_url: 'https://squareup.com/receipt/x' } });
    }
    return reply(404, {});
  };
  const today = localNow('America/New_York').date;
  let time = '16:00';
  const app = createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false,
    checkout: { token: 'sandbox-token', applicationId: 'sandbox-app', locationId: 'loc-1', environment: 'sandbox', fetch: fakeFetch, now: () => ({ date: today, time }) } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session: string[] = [];
  const call = async (method: string, path: string, body?: object, signedIn = true) => {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (signedIn && session.length) headers.cookie = session.join('; ');
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
    if (set.length && signedIn) session = set;
    return { status: res.status, json: (await res.json()) as any };
  };
  const customer = (method: string, path: string, body?: object) => call(method, path, body, false);

  assert.equal((await call('POST', '/api/setup', { token: 'setup-secret', restaurantName: 'Napoli', name: 'Owner', email: 'owner@example.com', password: 'a long enough one' })).status, 200);
  const restaurantId = (await db!.query<{ id: string }>('SELECT id FROM restaurants')).rows[0]!.id;
  const objects = [
    { type: 'CATEGORY', id: 'cat-pizza', category_data: { name: 'Pizza' } },
    { type: 'CATEGORY', id: 'cat-drinks', category_data: { name: 'Drinks' } },
    { type: 'MODIFIER_LIST', id: 'ml-cook', modifier_list_data: { name: 'Cooked?', selection_type: 'SINGLE', modifiers: [{ id: 'm-full', modifier_data: { name: 'Fully cooked' } }, { id: 'm-part', modifier_data: { name: 'Partially cooked' } }] } },
    { type: 'MODIFIER_LIST', id: 'ml-veg', modifier_list_data: { name: 'Toppings', selection_type: 'MULTIPLE', modifiers: [{ id: 'm-arugula', modifier_data: { name: 'Arugula', price_money: { amount: 200 } } }] } },
    { type: 'ITEM', id: 'item-marg', item_data: { name: 'Margherita', reporting_category: { id: 'cat-pizza' }, variations: [{ id: 'var-marg', item_variation_data: { name: 'Regular', price_money: { amount: 1500 } } }],
      modifier_list_info: [{ modifier_list_id: 'ml-cook', min_selected_modifiers: 1, max_selected_modifiers: 1 }, { modifier_list_id: 'ml-veg' }] } },
    { type: 'ITEM', id: 'item-soda', item_data: { name: 'Soda', reporting_category: { id: 'cat-drinks' }, variations: [{ id: 'var-soda', item_variation_data: { name: 'Regular', price_money: { amount: 300 } } }] } },
  ];
  for (const o of objects) await db!.query('INSERT INTO pos_catalog (restaurant_id, object_id, type, data) VALUES ($1, $2, $3, $4::jsonb)', [restaurantId, o.id, o.type, JSON.stringify(o)]);

  // Nothing published, no windows: the menu is empty and ordering is closed.
  let menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual([menu.items, menu.open, menu.payments.applicationId], [[], false, 'sandbox-app']);

  for (const id of ['item-marg', 'item-soda']) assert.equal((await call('POST', `/api/online/items/${id}`, { published: true })).status, 200);
  assert.equal((await call('POST', '/api/online/modifiers/m-part', { mode: 'always' })).status, 200);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const starts = (await call('GET', `/api/online/windows?day=${today}`)).json.starts as string[];
  assert.equal((await call('POST', '/api/online/windows/plan', { cells: starts.map((s) => ({ weekday, starts: s, maxPizzas: s === '17:00' ? 2 : 4 })) })).status, 200);

  menu = (await customer('GET', '/api/order/menu')).json;
  assert.equal(menu.open, true);
  assert.deepEqual(menu.items.map((x: any) => [x.name, x.isPizza, x.notes]), [['Soda', false, []], ['Margherita', true, ['Partially cooked']]]);
  assert.deepEqual(menu.windows.slice(0, 2).map((w: any) => [w.starts, w.label, w.left, w.open]), [['17:00', '5:00 pm', 2, true], ['17:20', '5:20 pm', 4, true]]);

  const order = { lines: [{ variationId: 'var-marg', quantity: 2, optionIds: ['m-arugula'] }, { variationId: 'var-soda', quantity: 1 }], window: '17:00', name: 'Ada', phone: '(919) 555-0100', email: 'ada@example.com', tip: 300, understood: true };
  // What a customer has to give us.
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, understood: false })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, phone: '555-0100' })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, window: '17:10' })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, tip: 99999 })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, lines: [{ variationId: 'var-marg', quantity: 1, optionIds: ['m-full'] }] })).status, 400);
  // Five pizzas fit no window: call us.
  const tooBig = await customer('POST', '/api/order/checkout', { ...order, lines: [{ variationId: 'var-marg', quantity: 5 }] });
  assert.deepEqual([tooBig.status, /4 at most/.test(tooBig.json.error)], [409, true]);
  assert.equal(square.length, 0);

  // Checkout holds two pizzas in 5:00 and creates the Square pickup order with the price we worked out.
  const held = await customer('POST', '/api/order/checkout', order);
  assert.equal(held.status, 201);
  assert.deepEqual([held.json.status, held.json.subtotal, held.json.tax, held.json.total, held.json.tip, held.json.window.label], ['held', 3700, 278, 3978, 300, '5:00 pm']);
  const sent = square[0]!.body;
  assert.equal(sent.idempotency_key, held.json.id);
  assert.deepEqual(sent.order.line_items.map((l: any) => [l.name, l.quantity, l.base_price_money.amount, l.modifiers.map((m: any) => m.name)]), [['Margherita', '2', 1500, ['Partially cooked', 'Arugula']], ['Soda', '1', 300, []]]);
  const pickup = sent.order.fulfillments[0].pickup_details;
  assert.deepEqual([pickup.recipient.phone_number, pickup.schedule_type, pickup.pickup_at.endsWith('Z')], ['+19195550100', 'SCHEDULED', true]);
  assert.equal(new Date(pickup.pickup_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }), '5:00 PM');

  // The 5:00 window is full while it's held: the next customer is offered 5:20.
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.equal(menu.windows[0].left, 0);
  const late = await customer('POST', '/api/order/checkout', { ...order, lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.deepEqual([late.status, /5:20 pm/.test(late.json.error)], [409, true]);
  // Drinks alone don't need room.
  const drinks = await customer('POST', '/api/order/checkout', { ...order, lines: [{ variationId: 'var-soda', quantity: 2 }], tip: 0 });
  assert.equal(drinks.status, 201);

  // A declined card can try again with another; paying is charged once with the tip on top.
  const declined = await customer('POST', `/api/order/${held.json.id}/pay`, { sourceId: 'cnon:card-declined' });
  assert.deepEqual([declined.status, /declined/.test(declined.json.error)], [402, true]);
  const paid = await customer('POST', `/api/order/${held.json.id}/pay`, { sourceId: 'cnon:card-ok' });
  assert.deepEqual([paid.status, paid.json.status, paid.json.receiptUrl], [200, 'paid', 'https://squareup.com/receipt/x']);
  const payment = square.at(-1)!.body;
  assert.deepEqual([payment.amount_money.amount, payment.tip_money.amount, payment.order_id, payment.location_id], [3978, 300, 'sq-order-1', 'loc-1']);
  assert.ok(payment.idempotency_key.length <= 45);
  const again = await customer('POST', `/api/order/${held.json.id}/pay`, { sourceId: 'cnon:card-ok' });
  assert.deepEqual([again.status, again.json.status], [200, 'paid']);
  assert.equal(square.filter((s) => s.path === '/v2/payments').length, 2);
  assert.equal((await customer('GET', `/api/order/${held.json.id}`)).json.status, 'paid');
  assert.equal((await customer('GET', '/api/order/00000000-0000-0000-0000-000000000000')).status, 404);

  // A lapsed hold can still pay if its window has room, and not once someone else took it.
  const second = await customer('POST', '/api/order/checkout', { ...order, window: '17:20', lines: [{ variationId: 'var-marg', quantity: 4 }], tip: 0 });
  assert.equal(second.status, 201);
  await db!.query("UPDATE online_orders SET hold_until = now() - interval '1 minute' WHERE id = $1", [second.json.id]);
  const third = await customer('POST', '/api/order/checkout', { ...order, window: '17:20', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.equal(third.status, 201);
  const lapsed = await customer('POST', `/api/order/${second.json.id}/pay`, { sourceId: 'cnon:card-ok' });
  assert.deepEqual([lapsed.status, /filled up/.test(lapsed.json.error)], [409, true]);
  await db!.query("UPDATE online_orders SET hold_until = now() - interval '1 minute' WHERE id = $1", [third.json.id]);
  assert.equal((await customer('POST', `/api/order/${third.json.id}/pay`, { sourceId: 'cnon:card-ok-2' })).json.status, 'paid');

  // Square failing to take the order frees the room again.
  const before = (await customer('GET', '/api/order/menu')).json.windows[2].left;
  const broken = createApp({ db: db!, setupToken: 'x', secureCookies: false, checkout: { token: 't', applicationId: 'a', locationId: 'l', fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }), now: () => ({ date: today, time }) } });
  const s2 = createServer(broken);
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  t.after(() => s2.close());
  const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/order/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...order, window: '17:40', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 }) });
  assert.equal(res.status, 502);
  assert.equal((await customer('GET', '/api/order/menu')).json.windows[2].left, before);

  // Too close to a window to make it: it's gone from the choices.
  time = '17:05';
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual(menu.windows.slice(0, 3).map((w: any) => w.open), [false, false, true]);
});
