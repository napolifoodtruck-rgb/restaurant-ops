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
import { LAST_WINDOW_ENDS } from '../src/core/pickupWindows.ts';
import type { Fetch } from '../src/connectors/squareApi.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('customer checkout', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));

  // Square, faked: 7.5% tax on orders; a card token ending "declined" is declined; payments in `refunds` were refunded that much.
  const square: { path: string; body: any }[] = [];
  const lookups: URL[] = [];
  const refunds = new Map<string, number>();
  const live = new Map<string, any>();
  const stock = new Map<string, number>();
  // Tickets open on the POS, as Square's order search returns them.
  const openTables: any[] = [];
  // Orders paid in Square (order id → payment id); `dropAnswer`: the next charge goes through but its answer is lost.
  const paidInSquare = new Map<string, string>();
  const cancelledInSquare = new Set<string>();
  let dropAnswer = false;
  const fakeFetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (init.method === 'GET' && path.startsWith('/v2/orders/')) {
      const id = decodeURIComponent(path.slice('/v2/orders/'.length));
      const paidWith = paidInSquare.get(id);
      return reply(200, { order: { id, state: cancelledInSquare.has(id) ? 'CANCELED' : 'OPEN', version: 3, location_id: 'loc-1', fulfillments: [{ uid: 'f-1' }], tenders: paidWith ? [{ payment_id: paidWith }] : [], net_amount_due_money: { amount: paidWith ? 0 : 1000 } } });
    }
    if (init.method === 'PUT' && path.startsWith('/v2/orders/')) {
      const id = decodeURIComponent(path.slice('/v2/orders/'.length));
      const body = JSON.parse(init.body ?? '{}');
      square.push({ path: '/v2/orders/:id (update)', body });
      if (body.order.state === 'CANCELED') cancelledInSquare.add(id);
      return reply(200, { order: { id, state: body.order.state } });
    }
    if (init.method === 'GET' && path === '/v2/payments') {
      lookups.push(new URL(url));
      return reply(200, { payments: [...refunds].map(([id, refunded]) => ({ id, total_money: { amount: 4000 }, refunded_money: { amount: refunded } })) });
    }
    const body = JSON.parse(init.body ?? '{}');
    if (path === '/v2/inventory/counts/batch-retrieve') return reply(200, { counts: body.catalog_object_ids.filter((id: string) => stock.has(id)).map((id: string) => ({ catalog_object_id: id, state: 'IN_STOCK', quantity: String(stock.get(id)) })) });
    if (path === '/v2/orders/search') return reply(200, { orders: body.query.filter.state_filter.states.includes('OPEN') ? openTables : [] });
    if (path === '/v2/catalog/batch-retrieve') {
      // With related objects: the modifier lists of the items asked for, as set in `live`.
      const listIds = body.include_related_objects ? body.object_ids.flatMap((id: string) => ((live.get(id) ?? objects.find((o) => o.id === id))?.item_data?.modifier_list_info ?? []).map((i: any) => i.modifier_list_id)) : [];
      return reply(200, { objects: body.object_ids.map((id: string) => live.get(id)).filter(Boolean), related_objects: [...new Set<string>(listIds)].map((id) => live.get(id)).filter(Boolean) });
    }
    square.push({ path, body });
    if (path === '/v2/orders') {
      const subtotal = body.order.line_items.reduce((s: number, l: any) => s + Number(l.quantity) * (l.base_price_money.amount + l.modifiers.reduce((m: number, x: any) => m + x.base_price_money.amount, 0)), 0);
      const tax = Math.round(subtotal * 0.075);
      return reply(200, { order: { id: `sq-order-${square.length}`, version: 1, total_money: { amount: subtotal + tax }, total_tax_money: { amount: tax } } });
    }
    if (path === '/v2/payments') {
      if (body.source_id.endsWith('declined')) return reply(400, { errors: [{ code: 'GENERIC_DECLINE', category: 'PAYMENT_METHOD_ERROR' }] });
      paidInSquare.set(body.order_id, `sq-pay-${square.length}`);
      if (dropAnswer) { dropAnswer = false; return reply(500, {}); }
      return reply(200, { payment: { id: `sq-pay-${square.length}`, status: 'COMPLETED', receipt_url: 'https://squareup.com/receipt/x' } });
    }
    return reply(404, {});
  };
  // Resend, faked: the confirmation emails sent; `emailDown` makes the next send fail.
  const emails: { to: string; subject: string; text: string; key: string }[] = [];
  let emailDown = false;
  const fakeResend: Fetch = async (_url, init) => {
    if (emailDown) { emailDown = false; return { ok: false, status: 500, json: async () => ({}), text: async () => 'down' }; }
    const b = JSON.parse(init.body!);
    emails.push({ to: b.to[0], subject: b.subject, text: b.text, key: init.headers['idempotency-key']! });
    return { ok: true, status: 200, json: async () => ({ id: 'e' }), text: async () => '{}' };
  };
  // Emails go out in the background: give them a moment.
  const emailsFor = async (id: string, want = 1) => {
    for (let i = 0; i < 40 && emails.filter((e) => e.key.endsWith(id)).length < want; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 50));
    return emails.filter((e) => e.key.endsWith(id));
  };
  const today = localNow('America/New_York').date;
  let time = '16:00';
  const app = createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false,
    checkout: { token: 'sandbox-token', applicationId: 'sandbox-app', locationId: 'loc-1', environment: 'sandbox', fetch: fakeFetch, now: () => ({ date: today, time }), refundCheckMs: 0, catalogCheckMs: 0, triesPerFiveMinutes: 100,
      email: { apiKey: 're_test', from: 'Napoli <orders@example.com>', fetch: fakeResend } } });
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

  // The order page: a header photo and the notice, set in Online settings. The notice starts as the usual words.
  assert.equal(menu.page.headerImage, null);
  assert.match(menu.page.notice, /^Every online pizza is partially cooked\.\n.+\n\nFully cooked pizzas and gluten-sensitive crust/);
  assert.equal(menu.page.noticeChanged, false);
  assert.match(menu.page.whyPartial, /^Neapolitan pizza is soft/);
  assert.equal(menu.page.whyPartialChanged, false);
  const usual = menu.page.notice, usualWhy = menu.page.whyPartial, usualGf = menu.page.glutenFree;
  assert.match(usualGf, /gluten-sensitive crust/);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', '/api/online/page', { headerImage: 'data:image/gif;base64,R0lGOD' })).status, 400);
  assert.equal((await call('POST', '/api/online/page', { notice: 'x'.repeat(601) })).status, 400);
  assert.equal((await customer('POST', '/api/online/page', { notice: 'Hi' })).status, 401);
  const page = (await call('POST', '/api/online/page', { headerImage: `data:image/png;base64,${png}`, notice: '  Half-baked,   finish at home \r\n line two\n\n\n\n Gluten-free in person ' })).json;
  assert.equal(page.notice, 'Half-baked, finish at home\nline two\n\nGluten-free in person');
  assert.equal(page.noticeChanged, true);
  assert.match(page.headerImage, /^\/api\/order\/header-image\?v=\d+$/);
  assert.deepEqual((await customer('GET', '/api/order/menu')).json.page, page);
  const photo = await fetch(base + page.headerImage);
  assert.deepEqual([photo.status, photo.headers.get('content-type'), Buffer.from(await photo.arrayBuffer()).toString('base64')], [200, 'image/png', png]);
  assert.deepEqual((await call('POST', '/api/online/page', { headerImage: null, notice: '' })).json, { headerImage: null, notice: usual, noticeChanged: false, whyPartial: usualWhy, whyPartialChanged: false, glutenFree: usualGf, glutenFreeChanged: false, defaultTip: 0 });
  assert.equal((await call('POST', '/api/online/page', { whyPartial: 'x'.repeat(2001) })).status, 400);
  const why = (await call('POST', '/api/online/page', { whyPartial: ' It steams in the box. \n\n\n Finish it at home. ' })).json;
  assert.deepEqual([why.whyPartial, why.whyPartialChanged, why.notice], ['It steams in the box.\n\nFinish it at home.', true, usual]);
  assert.equal((await customer('GET', '/api/order/menu')).json.page.whyPartial, why.whyPartial);
  assert.equal((await call('POST', '/api/online/page', { whyPartial: null })).json.whyPartial, usualWhy);
  const gf = (await call('POST', '/api/online/page', { glutenFree: ' Not online. \n\n\n Call us. ' })).json;
  assert.deepEqual([gf.glutenFree, gf.glutenFreeChanged, gf.whyPartial], ['Not online.\n\nCall us.', true, usualWhy]);
  assert.equal((await customer('GET', '/api/order/menu')).json.page.glutenFree, gf.glutenFree);
  assert.equal((await call('POST', '/api/online/page', { glutenFree: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call('POST', '/api/online/page', { glutenFree: '' })).json.glutenFreeChanged, false);
  assert.equal(menu.page.defaultTip, 0);
  assert.equal((await call('POST', '/api/online/page', { defaultTip: 12 })).status, 400);
  assert.equal((await call('POST', '/api/online/page', { defaultTip: 15 })).json.defaultTip, 15);
  assert.equal((await customer('GET', '/api/order/menu')).json.page.defaultTip, 15);
  assert.equal((await fetch(base + '/api/order/header-image')).status, 404);

  menu = (await customer('GET', '/api/order/menu')).json;
  assert.equal(menu.open, true);
  assert.deepEqual(menu.items.map((x: any) => [x.name, x.isPizza, x.notes]), [['Soda', false, []], ['Margherita', true, ['Partially cooked']]]);
  assert.deepEqual(menu.windows.slice(0, 2).map((w: any) => [w.starts, w.label, w.left, w.open]), [['17:00', '5:00 pm', 2, true], ['17:15', '5:15 pm', 4, true]]);

  const order = { lines: [{ variationId: 'var-marg', quantity: 2, optionIds: ['m-arugula'] }, { variationId: 'var-soda', quantity: 1 }], window: '17:00', firstName: 'Ada', lastName: 'Lovelace', phone: '(919) 555-0100', email: 'ada@example.com', tip: 300, understood: true };
  // What a customer has to give us.
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, understood: false })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, lastName: ' ' })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, email: '' })).status, 400);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, firstName: undefined, lastName: undefined, name: 'Ada' })).status, 400);
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
  assert.equal(pickup.recipient.display_name, 'Ada Lovelace');
  assert.deepEqual([pickup.recipient.phone_number, pickup.schedule_type, pickup.pickup_at.endsWith('Z')], ['+19195550100', 'SCHEDULED', true]);
  assert.equal(new Date(pickup.pickup_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }), '5:00 PM');

  // The 5:00 window is full while it's held: the next customer is offered 5:15.
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.equal(menu.windows[0].left, 0);
  const late = await customer('POST', '/api/order/checkout', { ...order, lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.deepEqual([late.status, /5:15 pm/.test(late.json.error)], [409, true]);
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
  // Paid: one confirmation email, however many times Pay is pressed.
  const mail = await emailsFor(held.json.id);
  assert.equal(mail.length, 1);
  assert.deepEqual([mail[0]!.to, mail[0]!.subject], ['ada@example.com', 'Your Napoli order: pickup today at 5:00 pm']);
  assert.match(mail[0]!.text, /2 × Margherita  \$34\.00\n   Partially cooked, Arugula/);
  assert.match(mail[0]!.text, /Tip: \$3\.00\nTotal paid: \$42\.78/);
  assert.match(mail[0]!.text, /Preheat your oven to 450°F/);
  assert.match(mail[0]!.text, /squareup\.com\/receipt\/x/);
  assert.equal((await customer('GET', `/api/order/${held.json.id}`)).json.status, 'paid');
  assert.equal((await customer('GET', '/api/order/00000000-0000-0000-0000-000000000000')).status, 404);

  // A lapsed hold can still pay if its window has room, and not once someone else took it.
  const second = await customer('POST', '/api/order/checkout', { ...order, window: '17:15', lines: [{ variationId: 'var-marg', quantity: 4 }], tip: 0 });
  assert.equal(second.status, 201);
  await db!.query("UPDATE online_orders SET hold_until = now() - interval '1 minute' WHERE id = $1", [second.json.id]);
  const third = await customer('POST', '/api/order/checkout', { ...order, window: '17:15', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
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
  const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/order/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...order, window: '17:30', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 }) });
  assert.equal(res.status, 502);
  assert.equal((await customer('GET', '/api/order/menu')).json.windows[2].left, before);

  // Too close to a window to make it: it's gone from the choices.
  time = '17:05';
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual(menu.windows.slice(0, 3).map((w: any) => w.open), [false, false, true]);

  // Refunded in full in Square: the order's pizzas go back to its window. A part refund keeps them.
  const thirdPayment = (await db!.query<{ square_payment_id: string }>('SELECT square_payment_id FROM online_orders WHERE id = $1', [third.json.id])).rows[0]!.square_payment_id;
  const firstPayment = (await db!.query<{ square_payment_id: string }>('SELECT square_payment_id FROM online_orders WHERE id = $1', [held.json.id])).rows[0]!.square_payment_id;
  const leftBefore = (await customer('GET', '/api/order/menu')).json.windows[1].left;
  refunds.set(thirdPayment, 4000).set(firstPayment, 500);
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.equal(menu.windows[1].left, leftBefore + 1);
  assert.equal(lookups.at(-1)!.searchParams.get('location_id'), 'loc-1');
  assert.equal((await customer('GET', `/api/order/${third.json.id}`)).json.status, 'refunded');
  assert.equal((await customer('GET', `/api/order/${held.json.id}`)).json.status, 'paid');

  // Items are read from Square as they are now: a new price shows, and sold out in Square at this location takes it off.
  const marg = objects.find((o) => o.id === 'item-marg')!;
  const margNow = (variation: object) => ({ ...marg, item_data: { ...marg.item_data, variations: [{ id: 'var-marg', item_variation_data: { name: 'Regular', price_money: { amount: 1600 }, ...variation } }] } });
  live.set('item-marg', margNow({}));
  assert.equal((await customer('GET', '/api/order/menu')).json.items.find((x: any) => x.itemId === 'item-marg').variations[0].price, 1600);
  live.set('item-marg', margNow({ location_overrides: [{ location_id: 'loc-1', sold_out: true }] }));
  assert.equal((await customer('GET', '/api/order/menu')).json.items.find((x: any) => x.itemId === 'item-marg').soldOut, true);
  const gone = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.deepEqual([gone.status, /sold out/.test(gone.json.error)], [400, true]);
  // Square counts it: not more than it has. And switched off on the POS after checkout: not charged.
  live.set('item-marg', margNow({ location_overrides: [{ location_id: 'loc-1', track_inventory: true }] }));
  stock.set('var-marg', 1);
  const tooMany = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 2 }], tip: 0 });
  assert.deepEqual([tooMany.status, tooMany.json.backToOrder, /only have 1 Margherita left/.test(tooMany.json.error)], [409, true, true]);
  // Pizzas on unpaid tables are taken off the count; paid tickets and online orders aren't (Square already did).
  stock.set('var-marg', 3);
  const ticket = (source: string, due: number, quantity: string) => ({ source: { name: source }, net_amount_due_money: { amount: due }, line_items: [{ catalog_object_id: 'var-marg', quantity }, { catalog_object_id: 'var-other', quantity: '5' }] });
  openTables.push(ticket('Point of Sale', 4300, '2'), ticket('Point of Sale', 0, '1'), ticket('Square Online', 2000, '1'), ticket('Online ordering', 2000, '1'));
  const tableHasThem = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 2 }], tip: 0 });
  assert.deepEqual([tableHasThem.status, /only have 1 Margherita left/.test(tableHasThem.json.error)], [409, true]);
  openTables.length = 0;
  stock.set('var-marg', 1);
  const lastOne = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.equal(lastOne.status, 201);
  live.set('item-marg', margNow({ location_overrides: [{ location_id: 'loc-1', sold_out: true }] }));
  const paymentsBefore = square.filter((x) => x.path === '/v2/payments').length;
  const offNow = await customer('POST', `/api/order/${lastOne.json.id}/pay`, { sourceId: 'cnon:card-ok-3' });
  assert.deepEqual([offNow.status, offNow.json.backToOrder, /just sold out/.test(offNow.json.error)], [409, true, true]);
  assert.equal(square.filter((x) => x.path === '/v2/payments').length, paymentsBefore);
  assert.equal((await customer('GET', `/api/order/${lastOne.json.id}`)).json.status, 'failed');
  live.clear();
  stock.clear();

  // An option marked unavailable in Square at this location drops off the menu within a minute, and can't be bought.
  const veg = objects.find((o) => o.id === 'ml-veg')!;
  const arugula = (override: object) => ({ ...veg, modifier_list_data: { ...veg.modifier_list_data, modifiers: [{ id: 'm-arugula', modifier_data: { name: 'Arugula', price_money: { amount: 200 }, ...override } }] } });
  const optionsNow = async () => (await customer('GET', '/api/order/menu')).json.items.find((x: any) => x.itemId === 'item-marg').optionLists.flatMap((l: any) => l.options.map((o: any) => `${o.name}${o.soldOut ? ' (sold out)' : ''}`));
  assert.deepEqual(await optionsNow(), ['Arugula']);
  live.set('ml-veg', arugula({ location_overrides: [{ location_id: 'loc-2', sold_out: true }] }));
  assert.deepEqual(await optionsNow(), ['Arugula']);
  live.set('ml-veg', arugula({ location_overrides: [{ location_id: 'loc-1', sold_out: true }] }));
  assert.deepEqual(await optionsNow(), ['Arugula (sold out)']);
  const noArugula = await customer('POST', '/api/order/checkout', { ...order, window: '19:00', lines: [{ variationId: 'var-marg', quantity: 1, optionIds: ['m-arugula'] }], tip: 0 });
  assert.deepEqual([noArugula.status, /Arugula is sold out/.test(noArugula.json.error)], [400, true]);
  // Marked unavailable between checkout and paying: not charged.
  live.delete('ml-veg');
  const withArugula = await customer('POST', '/api/order/checkout', { ...order, window: '19:00', lines: [{ variationId: 'var-marg', quantity: 1, optionIds: ['m-arugula'] }], tip: 0 });
  assert.equal(withArugula.status, 201);
  live.set('ml-veg', arugula({ location_overrides: [{ location_id: 'loc-1', sold_out: true }] }));
  const paymentsThen = square.filter((x) => x.path === '/v2/payments').length;
  const arugulaGone = await customer('POST', `/api/order/${withArugula.json.id}/pay`, { sourceId: 'cnon:card-ok-4' });
  assert.deepEqual([arugulaGone.status, arugulaGone.json.backToOrder, /Arugula just sold out/.test(arugulaGone.json.error)], [409, true, true]);
  assert.equal(square.filter((x) => x.path === '/v2/payments').length, paymentsThen);
  live.clear();

  // Going back to change the order gives up the first hold: the pizzas aren't held twice.
  const left20 = async () => (await customer('GET', '/api/order/menu')).json.windows.find((w: any) => w.starts === '18:15').left;
  const room = await left20();
  const first = await customer('POST', '/api/order/checkout', { ...order, window: '18:15', lines: [{ variationId: 'var-marg', quantity: 2 }], tip: 0 });
  assert.equal(await left20(), room - 2);
  const changed = await customer('POST', '/api/order/checkout', { ...order, window: '18:15', lines: [{ variationId: 'var-marg', quantity: 3 }], tip: 0, replaces: first.json.id });
  assert.equal(changed.status, 201);
  assert.equal(await left20(), room - 3);
  assert.equal((await customer('GET', `/api/order/${first.json.id}`)).json.status, 'released');
  assert.equal((await customer('POST', `/api/order/${first.json.id}/pay`, { sourceId: 'cnon:card-ok-4' })).status, 409);
  // Or straight from the payment page.
  assert.equal((await customer('POST', `/api/order/${changed.json.id}/release`)).json.status, 'released');
  assert.equal(await left20(), room);
  // Given up, it's cancelled in Square on the next pass (so the POS stops counting its pizzas); a paid one never is.
  const squareIdOf = async (id: string) => (await db!.query<{ square_order_id: string }>('SELECT square_order_id FROM online_orders WHERE id = $1', [id])).rows[0]!.square_order_id;
  await customer('GET', '/api/order/menu');
  const cancels = square.filter((x) => x.path === '/v2/orders/:id (update)');
  assert.ok(cancels.some((c) => c.body.order.state === 'CANCELED' && c.body.order.version === 3 && c.body.order.fulfillments[0].state === 'CANCELED'));
  assert.ok(cancelledInSquare.has(await squareIdOf(first.json.id)) && cancelledInSquare.has(await squareIdOf(changed.json.id)));
  // An abandoned payment page: half an hour past its hold, it's given up and cancelled; it can't be paid after.
  const walkedAway = await customer('POST', '/api/order/checkout', { ...order, window: '18:15', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  await db!.query("UPDATE online_orders SET hold_until = now() - interval '31 minutes' WHERE id = $1", [walkedAway.json.id]);
  await customer('GET', '/api/order/menu');
  assert.equal((await customer('GET', `/api/order/${walkedAway.json.id}`)).json.status, 'released');
  assert.ok(cancelledInSquare.has(await squareIdOf(walkedAway.json.id)));
  assert.equal((await customer('POST', `/api/order/${walkedAway.json.id}/pay`, { sourceId: 'cnon:card-ok-9' })).status, 409);
  const cancelsSoFar = square.filter((x) => x.path === '/v2/orders/:id (update)').length;
  await customer('GET', '/api/order/menu');
  assert.equal(square.filter((x) => x.path === '/v2/orders/:id (update)').length, cancelsSoFar);

  // The signal drops after Pay: the charge went through, the answer didn't. Pressing Pay again (a new card token) doesn't charge twice.
  const dropped = await customer('POST', '/api/order/checkout', { ...order, window: '18:15', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  dropAnswer = true;
  const lost = await customer('POST', `/api/order/${dropped.json.id}/pay`, { sourceId: 'cnon:card-ok-5' });
  assert.deepEqual([lost.status, /won’t be charged twice/.test(lost.json.error)], [502, true]);
  const charges = square.filter((x) => x.path === '/v2/payments').length;
  const again2 = await customer('POST', `/api/order/${dropped.json.id}/pay`, { sourceId: 'cnon:card-ok-6' });
  assert.deepEqual([again2.status, again2.json.status], [200, 'paid']);
  assert.equal(square.filter((x) => x.path === '/v2/payments').length, charges);
  // Paid with the charge whose answer was lost: still confirmed, once.
  assert.equal((await emailsFor(dropped.json.id)).length, 1);
  // A payment already with Square: a second Pay waits rather than charging.
  const busy = await customer('POST', '/api/order/checkout', { ...order, window: '18:15', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  await db!.query('UPDATE online_orders SET paying_since = now() WHERE id = $1', [busy.json.id]);
  const waits = await customer('POST', `/api/order/${busy.json.id}/pay`, { sourceId: 'cnon:card-ok-7' });
  assert.deepEqual([waits.status, waits.json.paying], [409, true]);
  assert.equal((await customer('POST', `/api/order/${busy.json.id}/release`)).json.status, 'held');
  await db!.query("UPDATE online_orders SET paying_since = now() - interval '5 minutes' WHERE id = $1", [busy.json.id]);
  assert.equal((await customer('POST', `/api/order/${busy.json.id}/pay`, { sourceId: 'cnon:card-ok-7' })).json.status, 'paid');

  // A page from before first and last name sends one name. Email down: tried again when the order is next looked at.
  const later = await customer('POST', '/api/order/checkout', { ...order, firstName: undefined, lastName: undefined, name: 'Ada  King Lovelace', window: '18:30', lines: [{ variationId: 'var-soda', quantity: 1 }], tip: 0 });
  assert.equal(later.json.name, 'Ada King Lovelace');
  emailDown = true;
  assert.equal((await customer('POST', `/api/order/${later.json.id}/pay`, { sourceId: 'cnon:card-ok-9' })).json.status, 'paid');
  assert.equal((await emailsFor(later.json.id)).length, 0);
  await customer('GET', `/api/order/${later.json.id}`);
  const retried = await emailsFor(later.json.id);
  assert.equal(retried.length, 1);
  assert.doesNotMatch(retried[0]!.text, /partially cooked/i);
  await customer('GET', `/api/order/${later.json.id}`);
  assert.equal((await emailsFor(later.json.id, 2)).length, 1);

  // Anyone on shift can pause online orders; customers can't start an order until it ends or someone resumes.
  assert.deepEqual((await call('GET', '/api/online/pause')).json.paused, null);
  assert.equal((await call('POST', '/api/online/pause', { minutes: 7 })).status, 400);
  const paused = (await call('POST', '/api/online/pause', { minutes: 30 })).json.paused;
  // The pause runs on the real clock: 30 minutes from late evening reaches past the last window, which is the rest of tonight.
  const pauseEnds = localNow('America/New_York', new Date(Date.now() + 30 * 60_000));
  const pastLastWindow = pauseEnds.date !== localNow('America/New_York').date || pauseEnds.time >= LAST_WINDOW_ENDS;
  assert.equal(paused.tonight, pastLastWindow);
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual([menu.open, Boolean(menu.paused.until?.label)], [false, !pastLastWindow]);
  const whilePaused = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.deepEqual([whilePaused.status, (pastLastWindow ? /for tonight/ : /very busy/).test(whilePaused.json.error)], [409, true]);
  assert.equal((await call('POST', '/api/online/pause', { tonight: true })).json.paused.tonight, true);
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual([menu.open, menu.paused.until], [false, null]);
  // Turned off: stays off (no end time) until someone turns it back on.
  const off = (await call('POST', '/api/online/pause', { off: true })).json.paused;
  assert.deepEqual([off.off, off.tonight], [true, true]);
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual([menu.open, menu.paused], [false, { until: null, off: true }]);
  const whileOff = await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 });
  assert.deepEqual([whileOff.status, /not taking online orders right now/.test(whileOff.json.error)], [409, true]);
  assert.equal((await call('POST', '/api/online/pause', { resume: true })).json.paused, null);
  menu = (await customer('GET', '/api/order/menu')).json;
  assert.deepEqual([menu.open, menu.paused], [true, null]);
  assert.equal((await customer('POST', '/api/order/checkout', { ...order, window: '18:00', lines: [{ variationId: 'var-marg', quantity: 1 }], tip: 0 })).status, 201);
});
