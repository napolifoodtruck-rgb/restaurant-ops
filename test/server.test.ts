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

  // Email sign-in for a manager: the owner invites, the manager opens the link and sets a password.
  assert.equal((await call('POST', `/api/staff/${cookId}/invite`, { body: { email: 'marco@example.com' }, cookies: cookAgain })).status, 403); // managers don't invite
  assert.equal((await call('POST', `/api/staff/${cookId}/invite`, { body: { email: 'owner@example.com' }, cookies: ownerSession })).status, 409); // taken
  const invite = await call('POST', `/api/staff/${cookId}/invite`, { body: { email: 'marco@example.com' }, cookies: ownerSession });
  assert.equal(invite.status, 201);
  const inviteToken = invite.json.path.split('#invite=')[1];
  assert.deepEqual((await call('GET', `/api/invites/${inviteToken}`)).json, { name: 'Marco', email: 'marco@example.com', restaurantName: 'Napoli' });
  assert.equal((await call('GET', '/api/staff', { cookies: ownerSession })).json.staff.find((p: any) => p.id === cookId).emailSignIn, 'invited');
  assert.equal((await call('POST', `/api/invites/${inviteToken}`, { body: { password: 'short' } })).status, 400);
  const accepted = await call('POST', `/api/invites/${inviteToken}`, { body: { password: 'marco makes the dough' } });
  assert.equal(accepted.json.me.name, 'Marco');
  assert.equal((await call('GET', `/api/invites/${inviteToken}`)).status, 410); // once only
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'marco@example.com', password: 'marco makes the dough' } })).status, 200);

  // Administrators: the owner makes one; they run the team but can't touch the owner.
  assert.equal((await call('POST', `/api/staff/${cookId}/access`, { body: { access: 'owner' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', `/api/staff/${cookId}/access`, { body: { access: 'admin' }, cookies: ownerSession })).status, 200);
  const adminSession = accepted.cookies;
  const meAdmin = (await call('GET', '/api/me', { cookies: adminSession })).json.me;
  assert.deepEqual([meAdmin.access, meAdmin.roleLevel], ['admin', 'manager']);
  assert.equal((await call('GET', '/api/staff', { cookies: adminSession })).json.canSetAccess, true);
  assert.equal((await call('POST', `/api/staff/${ownerId}/access`, { body: { access: 'staff' }, cookies: adminSession })).status, 404); // never the owner
  assert.equal((await call('POST', `/api/staff/${ownerId}/pin`, { body: { pin: '5791' }, cookies: adminSession })).status, 403);
  const lucaId = (await db!.query<{ id: string }>("INSERT INTO staff (restaurant_id, display_name) VALUES ($1, 'Luca') RETURNING id", [restaurantId])).rows[0]!.id;
  assert.equal((await call('POST', `/api/staff/${lucaId}/invite`, { body: { email: 'luca@example.com' }, cookies: adminSession })).status, 400); // staff: make a manager first
  assert.equal((await call('POST', `/api/staff/${lucaId}/access`, { body: { access: 'manager' }, cookies: adminSession })).status, 200);
  assert.equal((await call('POST', `/api/staff/${lucaId}/invite`, { body: { email: 'luca@example.com' }, cookies: adminSession })).status, 201);

  // Back to staff: email sign-in ends, the PIN stays.
  assert.equal((await call('POST', `/api/staff/${cookId}/access`, { body: { access: 'staff' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: adminSession })).status, 401);
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'marco@example.com', password: 'marco makes the dough' } })).status, 401);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '8024' }, cookies: device })).status, 200);

  // A kitchen iPad can belong to a station; whoever signs in on it is told which.
  const devices = (await call('GET', '/api/devices', { cookies: [...ownerSession, ...device] })).json;
  const thisIpad = devices.devices.find((d: any) => d.thisOne);
  assert.equal(thisIpad.name, 'Sauté iPad');
  assert.equal((await call('POST', `/api/devices/${thisIpad.id}`, { body: { stationId: pizza }, cookies: ownerSession })).status, 200);
  const onIpad = [...(await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '8024' }, cookies: device })).cookies, ...device];
  assert.deepEqual((await call('GET', '/api/me', { cookies: onIpad })).json.device, { id: thisIpad.id, name: 'Sauté iPad', stationId: pizza, station: 'Pizza' });
  assert.equal((await call('POST', `/api/devices/${thisIpad.id}`, { body: { revoke: true }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: onIpad })).status, 401); // its sessions end with it

  // Today: prep for everyone (only this iPad's station for staff), the rest for managers.
  const ipad2 = (await call('POST', '/api/devices', { body: { name: 'Expo iPad', stationId: expo }, cookies: ownerSession })).cookies;
  const marcoOnExpo = [...(await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '8024' }, cookies: ipad2 })).cookies, ...ipad2];
  const ownerToday = (await call('GET', '/api/today', { cookies: ownerSession })).json;
  assert.ok(ownerToday.glance);
  assert.ok(ownerToday.items.every((i: any) => i.title && i.go && i.button));
  assert.deepEqual(ownerToday.prep.map((p: any) => p.station).sort(), ['Bulk', 'Expo', 'Pizza']);
  assert.ok(ownerToday.items.some((i: any) => i.key === `plan:${planId}`) === false); // applied plans don't ask again
  const cookToday = (await call('GET', '/api/today', { cookies: marcoOnExpo })).json;
  assert.equal(cookToday.glance, undefined);
  assert.deepEqual(cookToday.prep.map((p: any) => p.station), ['Expo']);
  assert.ok(cookToday.items.every((i: any) => i.group === 'prep'));

  // Kitchen and bar: categories guessed by name, changed by an admin; people work one side or both.
  assert.equal((await call('POST', '/api/areas', { body: { category: 'Gelato', area: 'bar' }, cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('POST', '/api/areas', { body: { category: 'Gelato', area: 'bar' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/menu?area=bar', { cookies: ownerSession })).json.cards, false);
  assert.equal((await call('POST', `/api/staff/${cookId}/area`, { body: { area: 'bar' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: marcoOnExpo })).json.me.area, 'bar');
  assert.equal((await call('POST', `/api/staff/${ownerId}/area`, { body: { area: 'kitchen' }, cookies: marcoOnExpo })).status, 403);

  // Recipe cards written in the app: a bar prep, a drink that uses it, linked to its button.
  const syrup = { name: 'Simple Syrup', kind: 'barPrep', yields: [{ amount: 1, unit: 'qt' }], ingredients: [{ amount: 1, unit: 'qt', name: 'Water' }] };
  assert.equal((await call('POST', '/api/cards', { body: { card: syrup }, cookies: marcoOnExpo })).status, 403); // managers write cards
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...syrup, ingredients: [{ amount: 1, unit: 'qt', name: 'Unicorn tears' }] } }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/cards', { body: { card: syrup }, cookies: ownerSession })).status, 200);
  const soda = { name: 'House Soda', kind: 'drink', ingredients: [{ amount: 1, unit: 'floz', name: 'Simple Syrup' }, { amount: 8, unit: 'floz', name: 'Water' }] };
  const button = { catalogId: 'V-SODA', itemName: 'House Soda' };
  assert.equal((await call('POST', '/api/cards', { body: { card: soda, link: [button] }, cookies: ownerSession })).status, 200);
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...syrup, ingredients: [{ amount: 1, unit: 'floz', name: 'House Soda' }] }, previousName: 'Simple Syrup' }, cookies: ownerSession })).status, 400); // no loops
  assert.deepEqual((await call('POST', '/api/cards/preview', { body: { card: soda }, cookies: ownerSession })).json, { lines: [{ cost: 0 }, { cost: 0 }], total: 0, complete: true });
  // Renaming a prep follows it into the cards that use it; a card in use can't be deleted.
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...syrup, name: 'Simple Syrup 1:1' }, previousName: 'Simple Syrup' }, cookies: ownerSession })).status, 200);
  const cards = (await call('GET', '/api/cards', { cookies: ownerSession })).json.cards;
  assert.deepEqual(cards.find((c: any) => c.name === 'House Soda').ingredients.map((i: any) => i.name), ['Simple Syrup 1:1', 'Water']);
  assert.equal(cards.find((c: any) => c.name === 'Simple Syrup 1:1').area, 'bar');
  assert.equal((await call('POST', '/api/cards/delete', { body: { name: 'Simple Syrup 1:1' }, cookies: ownerSession })).status, 409);
  const book = (await db!.query<{ value: any }>("SELECT value FROM kitchen_book WHERE key = 'linkAnswers'")).rows[0]!.value;
  assert.deepEqual((typeof book === 'string' ? JSON.parse(book) : book).confirm.filter((c: any) => c.catalogId === 'V-SODA').map((c: any) => c.recipe), ['House Soda']);
  assert.equal((await call('POST', '/api/prep/stations', { body: { name: 'Bar' }, cookies: ownerSession })).status, 201);

  // Tidy names: drinks take their Square name, preps are capitalized, references follow.
  await call('POST', '/api/cards', { body: { card: { name: 'lemon juice', kind: 'barPrep', yields: [{ amount: 1, unit: 'qt' }], ingredients: [{ amount: 1, unit: 'qt', name: 'Water' }] } }, cookies: ownerSession });
  await call('POST', '/api/cards', { body: { card: { name: 'house lemonade', kind: 'drink', ingredients: [{ amount: 2, unit: 'floz', name: 'lemon juice' }] }, link: [{ catalogId: 'V-LEM', itemName: 'Lemonade' }] }, cookies: ownerSession });
  const tidy = (await call('GET', '/api/cards/tidy', { cookies: ownerSession })).json.proposals;
  assert.deepEqual(tidy.map((t: any) => [t.from, t.to]), [['lemon juice', 'Lemon Juice'], ['house lemonade', 'Lemonade']]);
  assert.equal((await call('POST', '/api/cards/tidy', { body: { renames: tidy.map((t: any) => ({ ...t, from: 'stale' })) }, cookies: ownerSession })).status, 409);
  assert.deepEqual((await call('POST', '/api/cards/tidy', { body: { renames: tidy }, cookies: ownerSession })).json, { renamed: 2, removed: 0 });
  const lemonade = (await call('GET', '/api/recipes/Lemonade', { cookies: ownerSession })).json;
  assert.deepEqual([lemonade.name, lemonade.ingredients[0].card], ['Lemonade', 'Lemon Juice']);
  const tidied = (await db!.query<{ value: any }>("SELECT value FROM kitchen_book WHERE key = 'linkAnswers'")).rows[0]!.value;
  assert.deepEqual((typeof tidied === 'string' ? JSON.parse(tidied) : tidied).confirm.filter((c: any) => c.catalogId === 'V-LEM').map((c: any) => c.recipe), ['Lemonade']);

  // The recipe book: anyone can read it, by side and section; costs are for managers.
  const bookForCook = (await call('GET', '/api/recipes', { cookies: marcoOnExpo })).json;
  assert.deepEqual(bookForCook.bar.map((s: any) => [s.section, s.cards.map((c: any) => c.name)]), [['Drinks', ['House Soda', 'Lemonade']], ['Bar preps', ['Lemon Juice', 'Simple Syrup 1:1']]]);
  const sodaForCook = (await call('GET', '/api/recipes/House%20Soda', { cookies: marcoOnExpo })).json;
  assert.deepEqual([sodaForCook.ingredients[0].card, sodaForCook.cost, sodaForCook.canEdit], ['Simple Syrup 1:1', undefined, false]);
  const syrupScaled = (await call('GET', '/api/recipes/Simple%20Syrup%201%3A1?amount=2&unit=qt', { cookies: marcoOnExpo })).json;
  assert.deepEqual([syrupScaled.scale, syrupScaled.usedBy], [2, ['House Soda']]); // scaled to what the list says to make
  assert.equal((await call('GET', '/api/recipes/House%20Soda', { cookies: ownerSession })).json.cost, 0);

  // Nothing secret is stored in the clear.
  const stored = await db!.query<{ pin_hash: string }>('SELECT pin_hash FROM staff WHERE id = $1', [cookId]);
  assert.match(stored.rows[0]!.pin_hash, /^scrypt\$/);
});
