// End to end against a real PostgreSQL: migrations, setup, iPad enrollment, PIN sign-in, lockout.
// Skipped when PostgreSQL binaries aren't installed or when running as root (initdb refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('sign-ins from setup to a locked PIN', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url));
  assert.deepEqual(await migrate(db!, migrations), (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort());
  assert.deepEqual(await migrate(db!, migrations), []); // each applied once

  const server = createServer(createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, opts: { body?: object; cookies?: string[]; origin?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.cookies?.length) headers.cookie = opts.cookies.join('; ');
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
    return { status: res.status, json: (await res.json()) as any, cookies: set };
  };

  assert.equal((await call('GET', '/health')).status, 200);

  // First owner, once, with the setup token.
  const owner = { token: 'setup-secret', restaurantName: 'Napoli', name: 'Owner', email: 'Owner@Example.com', password: 'a long enough one' };
  assert.equal((await call('POST', '/api/setup', { body: { ...owner, token: 'nope' } })).status, 403);
  const setup = await call('POST', '/api/setup', { body: owner });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.me.roleLevel, 'owner');
  assert.equal((await call('POST', '/api/setup', { body: owner })).status, 409);

  // Email sign-in ignores case; a wrong password says nothing about whether the email exists.
  const ownerLogin = await call('POST', '/api/login/password', { body: { email: 'owner@example.com', password: 'a long enough one' } });
  assert.equal(ownerLogin.status, 200);
  const ownerSession = ownerLogin.cookies;
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'owner@example.com', password: 'wrong password' } })).json.error, 'That didn’t match.');
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'nobody@example.com', password: 'wrong password' } })).json.error, 'That didn’t match.');

  // A cook (staff normally arrive from the Square sync).
  const restaurantId = (await db!.query<{ id: string }>('SELECT id FROM restaurants')).rows[0]!.id;
  await db!.query("INSERT INTO job_title_permissions (restaurant_id, job_title, role_level) VALUES ($1, 'Line Cook', 'line')", [restaurantId]);
  const cookId = (await db!.query<{ id: string }>("INSERT INTO staff (restaurant_id, display_name, job_title) VALUES ($1, 'Marco', 'Line Cook') RETURNING id", [restaurantId])).rows[0]!.id;

  // PINs only work on an enrolled iPad.
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' } })).status, 403);
  const enrolled = await call('POST', '/api/devices', { body: { name: 'Sauté iPad' }, cookies: ownerSession });
  assert.equal(enrolled.status, 201);
  const device = enrolled.cookies;

  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '1234' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '2468' }, cookies: ownerSession })).status, 200);
  const names = await call('GET', '/api/devices/staff', { cookies: device });
  assert.deepEqual(names.json.staff.map((s: any) => [s.name, s.hasPin]), [['Marco', true], ['Owner', false]]);

  // Five wrong PINs lock the account, even against the right PIN.
  for (let i = 1; i <= 4; i++) assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '1357' }, cookies: device })).status, 401);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '1357' }, cookies: device })).status, 423);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' }, cookies: device })).status, 423);

  // Once the lock passes, the right PIN works.
  await db!.query('UPDATE staff SET locked_until = now() - interval \'1 minute\' WHERE id = $1', [cookId]);
  const cook = await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' }, cookies: device });
  assert.equal(cook.status, 200);
  assert.equal(cook.json.me.roleLevel, 'line');
  const cookSession = [...cook.cookies, ...device];

  // A cook can't enroll iPads or change someone else's PIN.
  assert.equal((await call('POST', '/api/devices', { body: { name: 'x' }, cookies: cookSession })).status, 403);
  const ownerId = setup.json.me.staffId;
  assert.equal((await call('POST', `/api/staff/${ownerId}/pin`, { body: { pin: '8024' }, cookies: cookSession })).status, 403);
  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '8024' }, cookies: cookSession })).status, 200);

  // Cross-site posts are refused; signing out ends the session.
  assert.equal((await call('POST', '/api/logout', { cookies: cookSession, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/logout', { cookies: cookSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: cookSession })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookies: ownerSession })).status, 200);

  // The kitchen book: only kitchen-book files, checked part by part; screens say what's missing.
  assert.equal((await call('POST', '/api/book/import', { body: { recipeCards: [] }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/book/import', { body: { format: 'kitchen-book', linkAnswers: { confirm: [] } }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/book/import', { body: { format: 'kitchen-book', recipeCards: [{ name: 'Margherita', ingredients: [] }] }, cookies: ownerSession })).status, 400);
  const imported = await call('POST', '/api/book/import', { body: { format: 'kitchen-book', recipeCards: [{ name: 'Margherita', yields: [{ amount: 1, unit: 'each' }], ingredients: [], unreadLines: [], layout: 'card' }], linkAnswers: { confirm: [], newDish: [] } }, cookies: ownerSession });
  assert.deepEqual(imported.json, { loaded: ['recipeCards', 'linkAnswers'], recipeCards: 1 });
  assert.deepEqual((await call('GET', '/api/book', { cookies: ownerSession })).json.parts.map((p: any) => p.key).sort(), ['linkAnswers', 'recipeCards']);
  const margins = await call('GET', '/api/margins', { cookies: ownerSession });
  assert.equal(margins.status, 200);
  assert.deepEqual(margins.json.missing, ['marginedge', 'square']);
  assert.equal((await call('GET', '/api/menu', { cookies: ownerSession })).status, 200);
  const september = await call('GET', '/api/margins?from=2026-09-01&to=2026-09-30', { cookies: ownerSession });
  assert.deepEqual([september.status, september.json.from, september.json.to], [200, '2026-09-01', '2026-09-30']);
  assert.equal((await call('GET', '/api/margins?from=2026-09-30&to=2026-09-01', { cookies: ownerSession })).status, 400);
  assert.equal((await call('GET', '/api/margins?from=Sept', { cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/sync/square', { cookies: ownerSession })).status, 409); // not connected in this test

  // Prep lists: import, count, a chef approves, then the station works it.
  const cookAgain = [...(await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '8024' }, cookies: device })).cookies, ...device];
  const prepFile = { format: 'prep-lists', stations: [{ name: 'Expo', items: [{ name: 'House dressing', unit: 'bottle', kind: 'count', par: 3 }, { name: 'Ready the ham', kind: 'task' }, { name: 'To-go salads', unit: 'each', kind: 'count', par: 8, weekdays: [5] }], checklist: [{ name: 'Clean cooler', frequency: 'daily' }] }] };
  assert.equal((await call('POST', '/api/prep/import', { body: prepFile, cookies: cookAgain })).status, 403);
  assert.deepEqual((await call('POST', '/api/prep/import', { body: prepFile, cookies: ownerSession })).json, { stations: 1, items: 3 });
  const prep = (await call('GET', '/api/prep', { cookies: ownerSession })).json;
  const expo = prep.stations[0].id;
  const day = '2026-10-06'; // a Tuesday: the Friday-only to-go salads aren't on it
  const draft = (await call('GET', `/api/prep/${expo}/${day}`, { cookies: cookAgain })).json;
  assert.deepEqual(draft.lines.map((l: any) => l.name), ['House dressing', 'Ready the ham']);
  const dressing = draft.lines[0].id;
  const counted = (await call('POST', `/api/prep/${expo}/${day}/count`, { body: { itemId: dressing, counted: 1 }, cookies: cookAgain })).json;
  assert.equal(counted.lines[0].toMake, 2); // no sales history here: Friday's par of 3, minus 1
  assert.equal((await call('POST', `/api/prep/${expo}/${day}/done`, { body: { itemId: dressing, state: 'done' }, cookies: cookAgain })).status, 409); // not approved yet
  assert.equal((await call('POST', `/api/prep/${expo}/${day}/approve`, { body: {}, cookies: cookAgain })).status, 403); // cooks don't approve
  await call('POST', `/api/prep/${expo}/${day}/make`, { body: { itemId: dressing, toMake: 2.5 }, cookies: ownerSession });
  const approvedList = (await call('POST', `/api/prep/${expo}/${day}/approve`, { body: {}, cookies: ownerSession })).json;
  assert.deepEqual([approvedList.status, approvedList.lines[0].toMake, approvedList.lines[0].suggested], ['approved', 2.5, 2]);
  assert.equal((await call('POST', `/api/prep/${expo}/${day}/count`, { body: { itemId: dressing, counted: 0 }, cookies: cookAgain })).status, 409); // counts lock once approved
  const worked = (await call('POST', `/api/prep/${expo}/${day}/done`, { body: { itemId: dressing, state: 'done' }, cookies: cookAgain })).json;
  assert.equal(worked.lines[0].doneBy, 'Marco');
  const cleaned = (await call('POST', `/api/prep/${expo}/${day}/check`, { body: { checklistId: worked.checklist[0].id, done: true }, cookies: cookAgain })).json;
  assert.equal(cleaned.checklist[0].doneBy, 'Marco');

  // Bulk prep as inventory: a count sets it, a station fill draws it down, the bulk list suggests batches.
  const bulkFile = { format: 'prep-lists', stations: [
    { name: 'Pizza', items: [{ name: 'Spinach Panna', unit: '1/6 pan', kind: 'count', par: 4 }] },
    { name: 'Bulk', items: [{ name: 'Spinach Panna', kind: 'batch' }] },
  ] };
  await call('POST', '/api/prep/import', { body: bulkFile, cookies: ownerSession });
  const stations = (await call('GET', '/api/prep', { cookies: ownerSession })).json.stations;
  const pizza = stations.find((x: any) => x.name === 'Pizza').id, bulkSt = stations.find((x: any) => x.name === 'Bulk').id;
  const bulkItem = (await call('GET', `/api/prep/${bulkSt}/setup`, { cookies: ownerSession })).json.items[0];
  const pizzaItem = (await call('GET', `/api/prep/${pizza}/setup`, { cookies: ownerSession })).json.items[0];
  await call('POST', `/api/prep/items/${bulkItem.id}`, { body: { bulkUnit: 'qt', batchYield: 8 }, cookies: ownerSession });
  await call('POST', `/api/prep/items/${pizzaItem.id}`, { body: { sourceItemId: bulkItem.id, holds: 2 }, cookies: ownerSession });
  await call('POST', `/api/prep/${bulkSt}/${day}/count`, { body: { itemId: bulkItem.id, counted: 5 }, cookies: cookAgain }); // 5 qt in the walk-in
  await call('POST', `/api/prep/${pizza}/${day}/count`, { body: { itemId: pizzaItem.id, counted: 0 }, cookies: cookAgain }); // pizza fills 4 sixth pans = 8 qt
  const bulkView = (await call('GET', `/api/prep/${bulkSt}/${day}`, { cookies: ownerSession })).json.lines[0];
  assert.deepEqual([bulkView.suggested, bulkView.onHand.amount], [1, 5]);
  assert.match(bulkView.reason, /Pizza fills 4 1\/6 pan \(8 qt\); 5 qt on hand: make 1 batch \(8 qt\)/);
  await call('POST', `/api/prep/${pizza}/${day}/approve`, { body: {}, cookies: ownerSession });
  await call('POST', `/api/prep/${pizza}/${day}/done`, { body: { itemId: pizzaItem.id, state: 'done' }, cookies: cookAgain });
  const afterFill = (await call('GET', `/api/prep/${bulkSt}/${day}`, { cookies: ownerSession })).json.lines[0].onHand;
  assert.deepEqual(afterFill, { amount: 0, estimated: true, countedAt: afterFill.countedAt }); // 5 − 8, never below 0
  await call('POST', `/api/prep/${pizza}/${day}/done`, { body: { itemId: pizzaItem.id, state: 'undo' }, cookies: cookAgain });
  assert.equal((await call('GET', `/api/prep/${bulkSt}/${day}`, { cookies: ownerSession })).json.lines[0].onHand.amount, 5); // undo puts it back

  // A dish coming to the menu: its prep joins the pizza list the day before it starts.
  assert.equal((await call('POST', '/api/plans', { body: { name: 'Winter Funghi', startsOn: '2026-10-20' }, cookies: cookAgain })).status, 403);
  const planId = (await call('POST', '/api/plans', { body: { name: 'Winter Funghi', startsOn: '2026-10-20' }, cookies: ownerSession })).json.id;
  const plans = (await call('GET', '/api/plans', { cookies: ownerSession })).json.plans;
  assert.deepEqual(plans.map((x: any) => [x.name, x.status]), [['Winter Funghi', 'planned']]);
  assert.deepEqual((await call('POST', `/api/plans/${planId}/apply`, { body: { add: [{ recipeName: 'Mushroom Blend', stationId: pizza, unit: '1/6 pan', par: 3 }], end: [pizzaItem.id] }, cookies: ownerSession })).json, { added: 1, ended: 1 });
  const pizzaList = async (d: string) => (await call('GET', `/api/prep/${pizza}/${d}`, { cookies: ownerSession })).json.lines.map((l: any) => l.name);
  assert.deepEqual(await pizzaList('2026-10-18'), ['Spinach Panna']);
  assert.deepEqual(await pizzaList('2026-10-19'), ['Spinach Panna', 'Mushroom Blend']); // the day before: both
  assert.deepEqual(await pizzaList('2026-10-20'), ['Mushroom Blend']); // the replaced dish's own prep is off
  assert.equal((await call('POST', `/api/plans/${planId}/apply`, { body: {}, cookies: ownerSession })).status, 409);

  // Access: everyone is staff until the account owner makes them a manager.
  assert.equal((await call('POST', `/api/staff/${cookId}/access`, { body: { access: 'manager' }, cookies: cookAgain })).status, 403);
  assert.equal((await call('POST', `/api/staff/${ownerId}/access`, { body: { access: 'staff' }, cookies: ownerSession })).status, 400); // not yourself
  assert.equal((await call('POST', `/api/staff/${cookId}/access`, { body: { access: 'manager' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: cookAgain })).json.me.roleLevel, 'manager');
  assert.equal((await call('POST', `/api/staff/${ownerId}/pin`, { body: { pin: '5791' }, cookies: cookAgain })).status, 403); // a manager can't set the owner's PIN
  const team = (await call('GET', '/api/staff', { cookies: cookAgain })).json;
  assert.deepEqual([team.canSetAccess, team.staff.map((p: any) => p.access)], [false, ['owner', 'manager']]);

  // Nothing secret is stored in the clear.
  const stored = await db!.query<{ pin_hash: string }>('SELECT pin_hash FROM staff WHERE id = $1', [cookId]);
  assert.match(stored.rows[0]!.pin_hash, /^scrypt\$/);
});
