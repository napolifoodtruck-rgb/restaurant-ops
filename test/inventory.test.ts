// Inventory: lists in sections by where things are kept, items placed (and moved), and a count as
// counted ("2 bags + 5 lb") worth what it's worth at today's prices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { countedAmount, looksLikeItHere, packsFrom, partsText } from '../src/core/counts.ts';
import { startTestDb } from './support/psqlDb.ts';

test('counting the way it is kept: packs from invoices, parts added up', () => {
  const packs = packsFrom([{ unit: 'BAG', perAmount: 50, perUnit: 'lb' }, { unit: 'LB', perAmount: 1, perUnit: 'lb' }, { unit: 'CS', perAmount: 6, perUnit: 'each' }]);
  assert.deepEqual(packs.map((p) => p.label), ['bag (50 lb)', 'case (6 each)']);
  assert.equal(countedAmount([{ amount: 2, unit: 'bag' }, { amount: 5, unit: 'lb' }], 'lb', undefined, packs), 105);
  assert.equal(countedAmount([{ amount: 16, unit: 'oz' }], 'lb', undefined), 1);
  assert.equal(countedAmount([{ amount: 1, unit: 'each' }], 'lb', undefined), undefined); // no weight per piece
  assert.equal(partsText([{ amount: 2, unit: 'bag' }, { amount: 0, unit: 'lb' }]), '2 bag');
  assert.ok(looksLikeItHere('vegetables', 'Basil, Fresh', 'Produce'));
  assert.ok(looksLikeItHere('dairy, prepped items', 'Cheese, Mozzarella', 'Dairy'));
  assert.ok(!looksLikeItHere('meats', 'Cheese, Mozzarella', 'Dairy'));
  assert.ok(looksLikeItHere('flour, sugar, dextrose, tomato cans', 'Flour, 00', 'Dry Goods'));
});

const db = startTestDb();

