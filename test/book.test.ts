import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { canonical, loadBook, recipeCardsOn, recipeVersions, saveBook, saveRecipeCards } from '../src/server/book.ts';
import { buildRecipes, type RecipeCard } from '../src/core/recipeCards.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const card = (name: string, lines: [number, string, string][], extra: Partial<RecipeCard> = {}): RecipeCard => ({
  name, yields: [{ amount: 1, unit: 'each' }], ingredients: lines.map(([amount, unit, n]) => ({ amount, unit, name: n, yieldPercent: 100 })), unreadLines: [], layout: 'card', category: 'Menu items', ...extra,
});
const dough = (grams: number) => card('Pizza Dough', [[grams, 'g', 'Flour, 00'], [10, 'g', 'Spice, Sea Salt']], { category: 'Prep', recipeType: 'Prep', yields: [{ amount: 2, unit: 'each' }] });
const margherita = (oz: number) => card('Margherita', [[1, 'each', 'Pizza Dough'], [oz, 'oz', 'Cheese, Mozzarella'], [1, 'g', 'spice, sea salt']], { recipeType: 'Pizza' });

test('the kitchen book moves into its tables: same recipes, ids instead of names, history kept', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  const rid = (await db!.query<{ id: string }>("INSERT INTO restaurants (name) VALUES ('Napoli') RETURNING id")).rows[0]!.id;
  const staffId = (await db!.query<{ id: string }>("INSERT INTO staff (restaurant_id, display_name) VALUES ($1, 'Pat') RETURNING id", [rid])).rows[0]!.id;
  for (const [id, name, unit] of [['flour', 'Flour, 00', 'g'], ['mozz', 'Cheese, Mozzarella', 'oz'], ['salt', 'Salt, Kosher', 'lb']]) {
    await db!.query("INSERT INTO ingredients (restaurant_id, id, name, base_unit, source) VALUES ($1, $2, $3, $4, 'marginedge')", [rid, id, name, unit]);
  }

  // The old document: an older duplicate of the dough (the book always used the last one), a sauce
  // with a line that matches nothing, and answers that name recipes by their old name-made ids.
  const doc = {
    recipeCards: [dough(400), margherita(3), dough(500), card('Mystery Sauce', [[1, 'oz', 'Unknown thing']], { category: 'Prep' })],
    importAnswers: {
      ingredientProducts: { 'Spice, Sea Salt': 'off-salt' },
      offInvoiceProducts: [{ externalId: 'off-salt', name: 'Salt, sea (dough), bought outside', baseUnit: 'lb', conversions: {} }],
      manualPrices: { 'off-salt': { price: 25.99, per: { amount: 25, unit: 'lb' } } },
      portions: [{ recipe: 'Margherita', ingredient: 'Cheese, Mozzarella', amount: 2.5, unit: 'oz', source: 'purchases' }],
      conversions: { mozz: { gramsPerEach: 28 } },
      merges: [{ into: 'mozz', from: ['mozz-2'] }],
      exclusive: ['Cheese, Mozzarella'],
    },
    linkAnswers: {
      confirm: [{ catalogId: 'SQ-M', itemName: 'Margherita', recipe: 'Margherita', at: '2026-09-02T10:00:00.000Z', by: staffId }],
      newDish: [{ catalogId: 'SQ-NEW', itemName: 'Fig Pizza' }],
      notFood: [{ catalogId: 'SQ-GIFT', itemName: 'Gift Card' }],
      dismissed: [{ dedupeKey: 'menu:off:me-mystery-sauce' }],
      priceSplit: ['SQ-HALF'],
      priceMerge: [{ catalogId: 'SQ-WED', into: 'SQ-M' }],
      menuStatus: [{ recipeId: 'me-margherita', status: 'stillOn', date: '2026-09-01', name: 'Margherita' }],
    },
    modifierAnswers: {
      adds: { 'crust|extra dough': [{ item: { kind: 'recipe', id: 'me-pizza-dough' }, quantity: { amount: 1, unit: 'each' } }] },
      removes: { 'me-margherita|no cheese': { kind: 'product', id: 'mozz' } },
      waiting: { 'topping|lamb': 'card not in yet' },
    },
  };
  for (const [key, value] of Object.entries(doc)) {
    await db!.query("INSERT INTO kitchen_book (restaurant_id, key, value, updated_at) VALUES ($1, $2, $3, '2026-09-15T12:00:00Z')", [rid, key, JSON.stringify(value)]);
  }
  // Two older saved copies: on Sept 1 the Margherita had 4 oz of mozzarella.
  await db!.query("INSERT INTO kitchen_book_history (restaurant_id, key, value, saved_at, saved_by) VALUES ($1, 'recipeCards', $2, '2026-09-01T12:00:00Z', $3)", [rid, JSON.stringify([dough(500), margherita(4)]), staffId]);
  await db!.query("INSERT INTO kitchen_book_history (restaurant_id, key, value, saved_at, saved_by) VALUES ($1, 'recipeCards', $2, '2026-09-15T12:00:00Z', $3)", [rid, JSON.stringify(doc.recipeCards), staffId]);
  // A snoozed to-do and an idea set aside, keyed by the old ids.
  await db!.query("INSERT INTO today_snoozes (restaurant_id, staff_id, item_key, until) VALUES ($1, $2, 'menu:quiet:me-margherita', now() + interval '1 day')", [rid, staffId]);
  await db!.query("INSERT INTO idea_dismissals (restaurant_id, idea_key, status) VALUES ($1, 'dish:me-margherita', 'later')", [rid]);

  const book = await loadBook(db!, rid);
  const cards = book.recipeCards!;
  assert.deepEqual(cards.map((c) => c.name), ['Margherita', 'Pizza Dough', 'Mystery Sauce']);
  assert.ok(cards.every((c) => UUID.test(c.id!)), 'each recipe has its own id');
  const id = Object.fromEntries(cards.map((c) => [c.name, c.id!]));
  // The lines read as written, and know what they are.
  assert.deepEqual(cards[0]!.ingredients.map((i) => [i.name, i.recipeId ?? i.productId]), [['Pizza Dough', id['Pizza Dough']], ['Cheese, Mozzarella', 'mozz'], ['spice, sea salt', 'off-salt']]);
  assert.equal(cards[1]!.ingredients[0]!.amount, 500); // the later of the two doughs
  assert.equal(cards[2]!.ingredients[0]!.recipeId ?? cards[2]!.ingredients[0]!.productId, undefined);

  // The same recipes as before, ids aside.
  const products = [{ externalId: 'flour', name: 'Flour, 00', baseUnit: 'g', conversions: {} }, { externalId: 'mozz', name: 'Cheese, Mozzarella', baseUnit: 'oz', conversions: {} }, { externalId: 'off-salt', name: 'Salt, sea (dough), bought outside', baseUnit: 'lb', conversions: {} }];
  const before = buildRecipes(doc.recipeCards, products, { ingredientProducts: doc.importAnswers.ingredientProducts }).recipes;
  const after = buildRecipes(cards, products, { ingredientProducts: book.importAnswers!.ingredientProducts! }).recipes;
  const old = new Map(Object.entries(id).map(([name, uuid]) => [`me-${name.toLowerCase().replace(/ /g, '-')}`, uuid]));
  const swap = (s: string) => s.replace(/me-[a-z-]+/g, (m) => old.get(m) ?? m);
  const byId = (rs: typeof before) => [...rs].sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(canonical(byId(after)), swap(canonical(byId(before))));

  // Answers: by id now.
  assert.deepEqual(book.linkAnswers!.confirm.map((c) => [c.recipe, c.recipeId, c.by]), [['Margherita', id['Margherita'], staffId]]);
  assert.deepEqual([book.linkAnswers!.newDish.length, book.linkAnswers!.notFood!.length, book.linkAnswers!.priceSplit, book.linkAnswers!.priceMerge], [1, 1, ['SQ-HALF'], [{ catalogId: 'SQ-WED', into: 'SQ-M' }]]);
  assert.deepEqual(book.linkAnswers!.dismissed!.map((d) => d.dedupeKey), [`menu:off:${id['Mystery Sauce']}`]);
  assert.deepEqual(book.linkAnswers!.menuStatus!.map((m) => [m.recipeId, m.status, m.date]), [[id['Margherita'], 'stillOn', '2026-09-01']]);
  assert.deepEqual(book.modifierAnswers, {
    adds: { 'crust|extra dough': [{ item: { kind: 'recipe', id: id['Pizza Dough'] }, quantity: { amount: 1, unit: 'each' } }] },
    removes: { [`${id['Margherita']}|no cheese`]: { kind: 'product', id: 'mozz' } },
    waiting: { 'topping|lamb': 'card not in yet' },
  });
  const ia = book.importAnswers!;
  assert.deepEqual([ia.ingredientProducts, ia.manualPrices?.['off-salt']?.price, ia.conversions, ia.merges, ia.exclusive], [{ 'Spice, Sea Salt': 'off-salt' }, 25.99, { mozz: { gramsPerEach: 28 } }, [{ into: 'mozz', from: ['mozz-2'] }], ['Cheese, Mozzarella']]);
  assert.deepEqual(ia.portions!.map((p) => [p.recipe, p.ingredient, p.amount, p.recipeId]), [['Margherita', 'Cheese, Mozzarella', 2.5, id['Margherita']]]);
  // The dough salt bought outside the invoices is on the ingredient list.
  assert.equal((await db!.query("SELECT source FROM ingredients WHERE restaurant_id = $1 AND id = 'off-salt'", [rid])).rows[0]?.source, 'app');
  assert.deepEqual((await db!.query<{ item_key: string }>('SELECT item_key FROM today_snoozes WHERE restaurant_id = $1', [rid])).rows.map((r) => r.item_key), [`menu:quiet:${id['Margherita']}`]);
  assert.deepEqual((await db!.query<{ idea_key: string }>('SELECT idea_key FROM idea_dismissals WHERE restaurant_id = $1', [rid])).rows.map((r) => r.idea_key), [`dish:${id['Margherita']}`]);

  // The old copies become versions, in the background.
  for (let i = 0; i < 50 && !(await db!.query("SELECT 1 FROM book_state WHERE restaurant_id = $1 AND part = 'history'", [rid])).rows.length; i++) await new Promise((r) => setTimeout(r, 200));
  const versions = await recipeVersions(db!, rid, id['Margherita']!);
  assert.deepEqual(versions.map((v) => [v.change, v.at.slice(0, 10), v.by ?? null]), [['imported', '2026-09-15', null], ['created', '2026-09-01', 'Pat']]);

  // A rename is one change: the Margherita's line follows the dough, the Margherita doesn't get a new version.
  const renamed = cards.map((c) => (c.name === 'Pizza Dough' ? { ...c, name: 'Neapolitan Dough', updatedAt: new Date().toISOString(), updatedBy: 'Pat' } : c));
  await saveBook(db!, rid, 'recipeCards', renamed, staffId);
  const now = (await loadBook(db!, rid)).recipeCards!;
  assert.equal(now.find((c) => c.id === id['Pizza Dough'])!.name, 'Neapolitan Dough');
  assert.equal(now.find((c) => c.name === 'Margherita')!.ingredients[0]!.name, 'Neapolitan Dough');
  assert.equal((await recipeVersions(db!, rid, id['Margherita']!)).length, 2);
  assert.deepEqual((await recipeVersions(db!, rid, id['Pizza Dough']!)).map((v) => [v.change, v.by ?? null])[0], ['renamed', 'Pat']);
  // Links, portions and answers still point at the same recipes.
  const again = await loadBook(db!, rid);
  assert.equal(again.importAnswers!.portions![0]!.recipeId, id['Margherita']);
  assert.equal(again.modifierAnswers!.adds['crust|extra dough']![0]!.item.id, id['Pizza Dough']);

  // Fixes (everything saved so far) apply to every period: a past day reads today's recipes.
  assert.equal(await recipeCardsOn(db!, rid, '2026-09-10'), undefined);
  // A real change from today on: days before it keep the recipe as it read just before.
  const current = (await loadBook(db!, rid)).recipeCards!;
  await saveRecipeCards(db!, rid, current.map((c) => (c.name === 'Margherita' ? { ...c, ingredients: c.ingredients.map((i, k) => (k === 1 ? { ...i, amount: 2.75 } : i)) } : c)), staffId, { dated: new Set([id['Margherita']!]) });
  // The restaurant's yesterday (America/New_York), as the app reads days, not UTC's.
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const thenCards = (await recipeCardsOn(db!, rid, yesterday))!;
  assert.deepEqual(thenCards.find((c) => c.name === 'Margherita')!.ingredients.map((i) => [i.name, i.amount]), [['Neapolitan Dough', 1], ['Cheese, Mozzarella', 3], ['spice, sea salt', 1]]);
  assert.equal(thenCards.find((c) => c.id === id['Pizza Dough'])!.name, 'Neapolitan Dough'); // the rename was a fix: it reads the new name then too
  assert.equal((await loadBook(db!, rid)).recipeCards!.find((c) => c.name === 'Margherita')!.ingredients[1]!.amount, 2.75);
  assert.equal((await recipeVersions(db!, rid, id['Margherita']!))[0]!.dated, true);
  // Nothing changed after today: today's recipes are used as they are.
  assert.equal(await recipeCardsOn(db!, rid, new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)), undefined);

  // A card from a file (no id) lands on the recipe of its name; one left out is taken out, kept with its history.
  await saveBook(db!, rid, 'recipeCards', [margherita(3.5)], staffId);
  const fromFile = (await loadBook(db!, rid)).recipeCards!;
  assert.deepEqual(fromFile.map((c) => [c.id, c.ingredients[1]!.amount]), [[id['Margherita'], 3.5]]);
  // Before the real change, the Margherita still reads as it did (its dough line read with the name it has now, as written then).
  assert.equal((await recipeCardsOn(db!, rid, yesterday))!.find((c) => c.name === 'Margherita')!.ingredients[1]!.amount, 3);
  assert.equal((await recipeVersions(db!, rid, id['Mystery Sauce']!))[0]!.change, 'removed');
  // Its old line to the dough (gone now) reads as written and matches nothing.
  assert.equal(fromFile[0]!.ingredients[0]!.recipeId, undefined);
});
