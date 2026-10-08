// The Floor end to end: an iPad set to a post shows its board with no one signed in; a PIN takes
// credit for a checklist item; tonight's book lands by table; allergens come up through recipes;
// Claude (a stand-in here) reads an OpenTable report and wine tech sheets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { hashSecret } from '../src/server/auth.ts';
import { claudeSettings } from '../src/connectors/claude.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('the Floor: posts, a board without sign-in, PIN credit, the book, allergens, Claude readers', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  const server = createServer(createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false }));
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
  const ava = (await db!.query<{ id: string }>("INSERT INTO staff (restaurant_id, display_name, pin_hash) VALUES ($1, 'Ava', $2) RETURNING id", [rid, await hashSecret('2468')])).rows[0]!.id;
  // A few ingredients and a pizza with a sauce inside it.
  for (const [id, name] of [['mozz', 'Cheese, Mozzarella'], ['tom', 'Tomatoes, San Marzano'], ['garlic', 'Garlic, Peeled'], ['flour', 'Flour, 00'], ['salt', 'Salt, Kosher']]) {
    await db!.query("INSERT INTO ingredients (restaurant_id, id, name, base_unit, source) VALUES ($1, $2, $3, 'g', 'app')", [rid, id, name]);
  }
  const card = (name: string, lines: [number, string, string][], extra: object = {}) => ({ name, yields: [{ amount: 1, unit: 'each' }], ingredients: lines.map(([amount, unit, n]) => ({ amount, unit, name: n, yieldPercent: 100 })), unreadLines: [], layout: 'card', category: 'Menu items', ...extra });
  assert.equal((await call('POST', '/api/book/import', { cookies: owner, body: { format: 'kitchen-book', recipeCards: [
    card('Pomodoro Sauce', [[500, 'g', 'Tomatoes, San Marzano'], [10, 'g', 'Garlic, Peeled'], [5, 'g', 'Salt, Kosher']], { category: 'Prep', recipeType: 'Prep', yields: [{ amount: 500, unit: 'g' }] }),
    card('Coppa Picante', [[60, 'g', 'Pomodoro Sauce'], [80, 'g', 'Cheese, Mozzarella'], [250, 'g', 'Flour, 00']], { recipeType: 'Pizza' }),
  ] } })).status, 200);

  // Not set up yet: nothing to show, and the board says so.
  assert.equal((await call('GET', '/api/floor/board', { cookies: owner })).status, 409);
  // Posts: the patio and the dining room by their tables.
  const patio = (await call('POST', '/api/floor/posts', { cookies: owner, body: { name: 'Patio', kind: 'room', tables: 'T1 T2 T3 T4 T5 T6 T7 T8 T9 T10' } })).json.id;
  const dining = (await call('POST', '/api/floor/posts', { cookies: owner, body: { name: 'Dining room', kind: 'room', tables: ['T31', 'T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38', 'T11', 'T12', 'T13'] } })).json.id;
  assert.ok(patio && dining);
  // The dining room iPad, set up by a manager; then nobody needs to be signed in.
  const ipad = (await call('POST', '/api/devices', { cookies: owner, body: { name: 'Dining room POS', floorPostId: dining } })).cookies;
  assert.equal((await call('GET', '/api/devices/staff', { cookies: ipad })).json.floorPostId, dining);

  // Tonight: a note for everyone on Wednesdays only, a special, gelato, a checklist.
  const today = (await call('GET', '/api/floor/setup', { cookies: owner })).json.today as string;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  await call('POST', '/api/floor/notes', { cookies: owner, body: { body: 'Half-price wine tonight', startsOn: today, endsOn: '2027-12-31', weekdays: [weekday] } });
  await call('POST', '/api/floor/notes', { cookies: owner, body: { body: 'Not tonight', startsOn: today, endsOn: '2027-12-31', weekdays: [(weekday + 1) % 7] } });
  const coppa = (await call('GET', '/api/cards', { cookies: owner })).json.cards.find((c: any) => c.name === 'Coppa Picante').id;
  assert.equal((await call('POST', '/api/floor/features', { cookies: owner, body: { kind: 'special', recipeId: coppa, name: 'Coppa Picante', price: 20, startsOn: today } })).status, 201);
  await call('POST', '/api/floor/gelato', { cookies: owner, body: { flavors: [{ name: 'Dark Chocolate' }, { name: 'Raspberry Sorbetto', vegan: true }], panChanges: [{ from: 'Basil', to: 'Sweet Corn', size: '¾ pan' }] } });
  const opening = (await call('POST', '/api/floor/checklists', { cookies: owner, body: { kind: 'opening', name: 'Roll silverware' } })).json.id;
  await call('POST', '/api/floor/checklists', { cookies: owner, body: { kind: 'slow', name: 'Wipe the wine fridge', everyDays: 7, postId: patio } });
  // Allergens: tagged on two ingredients, the rest not checked yet; the sauce's garlic comes up into the pizza.
  await call('POST', '/api/floor/ingredients/garlic', { cookies: owner, body: { allergens: ['allium'] } });
  await call('POST', '/api/floor/ingredients/mozz', { cookies: owner, body: { allergens: ['milk'], guestName: 'Fior di Latte' } });
  await call('POST', '/api/floor/ingredients/salt', { cookies: owner, body: { allergens: [], onCards: false } });
  const sauceId = (await db!.query<{ id: string }>("SELECT id FROM recipes WHERE name = 'Pomodoro Sauce'")).rows[0]!.id;
  await call('POST', `/api/floor/preps/${sauceId}`, { cookies: owner, body: { guestName: 'Pomodoro Base' } });
  // Tonight's book from the CSV export.
  const csv = `"TIME","PARTY SIZE","GUEST","PHONE","TABLE","NOTES AND TAGS","PAYMENT STATUS","TABLE STATUS","MADE"
"5:15 pm","2","Patio Guest","(919) 555-0101","T5","SPECIAL EVENTS: Birthday ",,"Booked","10/5/26"
"6:45 pm","2","Kris Example","(919) 555-0103","T37","GUEST REQUESTS: Window please SEATING PREFERENCES: Interior Dining Room Booked ",,"Booked","10/6/26"
"7:00 pm","4","Lee Plain","(919) 555-0104","T33",,,"Booked","10/5/26"`;
  assert.deepEqual((await call('POST', '/api/floor/reports', { cookies: owner, body: { csv } })).json.covers, 8);

  // The dining room's board, from the iPad alone.
  const board = (await call('GET', '/api/floor/board', { cookies: ipad })).json;
  assert.equal(board.post.name, 'Dining room');
  assert.deepEqual(board.book.reservations.map((r: any) => [r.name, r.notable]), [['Kris Example', true], ['Lee Plain', false]]);
  assert.deepEqual([board.book.covers, board.book.mineCovers, board.book.source], [8, 6, 'csv']);
  assert.ok(!JSON.stringify(board).includes('555'));
  assert.deepEqual(board.notes.map((n: any) => n.body), ['Half-price wine tonight']);
  const special = board.featured.find((f: any) => f.kind === 'special');
  assert.deepEqual([special.name, special.price, special.lines, special.allergyLine, special.unchecked], ['Coppa Picante', 20, ['Pomodoro Base', 'Fior di Latte', '00 Flour'], 'Dairy, Allium', ['Flour, 00', 'Tomatoes, San Marzano']]);
  assert.deepEqual(board.gelato.flavors, [{ name: 'Dark Chocolate', vegan: false }, { name: 'Raspberry Sorbetto', vegan: true }]);
  assert.deepEqual(board.gelato.panChanges, [{ from: 'Basil', to: 'Sweet Corn', size: '¾ pan' }]);
  assert.deepEqual(board.checklists.opening.map((c: any) => [c.name, c.done]), [['Roll silverware', undefined]]);
  assert.equal(board.checklists.slow.length, 0); // the patio's list, not this room's
  assert.ok(board.lookup.dishes.some((d: any) => d.name === 'Coppa Picante' && d.contains.includes('allium')));
  // The iPad can't change anything.
  assert.equal((await call('POST', '/api/floor/notes', { cookies: ipad, body: { body: 'x' } })).status, 401);
  assert.equal((await call('GET', '/api/floor/setup', { cookies: ipad })).status, 401);

  // A PIN takes the credit: wrong PIN refused, right one ticks it, and it shows who.
  assert.deepEqual((await call('GET', '/api/floor/staff', { cookies: ipad })).json.staff.map((p: any) => p.name), ['Ava']);
  assert.equal((await call('POST', '/api/floor/check', { cookies: ipad, body: { checklistId: opening, staffId: ava, pin: '1111' } })).status, 403);
  assert.deepEqual((await call('POST', '/api/floor/check', { cookies: ipad, body: { checklistId: opening, staffId: ava, pin: '2468' } })).json, { ok: true, by: 'Ava' });
  assert.equal((await call('GET', '/api/floor/board', { cookies: ipad })).json.checklists.opening[0].done.by, 'Ava');
  assert.deepEqual((await call('POST', '/api/floor/handoff', { cookies: ipad, body: { staffId: ava, pin: '2468', body: 'T33 loved the special' } })).json.by, 'Ava');
  assert.deepEqual((await call('GET', '/api/floor/setup', { cookies: owner })).json.handoffs.map((h: any) => [h.body, h.by, h.post]), [['T33 loved the special', 'Ava', 'Dining room']]);

  // Claude reads an OpenTable digest printout and wine tech sheets (a stand-in answers here).
  const was = claudeSettings.fetch, key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  t.after(() => { claudeSettings.fetch = was; if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
  claudeSettings.fetch = (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    const tool = sent.tools[0].name;
    const input = tool === 'record_reservations'
      ? { date: today, generatedAt: 'Oct 7, 2026, 4:18 PM', totalCovers: 5, reservations: [
          { time: '5:30 PM', partySize: 3, name: 'Mary Regular', tables: ['T32'], vip: true, vipNote: 'Regulars', notes: 'BTL of Calafuria Rosato, Margherita no basil', visitsLastYear: 37, lastVisit: '2026-09-30', spendPerCover: 33.61 },
          { time: '6:15 PM', partySize: 2, name: 'Often Here', tables: ['T31'], visitsLastYear: 17 },
          { time: '7:00 PM', partySize: 2, name: 'Gone', tables: ['T5'], cancelled: true }] }
      : tool === 'record_wines'
        ? { wines: [{ name: 'Pietralta Chianti DOCG', producer: 'Pietralta', region: 'Toscana', grapes: '100% Sangiovese', vessel: 'Cement', style: 'red', tastingNotes: 'Red cherry, clove', menuPairings: ['Meatball Appetizer'], ingredientPairings: ['Cured meats'], facts: ['Family run'] }] }
        : { pairings: [{ dishId: coppa, why: 'Cherry fruit cools the chili' }] };
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }], usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200 });
  }) as typeof fetch;
  const pdf = Buffer.from('%PDF-1.4 a printed digest, long enough to look like a file'.repeat(4)).toString('base64');
  const report = (await call('POST', '/api/floor/reports', { cookies: owner, body: { mediaType: 'application/pdf', data: pdf } })).json;
  let state: any;
  for (let i = 0; i < 40 && state?.status !== 'read'; i++) { await new Promise((r) => setTimeout(r, 100)); state = (await call('GET', `/api/floor/reports/${report.id}`, { cookies: owner })).json; }
  assert.deepEqual([state.status, state.reservations], ['read', 2]);
  // The digest's guests on top of the CSV: the CSV said who's coming; the digest adds who they are.
  const after = (await call('GET', '/api/floor/board', { cookies: ipad })).json;
  const mary = after.book.reservations.find((r: any) => r.name === 'Mary Regular');
  assert.deepEqual([mary.vip, mary.visitsLastYear, mary.notable, after.book.asOf], [true, 37, true, 'Oct 7, 2026, 4:18 PM']);
  assert.equal(after.book.reservations.find((r: any) => r.name === 'Often Here').suggestRegular, true);

  // Wine tech sheets: read, saved as a card, a pairing suggested and approved.
  const scan = (await call('POST', '/api/floor/wines/scan', { cookies: owner, body: { mediaType: 'application/pdf', data: pdf } })).json;
  let sheets: any;
  for (let i = 0; i < 40 && sheets?.status !== 'read'; i++) { await new Promise((r) => setTimeout(r, 100)); sheets = (await call('GET', `/api/floor/wines/scan/${scan.id}`, { cookies: owner })).json; }
  assert.equal(sheets.wines[0].name, 'Pietralta Chianti DOCG');
  assert.deepEqual((await call('POST', `/api/floor/wines/scan/${scan.id}/save`, { cookies: owner, body: { wines: sheets.wines } })).json, { saved: 1 });
  const wine = (await call('GET', '/api/floor/wines', { cookies: owner })).json.wines[0];
  assert.deepEqual([wine.region, wine.grapes, wine.unlinked], ['Toscana', '100% Sangiovese', true]);
  await call('POST', `/api/floor/wines/${wine.id}/suggest`, { cookies: owner });
  const suggested = (await call('GET', '/api/floor/wines', { cookies: owner })).json.wines[0].suggested;
  assert.deepEqual(suggested.map((p: any) => [p.name, p.why]), [['Coppa Picante', 'Cherry fruit cools the chili']]);
  await call('POST', `/api/floor/wines/${wine.id}/pairings`, { cookies: owner, body: { pairings: suggested } });
  const looked = (await call('GET', '/api/floor/board', { cookies: ipad })).json.lookup;
  assert.deepEqual(looked.dishes.find((d: any) => d.name === 'Coppa Picante').wines, ['Pietralta Chianti DOCG']);
  assert.deepEqual(looked.wines[0].pairings.map((p: any) => p.name), ['Coppa Picante']);

  // Yesterday's guests are gone from the database.
  await db!.query("UPDATE floor_reports SET day = day - 1");
  await call('GET', '/api/floor/board', { cookies: ipad });
  assert.equal((await db!.query('SELECT 1 FROM floor_reports')).rows.length, 0);
});