test('inventory: lists, sections, placing and moving, and a count worth dollars', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
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
  for (const [id, name, unit, type, cat] of [['flour', 'Flour, 00', 'lb', 'FOOD', 'Dry Goods'], ['basil', 'Basil, Fresh', 'lb', 'FOOD', 'Produce'], ['mozz', 'Cheese, Mozzarella', 'lb', 'FOOD', 'Dairy'], ['gin', 'Gin, Dry', 'floz', 'LIQUOR', 'Liquor'], ['boxes', 'Pizza Boxes 12in', 'each', 'OTHER', 'Paper']]) {
    await db!.query("INSERT INTO ingredients (restaurant_id, id, name, base_unit, source, category_type, category) VALUES ($1, $2, $3, $4, 'app', $5, $6)", [rid, id, name, unit, type, cat]);
  }
  // Flour bought by the 50 lb bag at $25: 50 cents a pound.
  const vendor = (await db!.query<{ id: string }>("INSERT INTO vendors (restaurant_id, name) VALUES ($1, 'Ferraro') RETURNING id", [rid])).rows[0]!.id;
  const today = new Date().toISOString().slice(0, 10);
  const inv = (await db!.query<{ id: string }>("INSERT INTO supplier_invoices (restaurant_id, vendor_id, vendor_name, invoice_date, source, total) VALUES ($1, $2, 'Ferraro', $3, 'typed', 25) RETURNING id", [rid, vendor, today])).rows[0]!.id;
  await db!.query("INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, unit_price, total, per_amount, per_unit) VALUES ($1, 1, 'flour', 'FLOUR 00 50LB', 1, 'BAG', 25, 25, 50, 'lb')", [inv]);
  // Gin and pizza boxes are in no recipe, but they're bought: they're counted too.
  await db!.query("INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, unit_price, total, per_amount, per_unit) VALUES ($1, 2, 'gin', 'GIN 750', 1, 'BTL', 20, 20, 25.36, 'floz'), ($1, 3, 'boxes', 'BOX 12IN', 1, 'CS', 30, 30, 50, 'each')", [inv]);
  const card = (name: string, lines: [number, string, string][], extra: object = {}) => ({ name, yields: [{ amount: 1, unit: 'each' }], ingredients: lines.map(([amount, unit, n]) => ({ amount, unit, name: n, yieldPercent: 100 })), unreadLines: [], layout: 'card', category: 'Menu items', ...extra });
  assert.equal((await call('POST', '/api/book/import', { cookies: owner, body: { format: 'kitchen-book', recipeCards: [
    card('Pizza Dough', [[250, 'g', 'Flour, 00']], { category: 'Prep', recipeType: 'Prep', yields: [{ amount: 1, unit: 'each' }] }),
    card('Margherita', [[1, 'each', 'Pizza Dough'], [3, 'oz', 'Cheese, Mozzarella'], [2, 'g', 'Basil, Fresh']], { recipeType: 'Pizza' }),
  ] } })).status, 200);

  // The three lists, and sections where things are kept.
  const kitchen = (await call('POST', '/api/inventory/lists', { cookies: owner, body: { name: 'Kitchen', countedBy: 'kitchen' } })).json.id;
  const alcohol = (await call('POST', '/api/inventory/lists', { cookies: owner, body: { name: 'Alcohol', countedBy: 'bar' } })).json.id;
  const other = (await call('POST', '/api/inventory/lists', { cookies: owner, body: { name: 'Other', countedBy: 'foh' } })).json.id;
  const top = (await call('POST', '/api/inventory/sections', { cookies: owner, body: { listId: kitchen, name: 'Walk-in · top shelf', holds: 'vegetables' } })).json.id;
  const second = (await call('POST', '/api/inventory/sections', { cookies: owner, body: { listId: kitchen, name: 'Walk-in · second shelf', holds: 'dairy, prepped items' } })).json.id;
  const dry = (await call('POST', '/api/inventory/sections', { cookies: owner, body: { listId: kitchen, name: 'Dry storage · bottom shelf', holds: 'flour, sugar' } })).json.id;
  await call('POST', '/api/inventory/sections', { cookies: owner, body: { listId: alcohol, name: 'Above the bar', holds: 'liquor' } });
  assert.ok(top && second && dry && other);

  // Everything onto its likeliest section; what fits nowhere waits in "To sort".
  assert.equal((await call('POST', '/api/inventory/place-all', { cookies: owner })).json.placed, 6);
  let sheet = (await call('GET', `/api/inventory/lists/${kitchen}`, { cookies: owner })).json;
  const where = (name: string) => sheet.sections.find((s: any) => s.items.some((i: any) => i.name === name))?.name;
  assert.equal(where('Basil, Fresh'), 'Walk-in · top shelf');
  assert.equal(where('Cheese, Mozzarella'), 'Walk-in · second shelf');
  assert.equal(where('Pizza Dough'), 'Walk-in · second shelf');
  assert.equal(where('Flour, 00'), 'Dry storage · bottom shelf');
  const flour = sheet.sections.flatMap((s: any) => s.items).find((i: any) => i.name === 'Flour, 00');
  assert.deepEqual(flour.units.slice(0, 2), ['bag', 'lb']);
  const alc = (await call('GET', `/api/inventory/lists/${alcohol}`, { cookies: owner })).json;
  assert.deepEqual(alc.sections[0].items.map((i: any) => i.name), ['Gin, Dry']);
  const oth = (await call('GET', `/api/inventory/lists/${other}`, { cookies: owner })).json;
  assert.deepEqual(oth.sections.map((s: any) => [s.name, s.items.map((i: any) => i.name)]), [['To sort', ['Pizza Boxes 12in']]]);

  // Moving: the dough to the top of its shelf, then onto another list and back.
  await call('POST', '/api/inventory/move', { cookies: owner, body: { kind: 'recipe', itemId: flour.id, dir: 'up' } }); // not on that kind: nothing happens
  const dough = sheet.sections.find((s: any) => s.id === second).items.find((i: any) => i.name === 'Pizza Dough');
  assert.equal((await call('POST', '/api/inventory/move', { cookies: owner, body: { kind: 'recipe', itemId: dough.id, dir: 'up' } })).status, 200);
  sheet = (await call('GET', `/api/inventory/lists/${kitchen}`, { cookies: owner })).json;
  assert.equal(sheet.sections.find((s: any) => s.id === second).items[0].name, 'Pizza Dough');
  await call('POST', '/api/inventory/place', { cookies: owner, body: { kind: 'recipe', itemId: dough.id, sectionId: top, at: 0 } });
  sheet = (await call('GET', `/api/inventory/lists/${kitchen}`, { cookies: owner })).json;
  assert.deepEqual(sheet.sections.find((s: any) => s.id === top).items.map((i: any) => i.name), ['Pizza Dough', 'Basil, Fresh']);

  // Counting: "2 bags + 5 lb" of flour is 105 lb, $52.50.
  const count = (await call('POST', `/api/inventory/lists/${kitchen}/count`, { cookies: owner })).json.id;
  const line = (await call('POST', `/api/inventory/counts/${count}/line`, { cookies: owner, body: { kind: 'product', itemId: 'flour', parts: [{ amount: 2, unit: 'bag' }, { amount: 5, unit: 'lb' }] } })).json;
  assert.deepEqual([line.amount, line.value], [105, 52.5]);
  // Dough balls are worth their flour.
  const balls = (await call('POST', `/api/inventory/counts/${count}/line`, { cookies: owner, body: { kind: 'recipe', itemId: dough.id, parts: [{ amount: 40, unit: 'each' }] } })).json;
  assert.ok(Math.abs(balls.value - 40 * 0.25 * 2.20462 * 0.5) < 0.05);
  // Something that doesn't convert is kept as counted, with no amount.
  const odd = (await call('POST', `/api/inventory/counts/${count}/line`, { cookies: owner, body: { kind: 'product', itemId: 'basil', parts: [{ amount: 3, unit: 'each' }] } })).json;
  assert.ok(odd.problem);
  const done = (await call('POST', `/api/inventory/counts/${count}/finish`, { cookies: owner })).json;
  assert.equal(done.lines, 3);
  const all = (await call('GET', '/api/inventory', { cookies: owner })).json;
  const k = all.lists.find((l: any) => l.id === kitchen);
  assert.equal(k.last.finished, true);
  assert.ok(Math.abs(k.last.value - (52.5 + balls.value)) < 0.01);
  assert.equal(all.notOnAList, 0);
  sheet = (await call('GET', `/api/inventory/lists/${kitchen}`, { cookies: owner })).json;
  assert.deepEqual(sheet.sections.flatMap((s: any) => s.items).find((i: any) => i.name === 'Flour, 00').counted.parts, [{ amount: 2, unit: 'bag' }, { amount: 5, unit: 'lb' }]);
});
