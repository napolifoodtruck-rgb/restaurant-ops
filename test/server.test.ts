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
  // Start prep: the list's own clock, tapped once; a second tap keeps the first time.
  const begun = (await call('POST', `/api/prep/${expo}/${day}/start`, { body: {}, cookies: cookAgain })).json;
  assert.equal(begun.workStartedBy, 'Marco');
  assert.equal((await call('POST', `/api/prep/${expo}/${day}/start`, { body: {}, cookies: ownerSession })).json.workStartedAt, begun.workStartedAt);
  const worked = (await call('POST', `/api/prep/${expo}/${day}/done`, { body: { itemId: dressing, state: 'done' }, cookies: cookAgain })).json;
  assert.equal(worked.lines[0].doneBy, 'Marco');
  // What was made is kept with the check-off, for comparing like with like.
  assert.equal((await db!.query<{ made: number }>('SELECT made FROM prep_list_lines WHERE item_id = $1', [dressing])).rows[0]!.made, 2.5);
  // Timing: managers get the team's insights; a cook's Prep page doesn't.
  assert.ok((await call('GET', '/api/prep', { cookies: ownerSession })).json.insights);
  assert.equal((await call('GET', '/api/prep', { cookies: cookAgain })).json.insights, undefined);
  const cleaned = (await call('POST', `/api/prep/${expo}/${day}/check`, { body: { checklistId: worked.checklist[0].id, done: true }, cookies: cookAgain })).json;
  assert.equal(cleaned.checklist[0].doneBy, 'Marco');

  // Two things at once (quick taps, or two iPads): each one sticks, nothing errors.
  const expoItems = async () => (await call('GET', `/api/prep/${expo}/setup`, { cookies: ownerSession })).json.items;
  const salads = (await expoItems()).find((x: any) => x.name === 'To-go salads');
  await Promise.all([1, 3].map((n) => call('POST', `/api/prep/items/${salads.id}`, { body: { weekdayOn: n }, cookies: ownerSession })));
  assert.deepEqual((await expoItems()).find((x: any) => x.id === salads.id).weekdays, [1, 3, 5]);
  await Promise.all([1, 3].map((n) => call('POST', `/api/prep/items/${salads.id}`, { body: { weekdayOff: n }, cookies: ownerSession })));
  assert.deepEqual((await expoItems()).find((x: any) => x.id === salads.id).weekdays, [5]);
  const moved = await Promise.all([0, 1].map(() => call('POST', `/api/prep/${expo}/order`, { body: { move: { id: salads.id, by: -1, list: 'items' } }, cookies: ownerSession })));
  assert.deepEqual(moved.map((r) => r.status), [200, 200]);
  assert.deepEqual((await expoItems()).map((x: any) => x.name), ['To-go salads', 'House dressing', 'Ready the ham']); // up two, not up one twice
  for (let k = 0; k < 2; k++) await call('POST', `/api/prep/${expo}/order`, { body: { move: { id: salads.id, by: 1, list: 'items' } }, cookies: ownerSession });
  assert.deepEqual((await expoItems()).map((x: any) => x.name), ['House dressing', 'Ready the ham', 'To-go salads']);
  const ham = worked.lines.find((l: any) => l.name === 'Ready the ham').id;
  const twoIpads = await Promise.all([cookAgain, ownerSession].map((c) => call('POST', `/api/prep/${expo}/${day}/done`, { body: { itemId: ham, state: 'done' }, cookies: c })));
  assert.deepEqual(twoIpads.map((r) => r.status), [200, 200]);
  assert.ok((await call('POST', `/api/prep/${expo}/${day}/done`, { body: { itemId: ham, state: 'undo' }, cookies: ownerSession })).json.lines.find((l: any) => l.id === ham).doneAt === undefined);

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

  // Containers and weights: the usual containers come ready; a manager adds the house's own; a weighed item shows its weight.
  const units = (await call('GET', '/api/units', { cookies: cookAgain })).json;
  assert.ok(units.containers.some((c: any) => c.name === 'deep 1/9 pan'));
  assert.ok(units.fixed.volume.length && units.fixed.weight.length);
  assert.equal((await call('POST', '/api/units/containers', { body: { name: 'pizza tub', volumeMl: 5000 }, cookies: cookAgain })).status, 403);
  const tub = (await call('POST', '/api/units/containers', { body: { name: 'pizza tub', aliases: ['tub'], volumeMl: 5000 }, cookies: ownerSession })).json;
  assert.ok(tub.id);
  assert.equal((await call('POST', '/api/units/containers', { body: { name: 'Pizza Tub', volumeMl: 4000 }, cookies: ownerSession })).status, 409);
  assert.equal((await call('POST', `/api/units/containers/${tub.id}/delete`, { body: {}, cookies: ownerSession })).status, 200);
  assert.ok(!(await call('GET', '/api/units', { cookies: ownerSession })).json.containers.some((c: any) => c.name === 'pizza tub'));
  await call('POST', `/api/prep/items/${pizzaItem.id}`, { body: { unitGrams: 1361 }, cookies: ownerSession }); // a sixth pan weighed: 3 lb
  const weighed = (await call('GET', `/api/prep/${pizza}/setup`, { cookies: ownerSession })).json;
  assert.deepEqual([weighed.items[0].unitGrams, weighed.items[0].unitWeight], [1361, { grams: 1361, source: 'weighed' }]);
  assert.ok(weighed.containers.includes('1/6 pan'));
  assert.deepEqual((await call('GET', `/api/prep/${pizza}/${day}`, { cookies: ownerSession })).json.lines[0].unitWeight, { grams: 1361, source: 'weighed' });
  assert.equal((await call('POST', `/api/prep/items/${pizzaItem.id}`, { body: { unitGrams: -2 }, cookies: ownerSession })).status, 400);
  await call('POST', `/api/prep/items/${pizzaItem.id}`, { body: { unitGrams: null }, cookies: ownerSession });
  assert.equal((await call('GET', `/api/prep/${pizza}/setup`, { cookies: ownerSession })).json.items[0].unitWeight, undefined); // no recipe to go on

  // A dish coming to the menu: its prep joins the pizza list the day before it starts.
  assert.equal((await call('POST', '/api/plans', { body: { name: 'Winter Funghi', startsOn: '2026-10-20' }, cookies: cookAgain })).status, 403);
  const planId = (await call('POST', '/api/plans', { body: { name: 'Winter Funghi', startsOn: '2026-10-20' }, cookies: ownerSession })).json.id;
  const plans = (await call('GET', '/api/plans', { cookies: ownerSession })).json.plans;
  assert.deepEqual(plans.map((x: any) => [x.name, x.status]), [['Winter Funghi', 'planned']]);
  // Applied twice at once (a double tap): one adds the prep, the other is told it's done.
  const applyBody = { add: [{ recipeName: 'Mushroom Blend', stationId: pizza, unit: '1/6 pan', par: 3 }], end: [pizzaItem.id] };
  const applied = await Promise.all([0, 1].map(() => call('POST', `/api/plans/${planId}/apply`, { body: applyBody, cookies: ownerSession })));
  assert.deepEqual(applied.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(applied.find((r) => r.status === 200)!.json, { added: 1, ended: 1 });
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
  // Ten wrong PINs sent at once still lock after five: no guess slips past the count.
  const burst = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '1357' }, cookies: device })));
  assert.deepEqual([burst.filter((r) => r.status === 401).length, burst.filter((r) => r.status === 423).length], [4, 6]);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '8024' }, cookies: device })).status, 423);
  await db!.query('UPDATE staff SET locked_until = NULL, failed_logins = 0 WHERE id = $1', [cookId]);

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

  // Reports: managers only; waiting for orders until the sync brings them; then by period, set against the one before.
  const thisWeek = { from: '2026-09-28', to: '2026-10-04' };
  assert.equal((await call('GET', `/api/reports/sales?from=${thisWeek.from}&to=${thisWeek.to}`, { cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('GET', '/api/reports/sales?from=2026-10-04&to=2026-09-28', { cookies: ownerSession })).status, 400);
  assert.equal((await call('GET', `/api/reports/sales?from=${thisWeek.from}&to=${thisWeek.to}`, { cookies: ownerSession })).json.dataFrom, undefined);
  await db!.query(`INSERT INTO pos_orders (restaurant_id, order_id, day, table_name, source, server_name, covers, net_sales, tips, auto_gratuity) VALUES
    ($1, 'A', '2026-10-03', 'T6', 'Point of Sale', 'Ava', 4, 120, 24, 0), ($1, 'B', '2026-10-03', NULL, 'Square Online', NULL, 0, 40, 4, 0), ($1, 'C', '2026-09-21', 'T6', 'Point of Sale', 'Ava', 2, 50, 10, 0)`, [restaurantId]);
  await db!.query(`INSERT INTO pos_order_lines (restaurant_id, order_id, day, item_name, category, quantity, net_sales) VALUES ($1, 'A', '2026-10-03', 'Margherita', 'Pizza', 4, 60), ($1, 'C', '2026-09-21', 'Margherita', 'Pizza', 2, 30)`, [restaurantId]);
  const report = (await call('GET', `/api/reports/sales?from=${thisWeek.from}&to=${thisWeek.to}`, { cookies: ownerSession })).json;
  assert.deepEqual([report.current.totals.sales, report.current.totals.covers, report.hasPrevious, report.before.totals.sales, report.hasLastYear], [160, 4, true, 50, false]);
  assert.deepEqual(report.current.byType.map((t: any) => t.type), ['table', 'online']);
  const menuReport = (await call('GET', `/api/reports/menu?from=${thisWeek.from}&to=${thisWeek.to}&area=kitchen`, { cookies: ownerSession })).json;
  assert.deepEqual(menuReport.categories.map((c: any) => [c.name, c.items[0].name, c.items[0].byType.table]), [['Pizza', 'Margherita', 4]]);

  // Snoozing a line: set aside for whoever snoozed it, never past its day; deadlines today can't be.
  const waits = ownerToday.items.find((i: any) => i.snooze?.length && !i.due);
  const dueToday = ownerToday.items.find((i: any) => i.due && i.due <= ownerToday.today);
  if (dueToday) assert.equal(dueToday.snooze, undefined);
  if (waits) {
    assert.deepEqual(waits.snooze.map((c: any) => c.label), ['For 3 hours', 'Until tomorrow', 'For a week']);
    assert.equal((await call('POST', '/api/today/snooze', { body: { keys: [waits.key], day: waits.snooze[1].day }, cookies: ownerSession })).status, 200);
    const later = (await call('GET', '/api/today', { cookies: ownerSession })).json.items.find((i: any) => i.key === waits.key);
    assert.ok(later.snoozedUntil > new Date().toISOString());
    assert.equal((await call('POST', '/api/today/snooze', { body: { keys: [waits.key], wake: true }, cookies: ownerSession })).status, 200);
    assert.equal((await call('GET', '/api/today', { cookies: ownerSession })).json.items.find((i: any) => i.key === waits.key).snoozedUntil, undefined);
  }
  assert.equal((await call('POST', '/api/today/snooze', { body: { keys: ['x'], day: '2001-01-01' }, cookies: ownerSession })).status, 400); // not in the past
  assert.equal((await call('POST', '/api/today/snooze', { body: { keys: ['x'], hours: 48 }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/today/snooze', { body: { keys: [], hours: 3 }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/today/snooze', { body: { keys: ['prep:x'], hours: 2 }, cookies: marcoOnExpo })).status, 200); // anyone can tidy their own Today

  // Kitchen and bar: categories guessed by name, changed by an admin; people work one side or both.
  assert.equal((await call('POST', '/api/areas', { body: { category: 'Gelato', area: 'bar' }, cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('POST', '/api/areas', { body: { category: 'Gelato', area: 'bar' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/menu?area=bar', { cookies: ownerSession })).json.cards, true); // drinks get recipes too
  assert.equal((await call('POST', `/api/staff/${cookId}/area`, { body: { area: 'bar' }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: marcoOnExpo })).json.me.area, 'bar');
  assert.equal((await call('POST', `/api/staff/${ownerId}/area`, { body: { area: 'kitchen' }, cookies: marcoOnExpo })).status, 403);

  // Recipe cards written in the app: a bar prep, a drink that uses it, linked to its button.
  const syrup = { name: 'Simple Syrup', kind: 'barPrep', yields: [{ amount: 1, unit: 'qt' }], ingredients: [{ amount: 1, unit: 'qt', name: 'Water' }], ready: true };
  assert.equal((await call('POST', '/api/cards', { body: { card: syrup }, cookies: marcoOnExpo })).status, 403); // managers write cards
  const unicorn = await call('POST', '/api/cards', { body: { card: { ...syrup, ingredients: [...syrup.ingredients, { amount: 1, unit: 'qt', name: 'Unicorn tears' }] } }, cookies: ownerSession });
  // The screen is told which line and which box to point at.
  assert.deepEqual([unicorn.status, unicorn.json.line, unicorn.json.field], [400, syrup.ingredients.length, 'name']);
  assert.match(unicorn.json.error, new RegExp(`^Line ${syrup.ingredients.length + 1}: “Unicorn tears” isn’t a product`));
  assert.equal((await call('POST', '/api/cards', { body: { card: syrup }, cookies: ownerSession })).status, 200);
  const soda = { name: 'House Soda', kind: 'drink', ingredients: [{ amount: 1, unit: 'floz', name: 'Simple Syrup' }, { amount: 8, unit: 'floz', name: 'Water' }], ready: true };
  const button = { catalogId: 'V-SODA', itemName: 'House Soda' };
  assert.equal((await call('POST', '/api/cards', { body: { card: soda, link: [button] }, cookies: ownerSession })).status, 200);
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...syrup, ingredients: [{ amount: 1, unit: 'floz', name: 'House Soda' }] }, previousName: 'Simple Syrup' }, cookies: ownerSession })).status, 400); // no loops
  assert.deepEqual((await call('POST', '/api/cards/preview', { body: { card: soda }, cookies: ownerSession })).json, { lines: [{ cost: 0, source: { from: 'recipe' } }, { cost: 0, source: { from: 'free' } }], total: 0, complete: true }); // the syrup's price comes from its own recipe; water is free
  // Renaming a prep follows it into the cards that use it; a card in use can't be deleted.
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...syrup, name: 'Simple Syrup 1:1' }, previousName: 'Simple Syrup' }, cookies: ownerSession })).status, 200);
  const cards = (await call('GET', '/api/cards', { cookies: ownerSession })).json.cards;
  assert.deepEqual(cards.find((c: any) => c.name === 'House Soda').ingredients.map((i: any) => i.name), ['Simple Syrup 1:1', 'Water']);
  assert.equal(cards.find((c: any) => c.name === 'Simple Syrup 1:1').area, 'bar');
  assert.equal((await call('POST', '/api/cards/delete', { body: { name: 'Simple Syrup 1:1' }, cookies: ownerSession })).status, 409);
  const book = (await db!.query<{ value: any }>("SELECT value FROM kitchen_book WHERE key = 'linkAnswers'")).rows[0]!.value;
  assert.deepEqual((typeof book === 'string' ? JSON.parse(book) : book).confirm.filter((c: any) => c.catalogId === 'V-SODA').map((c: any) => c.recipe), ['House Soda']);
  assert.equal((await call('POST', '/api/prep/stations', { body: { name: 'Bar' }, cookies: ownerSession })).status, 201);

  // Several dishes taken off a moment apart (the saves overlap): every one of them sticks.
  const offs = ['pos:RACE1', 'pos:RACE2', 'pos:RACE3', 'pos:RACE4', 'pos:RACE5'];
  await Promise.all(offs.map((menuKey) => call('POST', '/api/menu/status', { body: { menuKey, status: 'off', name: menuKey, date: '2026-07-01' }, cookies: ownerSession })));
  const statusBook = (await db!.query<{ value: any }>("SELECT value FROM kitchen_book WHERE key = 'linkAnswers'")).rows[0]!.value;
  const statusNow = (typeof statusBook === 'string' ? JSON.parse(statusBook) : statusBook).menuStatus.map((m: any) => m.recipeId);
  for (const k of offs) assert.ok(statusNow.includes(k), k);

  // Rough recipes: saved half-written (lines not matched yet, no amount), for managers only until ready.
  const rough = { name: 'Spring Spritz', kind: 'drink', ingredients: [{ amount: 2, unit: 'floz', name: 'Water' }, { amount: 0, unit: '', name: 'rhubarb shrub' }] };
  const savedRough = (await call('POST', '/api/cards', { body: { card: rough }, cookies: ownerSession })).json;
  assert.deepEqual([savedRough.status, savedRough.toFinish], ['rough', 1]);
  assert.equal((await call('GET', '/api/recipes/Spring%20Spritz', { cookies: ownerSession })).json.rough, true);
  const cookSees = await call('GET', '/api/recipes/Spring%20Spritz', { cookies: marcoOnExpo });
  assert.deepEqual([cookSees.status, cookSees.json.error], [404, 'That recipe isn’t ready yet.']);
  const inBook = (r: any) => [...r.kitchen, ...r.bar].some((sec: any) => sec.cards.some((c: any) => c.name === 'Spring Spritz'));
  assert.equal(inBook((await call('GET', '/api/recipes', { cookies: marcoOnExpo })).json), false);
  assert.equal(inBook((await call('GET', '/api/recipes', { cookies: ownerSession })).json), true);
  const notYet = await call('POST', '/api/cards', { body: { card: { ...rough, ready: true }, previousName: 'Spring Spritz' }, cookies: ownerSession });
  assert.deepEqual([notYet.status, notYet.json.line, notYet.json.field], [400, 1, 'name']); // ready needs every line finished
  const done = (await call('POST', '/api/cards', { body: { card: { ...rough, ingredients: [rough.ingredients[0], { amount: 3, unit: 'floz', name: 'Water' }], ready: true }, previousName: 'Spring Spritz' }, cookies: ownerSession })).json;
  assert.equal(done.status, 'ready');
  assert.equal((await call('GET', '/api/recipes/Spring%20Spritz', { cookies: marcoOnExpo })).status, 200);
  // A ready recipe stays ready through an edit that keeps it finished, and goes back to rough when a line isn't.
  assert.equal((await call('POST', '/api/cards', { body: { card: { ...rough, ingredients: [rough.ingredients[0], { amount: 4, unit: 'floz', name: 'Water' }] }, previousName: 'Spring Spritz' }, cookies: ownerSession })).json.status, 'ready');
  assert.equal((await call('POST', '/api/cards', { body: { card: rough, previousName: 'Spring Spritz' }, cookies: ownerSession })).json.status, 'rough');
  // Yields: one batch said several ways opens every weight and volume unit wherever it's used.
  await call('POST', '/api/cards', { body: { card: { name: 'Marinara', kind: 'prep', yields: [{ amount: 1, unit: 'batch' }, { amount: 12, unit: 'qt' }, { amount: 6, unit: 'kg' }, { amount: 30, unit: 'ball' }], ingredients: [{ amount: 1, unit: 'qt', name: 'Water' }] } }, cookies: ownerSession });
  const marinara = (await call('GET', '/api/cards', { cookies: ownerSession })).json.allCards.find((c: any) => c.name === 'Marinara');
  for (const u of ['batch', 'qt', 'kg', 'ball', 'oz', 'lb', 'floz', 'cup', 'g']) assert.ok(marinara.units.includes(u), u);

  // Tidy names: drinks take their Square name, preps are capitalized, references follow.
  await call('POST', '/api/cards', { body: { card: { name: 'lemon juice', kind: 'barPrep', yields: [{ amount: 1, unit: 'qt' }], ingredients: [{ amount: 1, unit: 'qt', name: 'Water' }], ready: true } }, cookies: ownerSession });
  await call('POST', '/api/cards', { body: { card: { name: 'house lemonade', kind: 'drink', ingredients: [{ amount: 2, unit: 'floz', name: 'lemon juice' }], ready: true }, link: [{ catalogId: 'V-LEM', itemName: 'Lemonade' }] }, cookies: ownerSession });
  const tidy = (await call('GET', '/api/cards/tidy', { cookies: ownerSession })).json.proposals;
  assert.deepEqual(tidy.map((t: any) => [t.from, t.to]), [['lemon juice', 'Lemon Juice'], ['house lemonade', 'Lemonade']]);
  assert.equal((await call('POST', '/api/cards/tidy', { body: { renames: tidy.map((t: any) => ({ ...t, from: 'stale' })) }, cookies: ownerSession })).status, 409);
  assert.deepEqual((await call('POST', '/api/cards/tidy', { body: { renames: tidy }, cookies: ownerSession })).json, { renamed: 2, removed: 0 });
  const lemonade = (await call('GET', '/api/recipes/Lemonade', { cookies: ownerSession })).json;
  assert.deepEqual([lemonade.name, lemonade.ingredients[0].card], ['Lemonade', 'Lemon Juice']);
  const tidied = (await db!.query<{ value: any }>("SELECT value FROM kitchen_book WHERE key = 'linkAnswers'")).rows[0]!.value;
  assert.deepEqual((typeof tidied === 'string' ? JSON.parse(tidied) : tidied).confirm.filter((c: any) => c.catalogId === 'V-LEM').map((c: any) => c.recipe), ['Lemonade']);

  // Recipes home (managers): only what needs a look, with counts for the tiles; the tree's pages carry markers.
  assert.equal((await call('GET', '/api/costs/home?area=kitchen', { cookies: marcoOnExpo })).status, 403);
  const home = (await call('GET', '/api/costs/home?area=bar', { cookies: ownerSession })).json;
  assert.ok(home.counts && Array.isArray(home.dishes) && Array.isArray(home.others) && Array.isArray(home.recent));
  assert.ok(home.recent.some((x: any) => x.name === 'Lemonade' && x.by === 'Owner')); // saved in the app: who and when
  const sodaNode = (await call('GET', `/api/costs/recipe/${encodeURIComponent('me-house-soda')}`, { cookies: ownerSession })).json;
  assert.ok(sodaNode.markers && sodaNode.lines.every((l: any) => l.markers));
  assert.equal((await call('GET', `/api/costs/history/${encodeURIComponent('me-house-soda')}`, { cookies: ownerSession })).status, 200);

  // Orders: managers only; never marked sent before a manager approves; no vendors without invoices.
  assert.equal((await call('GET', '/api/orders', { cookies: marcoOnExpo })).status, 403);
  assert.deepEqual((await call('GET', '/api/orders', { cookies: ownerSession })).json.vendors, []);
  const orderId = (await db!.query<{ id: string }>("INSERT INTO orders (restaurant_id, vendor_id, vendor_name, delivery, lines) VALUES ($1, 'v1', 'Produce Co', '2026-10-08', '[{\"productId\":\"p\",\"packs\":2}]') RETURNING id", [restaurantId])).rows[0]!.id;
  assert.equal((await call('POST', `/api/orders/${orderId}/sent`, { cookies: ownerSession })).status, 409); // not approved yet
  assert.equal((await call('POST', `/api/orders/${orderId}/approve`, { cookies: ownerSession })).status, 200);
  assert.equal((await call('POST', `/api/orders/${orderId}/approve`, { cookies: ownerSession })).status, 409);
  assert.equal((await call('POST', `/api/orders/${orderId}/sent`, { cookies: ownerSession })).status, 200);
  assert.equal((await call('POST', `/api/orders/${orderId}/reopen`, { cookies: ownerSession })).status, 409); // sent is final
  // Two managers at once: only one approve counts, and "sent" and "reopen" can't both happen.
  const order2 = (await db!.query<{ id: string }>("INSERT INTO orders (restaurant_id, vendor_id, vendor_name, delivery, lines) VALUES ($1, 'v1', 'Produce Co', '2026-10-15', '[{\"productId\":\"p\",\"packs\":1}]') RETURNING id", [restaurantId])).rows[0]!.id;
  assert.deepEqual((await Promise.all([0, 1].map(() => call('POST', `/api/orders/${order2}/approve`, { cookies: ownerSession })))).map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual((await Promise.all(['sent', 'reopen'].map((a) => call('POST', `/api/orders/${order2}/${a}`, { cookies: ownerSession })))).map((r) => r.status).sort(), [200, 409]);
  await db!.query('DELETE FROM orders WHERE id = $1', [order2]);
  assert.equal((await call('POST', '/api/orders/vendor/v1/settings', { body: { weekdays: [4], cutoffDaysBefore: 1, cutoffTime: '14:00', method: 'email', contact: 'orders@produce.example' }, cookies: ownerSession })).status, 200);
  const configured = (await call('GET', '/api/orders', { cookies: ownerSession })).json.vendors;
  assert.deepEqual(configured.map((v: any) => [v.vendorId, v.weekdays, v.cutoff, v.method]), [['v1', [4], { daysBefore: 1, time: '14:00' }, 'email']]);
  // Kitchen or bar alone, or both together.
  const sideOfV1 = configured[0].side;
  assert.deepEqual((await call('GET', '/api/orders?area=both', { cookies: ownerSession })).json.vendors.map((v: any) => v.vendorId), ['v1']);
  assert.deepEqual((await call('GET', `/api/orders?area=${sideOfV1 === 'bar' ? 'kitchen' : 'bar'}`, { cookies: ownerSession })).json.vendors, []);

  // The restaurant's logo: set by an admin, shown to anyone (the sign-in screens use it).
  assert.equal((await call('GET', '/api/brand')).json.logo, null);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', '/api/brand/logo', { body: { dataUrl: `data:image/png;base64,${png}` }, cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('POST', '/api/brand/logo', { body: { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, cookies: ownerSession })).status, 400); // no SVG
  assert.equal((await call('POST', '/api/brand/logo', { body: { dataUrl: `data:image/png;base64,${png}` }, cookies: ownerSession })).status, 200);
  const brand = (await call('GET', '/api/brand')).json;
  assert.deepEqual([brand.name, brand.logo.startsWith('/brand/logo')], ['Napoli', true]);
  const logo = await fetch(base + '/brand/logo');
  assert.deepEqual([logo.status, logo.headers.get('content-type'), Buffer.from(await logo.arrayBuffer()).toString('base64')], [200, 'image/png', png]);

  // Square's photo of a dish shows in the recipe book, from the item its button belongs to.
  await db!.query(`INSERT INTO pos_catalog (restaurant_id, object_id, type, data) VALUES
    ($1, 'I-SODA', 'ITEM', '{"type":"ITEM","id":"I-SODA","item_data":{"name":"House Soda","image_ids":["IMG-1"],"variations":[{"type":"ITEM_VARIATION","id":"V-SODA","item_variation_data":{"name":"Regular"}}]}}'),
    ($1, 'IMG-1', 'IMAGE', '{"type":"IMAGE","id":"IMG-1","image_data":{"url":"https://items-images-production.s3.us-west-2.amazonaws.com/files/x/original.jpeg"}}')`, [restaurantId]);
  await db!.query("INSERT INTO pos_item_sales_daily (restaurant_id, day, catalog_id, item_name, category, quantity, net_sales) VALUES ($1, current_date - 1, 'V-SODA', 'House Soda', 'Non-Alcoholic Drinks', 3, 12)", [restaurantId]);
  await db!.query("INSERT INTO sync_runs (restaurant_id, source, status, finished_at) VALUES ($1, 'square', 'ok', now())", [restaurantId]);
  const sodaPhoto = (await call('GET', '/api/recipes', { cookies: ownerSession })).json.bar.flatMap((s: any) => s.cards).find((c: any) => c.name === 'House Soda');
  assert.equal(sodaPhoto.image, 'https://items-images-production.s3.us-west-2.amazonaws.com/files/x/original.jpeg');

  // The recipe book: anyone can read it, by side and section; costs are for managers.
  const bookForCook = (await call('GET', '/api/recipes', { cookies: marcoOnExpo })).json;
  assert.deepEqual(bookForCook.bar.map((s: any) => [s.section, s.cards.map((c: any) => c.name)]), [['Non-Alcoholic Drinks', ['House Soda']], ['Drinks', ['Lemonade']], ['Prepared Items', ['Lemon Juice', 'Simple Syrup 1:1']]]);
  // How much of each side's sales has a full plate cost: for managers, beside the book and the menu.
  assert.equal(bookForCook.coverage, undefined);
  const ownerBook = (await call('GET', '/api/recipes', { cookies: ownerSession })).json;
  assert.deepEqual(Object.keys(ownerBook.coverage), ['kitchen', 'bar']);
  assert.equal(typeof ownerBook.coverage.bar.complete, 'number');
  const barMenu = (await call('GET', '/api/menu?area=bar', { cookies: ownerSession })).json;
  assert.equal(typeof barMenu.coverage.noCard, 'number');
  // Each line carries its Square item, so it can be sold online from the Menu screen.
  assert.equal(barMenu.current.find((x: any) => x.name === 'House Soda').squareItemId, 'I-SODA');
  const sodaForCook = (await call('GET', '/api/recipes/House%20Soda', { cookies: marcoOnExpo })).json;
  assert.deepEqual([sodaForCook.ingredients[0].card, sodaForCook.cost, sodaForCook.canEdit], ['Simple Syrup 1:1', undefined, false]);
  const syrupScaled = (await call('GET', '/api/recipes/Simple%20Syrup%201%3A1?amount=2&unit=qt', { cookies: marcoOnExpo })).json;
  assert.deepEqual([syrupScaled.scale, syrupScaled.usedBy], [2, ['House Soda']]); // scaled to what the list says to make
  assert.equal((await call('GET', '/api/recipes/House%20Soda', { cookies: ownerSession })).json.cost, 0);

  // Cost reports and the price explorer: managers only. A dish steps down to its recipes and ingredients.
  for (const path of ['/api/reports/prime?from=2026-09-28&to=2026-10-04', '/api/reports/hours?from=2026-09-28&to=2026-10-04', '/api/reports/usage?from=2026-09-28&to=2026-10-04', '/api/costs/dishes', '/api/costs/search?q=soda']) {
    assert.equal((await call('GET', path, { cookies: marcoOnExpo })).status, 403, path);
  }
  const found = (await call('GET', '/api/costs/search?q=soda', { cookies: ownerSession })).json;
  const sodaHit = found.recipes.find((r: any) => r.name === 'House Soda');
  assert.ok(sodaHit);
  const sodaCost = (await call('GET', `/api/costs/recipe/${encodeURIComponent(sodaHit.id)}`, { cookies: ownerSession })).json;
  const syrupLine = sodaCost.lines.find((l: any) => l.name === 'Simple Syrup 1:1');
  assert.equal(syrupLine.kind, 'recipe');
  const syrupCost = (await call('GET', `/api/costs/recipe/${encodeURIComponent(syrupLine.id)}?amount=${syrupLine.amount}&unit=${encodeURIComponent(syrupLine.unit)}`, { cookies: ownerSession })).json;
  assert.deepEqual([syrupCost.name, syrupCost.asked, syrupCost.usedIn.map((u: any) => u.name)], ['Simple Syrup 1:1', { amount: syrupLine.amount, unit: syrupLine.unit }, ['House Soda']]);
  assert.equal((await call('GET', '/api/costs/recipe/no-such-thing', { cookies: ownerSession })).status, 404);
  assert.equal((await call('GET', '/api/costs/product/no-such-thing', { cookies: ownerSession })).status, 404);
  assert.deepEqual(Object.keys((await call('GET', '/api/costs/movers?area=bar', { cookies: ownerSession })).json).sort(), ['area', 'down', 'up']);
  // Prime cost and the hours: labor from timecards (a shift spread over the hours it was worked), sales by hour.
  await db!.query(`INSERT INTO pos_timecards (restaurant_id, team_member_id, day, job_title, clock_in, clock_out, hourly_wage, hours, labor_cost) VALUES
    ($1, 'TM1', '2026-10-03', 'Server', '2026-10-03 17:00:00', '2026-10-03 19:30:00', 12, 2.5, 30)`, [restaurantId]);
  await db!.query(`INSERT INTO pos_sales_hourly (restaurant_id, day, hour, orders, covers, net_sales) VALUES ($1, '2026-10-03', 18, 2, 4, 160)`, [restaurantId]);
  const prime = (await call('GET', '/api/reports/prime?from=2026-09-28&to=2026-10-04', { cookies: ownerSession })).json;
  assert.deepEqual([prime.total.sales, prime.total.labor, prime.byJob.map((j: any) => j.job)], [160, 30, ['Server']]);
  const hours = (await call('GET', '/api/reports/hours?from=2026-09-28&to=2026-10-04', { cookies: ownerSession })).json;
  const sat6 = hours.cells.find((c: any) => c.weekday === 6 && c.hour === 18);
  assert.deepEqual([hours.hasLabor, sat6.sales, sat6.laborHours, hours.hours], [true, 160, 1, [17, 18, 19]]);
  const usage = (await call('GET', '/api/reports/usage?from=2026-09-28&to=2026-10-04&area=kitchen', { cookies: ownerSession })).json;
  assert.deepEqual([usage.days, Array.isArray(usage.rows), typeof usage.totals.gap], [7, true, 'number']);

  // Answers can be taken back: the newest is first, with who gave it; undoing it asks the question again.
  assert.equal((await call('POST', '/api/answers', { body: { type: 'notFood', catalogId: 'X-GIFT', itemName: 'Gift Card' }, cookies: ownerSession })).status, 200);
  const recent = (await call('GET', '/api/answers/recent?limit=5', { cookies: ownerSession })).json;
  assert.deepEqual([recent.answers[0].type, recent.answers[0].name, typeof recent.answers[0].by, typeof recent.answers[0].at], ['notFood', 'Gift Card', 'string', 'string']);
  assert.equal((await call('POST', '/api/answers/undo', { body: { target: recent.answers[0].target }, cookies: ownerSession })).status, 200);
  assert.notEqual((await call('GET', '/api/answers/recent?limit=5', { cookies: ownerSession })).json.answers[0]?.name, 'Gift Card');
  assert.equal((await call('POST', '/api/answers/undo', { body: { target: recent.answers[0].target }, cookies: ownerSession })).status, 404);

  // A discount button (Tuesday's price) counts as the drink it discounts, unless kept apart.
  await db!.query("INSERT INTO pos_item_sales_daily (restaurant_id, day, catalog_id, item_name, variation_name, category, quantity, net_sales) VALUES ($1, current_date - 1, 'V-SODA-T', 'House Soda', 'Tuesday Special', 'Non-Alcoholic Drinks', 2, 6)", [restaurantId]);
  await db!.query("INSERT INTO sync_runs (restaurant_id, source, status, finished_at) VALUES ($1, 'square', 'ok', now())", [restaurantId]); // sales arrive by a sync
  const sodaSold = async () => (await call('GET', '/api/recipes/House%20Soda', { cookies: ownerSession })).json.linked.find((l: any) => l.catalogId === 'V-SODA');
  const folded = await sodaSold();
  assert.deepEqual([folded.sold, folded.includes.map((v: any) => [v.variationName, v.quantity])], [5, [['Tuesday Special', 2]]]);
  assert.equal((await call('POST', '/api/menu/price-variation', { body: { catalogId: 'V-SODA-T', action: 'split' }, cookies: ownerSession })).status, 200);
  assert.deepEqual([(await sodaSold()).sold, (await sodaSold()).includes], [3, undefined]);
  assert.equal((await call('POST', '/api/menu/price-variation', { body: { catalogId: 'V-SODA-T', action: 'reset' }, cookies: ownerSession })).status, 200);
  assert.equal((await sodaSold()).sold, 5);
  assert.equal((await call('POST', '/api/menu/price-variation', { body: { catalogId: 'V-SODA-T', action: 'merge' }, cookies: ownerSession })).status, 400);

  // Performance, full price and specials apart: the Tuesday button is the special.
  const barAll = (await call('GET', '/api/margins?area=bar', { cookies: ownerSession })).json;
  const sodaCat = barAll.categories.find((c: any) => c.dishes.some((d: any) => d.name === 'House Soda'));
  const sodaDish = sodaCat.dishes.find((d: any) => d.name === 'House Soda');
  assert.deepEqual([barAll.hasSpecials, sodaDish.sold, sodaDish.byPrice.full.sold, sodaDish.byPrice.special.sold, sodaDish.byPrice.special.averagePrice], [true, 5, 3, 2, 3]);
  assert.deepEqual([sodaCat.byPrice.full.netSales, sodaCat.byPrice.special.netSales, sodaCat.byPrice.specialShare], [12, 6, 0.333]);
  const fullOnly = (await call('GET', '/api/margins?area=bar&price=full', { cookies: ownerSession })).json;
  assert.deepEqual([fullOnly.price, fullOnly.categories.flatMap((c: any) => c.dishes).find((d: any) => d.name === 'House Soda').sold], ['full', 3]);
  const specialOnly = (await call('GET', '/api/margins?area=bar&price=special', { cookies: ownerSession })).json;
  assert.equal(specialOnly.categories.flatMap((c: any) => c.dishes).find((d: any) => d.name === 'House Soda').averagePrice, 3);

  // A button linked to the wrong recipe comes off it from the recipe page, back to needing its own.
  assert.equal((await call('POST', '/api/cards/unlink', { body: { items: [{ catalogId: 'V-SODA', itemName: 'House Soda' }] }, cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('POST', '/api/cards/unlink', { body: { items: [{ catalogId: 'V-SODA', itemName: 'House Soda' }] }, cookies: ownerSession })).status, 200);
  assert.deepEqual((await call('GET', '/api/recipes/House%20Soda', { cookies: ownerSession })).json.linked, []);
  const unlinkedAnswer = (await call('GET', '/api/answers/recent?limit=1', { cookies: ownerSession })).json.answers[0];
  assert.deepEqual([unlinkedAnswer.type, unlinkedAnswer.note], ['newDish', 'unlinked in the app']);

  // The menu, in a manager's words: off on a day (undoable like any answer), never a day still to come.
  assert.equal((await call('POST', '/api/menu/status', { body: { menuKey: 'x', status: 'gone' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/menu/status', { body: { menuKey: 'x', status: 'off', date: '2999-01-01' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/menu/status', { body: { menuKey: 'x', status: 'on' }, cookies: marcoOnExpo })).status, 403);
  assert.equal((await call('POST', '/api/menu/status', { body: { items: [{ menuKey: 'house-soda', status: 'off', date: '2026-09-01', name: 'House Soda' }] }, cookies: ownerSession })).status, 200);
  const offAnswer = (await call('GET', '/api/answers/recent?limit=1', { cookies: ownerSession })).json.answers[0];
  assert.deepEqual([offAnswer.type, offAnswer.name, offAnswer.date, offAnswer.target], ['menuOff', 'House Soda', '2026-09-01', { menuRecipe: 'house-soda' }]);
  assert.equal((await call('POST', '/api/answers/undo', { body: { target: offAnswer.target }, cookies: ownerSession })).status, 200);
  assert.ok(Array.isArray((await call('GET', '/api/menu?area=kitchen', { cookies: ownerSession })).json.addable));

  // A layer down in the clickable charts: a drink's discount days; what was spent by vendor.
  const sodaLayer = (await call('GET', '/api/costs/breakdown?name=House%20Soda', { cookies: ownerSession })).json;
  assert.deepEqual([sodaLayer.name, sodaLayer.plates, sodaLayer.versions.map((v: any) => v.name)], ['House Soda', 5, ['Full price', 'Tuesday Special']]);
  await db!.query("INSERT INTO pos_modifier_sales_daily (restaurant_id, day, catalog_id, item_name, variation_name, modifier_list, modifier_name, quantity, gross_sales) VALUES ($1, current_date - 1, 'V-SODA', 'House Soda', '', 'Extras', '++ Extra Lime', 2, 2), ($1, current_date - 1, 'V-SODA', 'House Soda', '', 'Extras', '-- No Ice', 1, 0)", [restaurantId]);
  const sodaAddOns = (await call('GET', '/api/costs/breakdown?name=House%20Soda', { cookies: ownerSession })).json;
  assert.deepEqual([sodaAddOns.addOns, sodaAddOns.free], [[{ name: 'Extra Lime', value: 2, uses: 2 }], [{ name: 'No Ice', uses: 1 }]]);
  assert.equal((await call('GET', '/api/costs/breakdown', { cookies: ownerSession })).status, 400);

  // Modifiers: every list and the items it's on; set what one adds, once, for everywhere it's sold.
  assert.equal((await call('GET', '/api/modifiers', { cookies: marcoOnExpo })).status, 403);
  const extras = (await call('GET', '/api/modifiers', { cookies: ownerSession })).json.lists.find((l: any) => l.listName === 'Extras');
  assert.deepEqual(extras.modifiers.map((m: any) => [m.name, m.uses, m.on]), [['++ Extra Lime', 2, ['House Soda']], ['-- No Ice', 1, ['House Soda']]]);
  const lime = extras.modifiers[0];
  const syrupId = (await call('GET', '/api/recipes', { cookies: ownerSession })).json.bar.flatMap((x: any) => x.cards).find((c: any) => c.name === 'Simple Syrup 1:1').id;
  assert.equal((await call('POST', '/api/modifiers/answer', { body: { answers: [{ key: lime.key, adds: [{ kind: 'recipe', id: 'nope', amount: 1, unit: 'floz' }] }] }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/modifiers/answer', { body: { answers: [{ key: lime.key, adds: [{ kind: 'recipe', id: syrupId, amount: 0.5, unit: 'floz' }] }] }, cookies: ownerSession })).status, 200);
  const limeNow = (await call('GET', '/api/modifiers', { cookies: ownerSession })).json.lists.find((l: any) => l.listName === 'Extras').modifiers.find((m: any) => m.key === lime.key);
  assert.deepEqual([limeNow.status, limeNow.adds.map((x: any) => [x.name, x.amount, x.unit])], ['set', [['Simple Syrup 1:1', 0.5, 'floz']]]);
  assert.equal((await call('POST', '/api/modifiers/answer', { body: { answers: [{ key: lime.key, clear: true }] }, cookies: ownerSession })).status, 200);
  assert.equal((await call('GET', '/api/modifiers?recipe=nope', { cookies: ownerSession })).status, 404);

  // Invoices typed in: managers only; a line needs an ingredient from the list and a day that's been.
  assert.equal((await call('GET', '/api/invoices', { cookies: marcoOnExpo })).status, 403);
  assert.deepEqual((await call('GET', '/api/invoices', { cookies: ownerSession })).json.invoices, []);
  const harvest = { vendor: { name: 'Our garden', kind: 'garden' }, date: '2026-01-02', lines: [{ productId: 'nope', quantity: 1, unit: 'lb' }] };
  assert.equal((await call('POST', '/api/invoices', { body: { ...harvest, date: '2999-01-01' }, cookies: ownerSession })).status, 400);
  assert.match((await call('POST', '/api/invoices', { body: harvest, cookies: ownerSession })).json.error, /pick the ingredient/);
  assert.ok(Array.isArray((await call('GET', '/api/costs/spend?area=bar', { cookies: ownerSession })).json.vendors));

  // Ideas: managers and owners only; Done sets one aside (listed), Bring back undoes it.
  assert.equal((await call('GET', '/api/ideas', { cookies: marcoOnExpo })).status, 403);
  const ideas = (await call('GET', '/api/ideas', { cookies: ownerSession })).json;
  assert.ok(Array.isArray(ideas.ideas) && typeof ideas.monthly === 'number');
  assert.equal((await call('POST', '/api/ideas/dismiss', { body: { key: 'waste:kitchen:x', status: 'maybe' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', '/api/ideas/dismiss', { body: { key: 'waste:kitchen:x', status: 'done', title: 'Mozzarella gap' }, cookies: ownerSession })).status, 200);
  assert.deepEqual((await call('GET', '/api/ideas', { cookies: ownerSession })).json.setAside.map((x: any) => [x.key, x.status, x.title]), [['waste:kitchen:x', 'done', 'Mozzarella gap']]);
  assert.equal((await call('POST', '/api/ideas/dismiss', { body: { key: 'waste:kitchen:x', status: 'back' }, cookies: ownerSession })).status, 200);
  assert.deepEqual((await call('GET', '/api/ideas', { cookies: ownerSession })).json.setAside, []);

  // Nothing secret is stored in the clear.
  const stored = await db!.query<{ pin_hash: string }>('SELECT pin_hash FROM staff WHERE id = $1', [cookId]);
  assert.match(stored.rows[0]!.pin_hash, /^scrypt\$/);
});
