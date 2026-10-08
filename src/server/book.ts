/**
 * The kitchen book: recipes and every answer managers have given, kept in their own tables
 * (db/migrations/0035). The rest of the app reads and writes it in the shapes it always has
 * (recipe cards, link answers, import answers, modifier answers) through loadBook and saveBook;
 * this file turns those into rows and back.
 *
 *   recipes, recipe_lines      one row per recipe (permanent id) and per line. A line keeps its
 *                              name as written and what it was matched to (another recipe or an
 *                              ingredient), so a rename follows it.
 *   recipe_versions            every save of a recipe, dated: its history, and how a past period
 *                              is costed (the recipe as it was on the period's last day).
 *   dish_links, dismissed_checks, price_folds, menu_status       the link answers
 *   ingredient_answers, ingredient_aliases, confirmed_portions,
 *   importer_answers                                             the import answers
 *   modifier_answers                                             the modifier answers
 *
 * A line is matched by its name, the same way as always (a name a manager pinned to an
 * ingredient, then a recipe of that name, then an ingredient of that name). What it matched is
 * stored, and when the thing it matched is renamed, the line reads with the new name.
 *
 * Moving over: the first time a restaurant's book is read after the tables arrive, the old
 * kitchen_book document is copied in and checked (every recipe must cost the same way from the
 * tables as from the document). If anything doesn't match, nothing is kept and the app carries
 * on from the document. Old saved copies of the book become recipe versions in the background.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { inTurn } from './turns.ts';
import { ensureMarginEdgeImported } from './meImport.ts';
import { buildRecipes, FREE_PRODUCTS, normalizeName, recipeId as legacyId, type CardIngredient, type RecipeCard } from '../core/recipeCards.ts';
import type { ModifierAnswers } from '../core/modifiers.ts';
import type { PurchasedProduct } from '../core/purchasing.ts';
import { invalidate, type BookKey, type KitchenBook, type LinkAnswers, type PilotImportAnswers } from './model.ts';

// ---------------------------------------------------------------- small helpers

/** A value as a jsonb literal for a script, dollar-quoted so nothing in it needs escaping. */
function lit(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  let tag = 'j';
  while (s.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${s}$${tag}$::jsonb`;
}
const text = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** JSON with keys in order, so two values that say the same thing read the same. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const js = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const num = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(v));
const ISO = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const iso = (col: string) => ISO.replace('%s', col);

/** One name for a recipe at a time; how names are compared everywhere in the book. */
const keyOf = (name: string) => normalizeName(name);
const sameKey = (a: string, b: string) => keyOf(a) === keyOf(b);
/** The old name-made ids ("me-pizza-dough") still in saved answers and to-do keys. */
const LEGACY_ID = /(?<![a-z0-9])me-[a-z0-9]+(?:-[a-z0-9]+)*/g;

/** The book changed: the model drops what it built from it. */
const onChange = (restaurantId: string) => invalidate(restaurantId);

// ---------------------------------------------------------------- matching names

interface Names {
  told: Map<string, string>;
  recipeByKey: Map<string, string>;
  productByKey: Map<string, string>;
  recipeName: Map<string, string>;
  productName: Map<string, string>;
}
type Match = { recipeId: string } | { productId: string } | Record<string, never>;

/** A line's name to what it is, the way recipes have always read them. */
function match(n: Names, name: string): Match {
  const k = keyOf(name);
  if (n.told.has(k)) return { productId: n.told.get(k)! };
  if (n.recipeByKey.has(k)) return { recipeId: n.recipeByKey.get(k)! };
  if (n.productByKey.has(k)) return { productId: n.productByKey.get(k)! };
  return {};
}
const matchOf = (m: Match) => ('recipeId' in m ? { sub: m.recipeId as string } : 'productId' in m ? { ing: m.productId as string } : {});

/**
 * How a stored line reads: its own name while that still means what it matched; once the thing
 * it matched has been renamed, the new name.
 */
function displayName(n: Names, written: string, sub: string | null | undefined, ing: string | null | undefined): string {
  const now = match(n, written);
  if (sub) {
    if ('recipeId' in now && now.recipeId === sub) return written;
    return n.recipeName.get(sub) ?? written;
  }
  if (ing) {
    if ('productId' in now && now.productId === ing) return written;
    return n.productName.get(ing) ?? written;
  }
  return written;
}

async function productNames(db: Db, restaurantId: string): Promise<{ id: string; name: string }[]> {
  const rows = (await db.query<{ id: string; name: string }>('SELECT id, name FROM ingredients WHERE restaurant_id = $1 AND active ORDER BY name', [restaurantId])).rows;
  return rows;
}

/** The names a set of cards is matched against: the cards themselves, the ingredient list and pinned names. */
function namesFor(cards: { id: string; name: string }[], products: { id: string; name: string }[], aliases: Map<string, string>): Names {
  // As buildRecipes does: water and ice are always the free ones; later duplicates win.
  const freeNames = new Set(FREE_PRODUCTS.map((p) => keyOf(p.name)));
  const all = [...products.filter((p) => !freeNames.has(keyOf(p.name))), ...FREE_PRODUCTS.map((p) => ({ id: p.externalId, name: p.name }))];
  return {
    told: aliases,
    recipeByKey: new Map(cards.map((c) => [keyOf(c.name), c.id])),
    productByKey: new Map(all.map((p) => [keyOf(p.name), p.id])),
    recipeName: new Map(cards.map((c) => [c.id, c.name])),
    productName: new Map([...products, ...FREE_PRODUCTS.map((p) => ({ id: p.externalId, name: p.name }))].map((p) => [p.id, p.name])),
  };
}

async function aliasMap(db: Db, restaurantId: string): Promise<Map<string, string>> {
  return new Map((await db.query<{ name_key: string; ingredient_id: string }>('SELECT name_key, ingredient_id FROM ingredient_aliases WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.name_key, r.ingredient_id]));
}

// ---------------------------------------------------------------- where the book lives

const ready = new Set<string>();
const failed = new Set<string>();
const historyStarted = new Set<string>();

async function hasPart(db: Db, restaurantId: string, part: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM book_state WHERE restaurant_id = $1 AND part = $2', [restaurantId, part])).rows.length > 0;
}

/** True once the restaurant's book is in the tables (moving it over the first time); false: still the old document. */
async function inTables(db: Db, restaurantId: string): Promise<boolean> {
  if (ready.has(restaurantId)) return true;
  if (failed.has(restaurantId)) return false;
  return inTurn(`book:${restaurantId}`, async () => {
    if (ready.has(restaurantId)) return true;
    if (!(await hasPart(db, restaurantId, 'converted'))) {
      try {
        await moveFromDocument(db, restaurantId);
      } catch (err) {
        console.error(`[book ${restaurantId}] couldn't move the kitchen book into its tables; still using the document:`, err);
        failed.add(restaurantId);
        return false;
      }
    }
    ready.add(restaurantId);
    if (!historyStarted.has(restaurantId) && !(await hasPart(db, restaurantId, 'history'))) {
      historyStarted.add(restaurantId);
      // Old copies of the book become recipe versions, after the reply goes out.
      setTimeout(() => void inTurn(`book:${restaurantId}`, () => importHistory(db, restaurantId)).catch((err) => console.error(`[book ${restaurantId}] history:`, err)), 0);
    }
    return true;
  });
}

// ---------------------------------------------------------------- reading

const loaded = new Map<string, { stamp: string; book: Partial<KitchenBook> }>();

/** A stamp that changes whenever the book or the ingredient names change. */
export async function bookStamp(db: Db, restaurantId: string): Promise<string> {
  const r = (await db.query<{ stamp: string }>(
    `SELECT concat_ws('|', (SELECT max(updated_at)::text FROM book_state WHERE restaurant_id = $1),
       (SELECT max(updated_at)::text FROM kitchen_book WHERE restaurant_id = $1),
       (SELECT max(updated_at)::text FROM ingredients WHERE restaurant_id = $1)) AS stamp`, [restaurantId])).rows[0];
  return r?.stamp ?? '';
}

export async function loadBook(db: Db, restaurantId: string): Promise<Partial<KitchenBook>> {
  if (!(await inTables(db, restaurantId))) return loadDocument(db, restaurantId);
  const stamp = await bookStamp(db, restaurantId);
  const hit = loaded.get(restaurantId);
  // Callers change what they're given before saving it, so each gets its own copy.
  if (hit && hit.stamp === stamp) return structuredClone(hit.book);
  const book = await readTables(db, restaurantId);
  loaded.set(restaurantId, { stamp, book });
  return structuredClone(book);
}

interface RecipeRow {
  id: string; name: string; position: number; category: string | null; recipe_type: string | null; yields: unknown; shelf_life_days: unknown; menu_price: unknown; card_total: unknown;
  method: string | null; unread_lines: unknown; layout: 'card' | 'costing'; rough: boolean; updated_at: string | null; updated_by: string | null; removed_at?: string | null;
}
interface LineRow {
  recipe_id: string; line_number: number; name: string; amount: unknown; unit: string; yield_percent: unknown; card_cost: unknown; type: string | null; note: string | null;
  sub_recipe_id: string | null; ingredient_id: string | null;
}
const RECIPE_COLS = `id, name, position, category, recipe_type, yields, shelf_life_days, menu_price, card_total, method, unread_lines, layout, rough, ${iso('updated_at')} AS updated_at, updated_by`;

async function storedRecipes(db: Db, restaurantId: string, withRemoved = false): Promise<{ recipes: RecipeRow[]; lines: Map<string, LineRow[]> }> {
  const recipes = (await db.query<RecipeRow>(`SELECT ${RECIPE_COLS}, ${iso('removed_at')} AS removed_at FROM recipes WHERE restaurant_id = $1 ${withRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY position, created_at, id`, [restaurantId])).rows;
  const lineRows = (await db.query<LineRow>(
    `SELECT l.recipe_id, l.line_number, l.name, l.amount, l.unit, l.yield_percent, l.card_cost, l.type, l.note, l.sub_recipe_id, l.ingredient_id
       FROM recipe_lines l JOIN recipes r ON r.id = l.recipe_id WHERE r.restaurant_id = $1 AND r.removed_at IS NULL ORDER BY l.recipe_id, l.line_number`, [restaurantId])).rows;
  const lines = new Map<string, LineRow[]>();
  for (const l of lineRows) lines.set(l.recipe_id, [...(lines.get(l.recipe_id) ?? []), l]);
  return { recipes, lines };
}

/** A stored recipe as a card, its lines read with today's names. */
function cardOf(r: RecipeRow, lines: LineRow[], n: Names): RecipeCard {
  const shelf = num(r.shelf_life_days), price = num(r.menu_price), total = num(r.card_total);
  return {
    id: r.id,
    name: r.name,
    ...(r.category ? { category: r.category } : {}),
    ...(r.recipe_type ? { recipeType: r.recipe_type } : {}),
    yields: js<RecipeCard['yields']>(r.yields) ?? [],
    ...(shelf !== undefined ? { shelfLifeDays: shelf } : {}),
    ...(price !== undefined ? { menuPrice: price } : {}),
    ...(total !== undefined ? { cardTotal: total } : {}),
    ingredients: lines.map((l) => lineOf(l, n)),
    ...(r.method ? { method: r.method } : {}),
    unreadLines: js<string[]>(r.unread_lines) ?? [],
    layout: r.layout,
    ...(r.rough ? { status: 'rough' as const } : {}),
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
    ...(r.updated_by ? { updatedBy: r.updated_by } : {}),
  };
}
function lineOf(l: LineRow, n: Names): CardIngredient {
  const cost = num(l.card_cost);
  return {
    amount: Number(l.amount), unit: l.unit, name: displayName(n, l.name, l.sub_recipe_id, l.ingredient_id), yieldPercent: Number(l.yield_percent),
    ...(cost !== undefined ? { cardCost: cost } : {}), ...(l.type ? { type: l.type } : {}), ...(l.note ? { note: l.note } : {}),
    ...(l.sub_recipe_id ? { recipeId: l.sub_recipe_id } : l.ingredient_id ? { productId: l.ingredient_id } : {}),
  };
}

async function readTables(db: Db, restaurantId: string): Promise<Partial<KitchenBook>> {
  const q = <T>(sql: string) => db.query<T>(sql, [restaurantId]).then((r) => r.rows);
  const [{ recipes, lines }, products, aliases] = await Promise.all([storedRecipes(db, restaurantId), productNames(db, restaurantId), aliasMap(db, restaurantId)]);
  const n = namesFor(recipes, products, aliases);
  const recipeCards = recipes.map((r) => cardOf(r, lines.get(r.id) ?? [], n));
  const productName = n.productName;
  const recipeName = n.recipeName;

  // Link answers.
  const links = await q<{ kind: string; catalog_id: string; item_name: string; variation_name: string; from_date: string | null; recipe_id: string | null; recipe_name: string | null; portion: unknown; note: string | null; answered_at: string | null; answered_by: string | null }>(
    `SELECT kind, catalog_id, item_name, variation_name, from_date::text AS from_date, recipe_id, recipe_name, portion, note, ${iso('answered_at')} AS answered_at, answered_by FROM dish_links WHERE restaurant_id = $1 ORDER BY position, id`);
  const item = (l: (typeof links)[number]) => ({ catalogId: l.catalog_id, itemName: l.item_name, ...(l.variation_name ? { variationName: l.variation_name } : {}) });
  const stamp = (at: string | null, by: string | null) => ({ ...(at ? { at } : {}), ...(by ? { by } : {}) });
  const linkAnswers: LinkAnswers = {
    confirm: links.filter((l) => l.kind === 'recipe').map((l) => ({
      ...item(l), recipe: (l.recipe_id ? recipeName.get(l.recipe_id) : undefined) ?? l.recipe_name ?? '', ...(l.recipe_id && recipeName.has(l.recipe_id) ? { recipeId: l.recipe_id } : {}),
      ...(l.portion ? { portion: js(l.portion) } : {}), ...(l.from_date ? { from: l.from_date } : {}), ...(l.note ? { note: l.note } : {}), ...stamp(l.answered_at, l.answered_by) })),
    newDish: links.filter((l) => l.kind === 'newDish').map((l) => ({ ...item(l), ...(l.from_date ? { from: l.from_date } : {}), ...(l.note ? { note: l.note } : {}), ...stamp(l.answered_at, l.answered_by) })),
    notFood: links.filter((l) => l.kind === 'notFood').map((l) => ({ ...item(l), ...(l.note ? { note: l.note } : {}), ...stamp(l.answered_at, l.answered_by) })),
  };
  const dismissed = await q<{ dedupe_key: string; note: string | null; answered_at: string | null; answered_by: string | null }>(`SELECT dedupe_key, note, ${iso('answered_at')} AS answered_at, answered_by FROM dismissed_checks WHERE restaurant_id = $1 ORDER BY position, dedupe_key`);
  if (dismissed.length) linkAnswers.dismissed = dismissed.map((d) => ({ dedupeKey: d.dedupe_key, ...(d.note ? { note: d.note } : {}), ...stamp(d.answered_at, d.answered_by) }));
  const folds = await q<{ kind: string; catalog_id: string; into_catalog_id: string | null }>('SELECT kind, catalog_id, into_catalog_id FROM price_folds WHERE restaurant_id = $1 ORDER BY position, catalog_id');
  if (folds.some((f) => f.kind === 'split')) linkAnswers.priceSplit = folds.filter((f) => f.kind === 'split').map((f) => f.catalog_id);
  if (folds.some((f) => f.kind === 'merge')) linkAnswers.priceMerge = folds.filter((f) => f.kind === 'merge').map((f) => ({ catalogId: f.catalog_id, into: f.into_catalog_id! }));
  const status = await q<{ subject: string; status: 'off' | 'on' | 'stillOn'; day: string; name: string | null; answered_at: string | null; answered_by: string | null }>(
    `SELECT subject, status, day::text AS day, name, ${iso('answered_at')} AS answered_at, answered_by FROM menu_status WHERE restaurant_id = $1 ORDER BY position, subject`);
  if (status.length) linkAnswers.menuStatus = status.map((m) => ({ recipeId: m.subject, status: m.status, date: m.day, ...(m.name ? { name: recipeName.get(m.subject) ?? m.name } : {}), ...stamp(m.answered_at, m.answered_by) }));

  // Import answers.
  const answers = await q<{ ingredient_id: string; conversions: unknown; manual_price: unknown; exclusive: boolean; partly_grown: unknown }>('SELECT ingredient_id, conversions, manual_price, exclusive, partly_grown FROM ingredient_answers WHERE restaurant_id = $1 ORDER BY ingredient_id');
  const aliasRows = await q<{ name: string; ingredient_id: string }>('SELECT name, ingredient_id FROM ingredient_aliases WHERE restaurant_id = $1 ORDER BY name_key');
  const portions = await q<{ recipe_id: string; ingredient_name: string; ingredient_id: string | null; amount: unknown; unit: string; source: string | null }>('SELECT recipe_id, ingredient_name, ingredient_id, amount, unit, source FROM confirmed_portions WHERE restaurant_id = $1 ORDER BY recipe_id, ingredient_name');
  const importer = (await q<{ answers: unknown }>("SELECT answers FROM importer_answers WHERE restaurant_id = $1 AND source = 'marginedge'"))[0];
  const me = importer ? js<{ packs?: PilotImportAnswers['packs']; merges?: PilotImportAnswers['merges'] }>(importer.answers) : {};
  const importAnswers: PilotImportAnswers = {};
  if (me.merges?.length) importAnswers.merges = me.merges;
  if (me.packs?.length) importAnswers.packs = me.packs;
  const conversions = answers.filter((a) => a.conversions);
  if (conversions.length) importAnswers.conversions = Object.fromEntries(conversions.map((a) => [a.ingredient_id, js(a.conversions)]));
  if (aliasRows.length) importAnswers.ingredientProducts = Object.fromEntries(aliasRows.map((a) => [a.name, a.ingredient_id]));
  const prices = answers.filter((a) => a.manual_price);
  if (prices.length) importAnswers.manualPrices = Object.fromEntries(prices.map((a) => [a.ingredient_id, js(a.manual_price)]));
  if (portions.length) importAnswers.portions = portions.map((p) => ({ recipe: recipeName.get(p.recipe_id) ?? '', ingredient: (p.ingredient_id ? productName.get(p.ingredient_id) : undefined) ?? p.ingredient_name, amount: Number(p.amount), unit: p.unit,
    ...(p.source ? { source: p.source } : {}), recipeId: p.recipe_id, ...(p.ingredient_id ? { productId: p.ingredient_id } : {}) }));
  const exclusive = answers.filter((a) => a.exclusive);
  if (exclusive.length) importAnswers.exclusive = exclusive.map((a) => productName.get(a.ingredient_id) ?? a.ingredient_id);
  const grown = answers.filter((a) => a.partly_grown);
  if (grown.length) importAnswers.partlyGrown = grown.map((a) => ({ product: a.ingredient_id, ...js<{ note?: string }>(a.partly_grown) }));

  // Modifier answers.
  const mods = await q<{ kind: string; key: string; answer: unknown }>('SELECT kind, key, answer FROM modifier_answers WHERE restaurant_id = $1 ORDER BY kind, key');
  const modifierAnswers: ModifierAnswers = {
    adds: Object.fromEntries(mods.filter((m) => m.kind === 'add').map((m) => [m.key, js(m.answer)])),
    removes: Object.fromEntries(mods.filter((m) => m.kind === 'remove').map((m) => [m.key, js(m.answer)])),
  };
  // A reason is text: kept as it comes back (both drivers hand jsonb back already read).
  if (mods.some((m) => m.kind === 'waiting')) modifierAnswers.waiting = Object.fromEntries(mods.filter((m) => m.kind === 'waiting').map((m) => [m.key, String(m.answer)]));

  const has = new Set((await q<{ part: string }>('SELECT part FROM book_state WHERE restaurant_id = $1')).map((r) => r.part));
  return {
    ...(recipeCards.length || has.has('recipeCards') ? { recipeCards } : {}),
    ...(has.has('importAnswers') || Object.keys(importAnswers).length ? { importAnswers } : {}),
    ...(has.has('linkAnswers') || links.length ? { linkAnswers } : {}),
    ...(has.has('modifierAnswers') || mods.length ? { modifierAnswers } : {}),
  };
}

/**
 * The recipe cards as they read on a day: each recipe's latest version saved by then (one
 * that didn't exist yet: its first version; one taken out by then: left out). Undefined when
 * nothing has changed since that day, so the caller uses today's.
 */
export async function recipeCardsOn(db: Db, restaurantId: string, day: string): Promise<RecipeCard[] | undefined> {
  if (!(await inTables(db, restaurantId))) return undefined;
  const after = (await db.query("SELECT 1 FROM recipe_versions WHERE restaurant_id = $1 AND saved_at >= ($2::date + 1) AND change <> 'imported' LIMIT 1", [restaurantId, day])).rows.length;
  if (!after) return undefined;
  const rows = (await db.query<{ recipe_id: string; change: string; card: unknown; on_day: boolean; position: number }>(
    `SELECT DISTINCT ON (v.recipe_id) v.recipe_id, v.change, v.card, v.saved_at < ($2::date + 1) AS on_day, r.position
       FROM recipe_versions v JOIN recipes r ON r.id = v.recipe_id
      WHERE v.restaurant_id = $1
      ORDER BY v.recipe_id, (v.saved_at < ($2::date + 1)) DESC, CASE WHEN v.saved_at < ($2::date + 1) THEN -extract(epoch FROM v.saved_at) ELSE extract(epoch FROM v.saved_at) END, v.id DESC`,
    [restaurantId, day])).rows;
  const kept = rows.filter((r) => r.change !== 'removed').sort((a, b) => a.position - b.position);
  const snapshots = kept.map((r) => ({ ...js<RecipeCard>(r.card), id: r.recipe_id }));
  const n = namesFor(snapshots.map((c) => ({ id: c.id!, name: c.name })), await productNames(db, restaurantId), await aliasMap(db, restaurantId));
  // Each line read with the names of that day.
  return snapshots.map((c) => ({ ...c, ingredients: c.ingredients.map((i) => ({ ...i, name: displayName(n, i.name, i.recipeId, i.productId) })) }));
}

// ---------------------------------------------------------------- writing

export async function saveBook(db: Db, restaurantId: string, key: BookKey, value: unknown, staffId?: string): Promise<void> {
  if (!(await inTables(db, restaurantId))) return saveDocument(db, restaurantId, key, value, staffId);
  if (key === 'recipeCards') await saveRecipeCards(db, restaurantId, value as RecipeCard[], staffId);
  else if (key === 'linkAnswers') await saveLinkAnswers(db, restaurantId, value as LinkAnswers, staffId);
  else if (key === 'importAnswers') await saveImportAnswers(db, restaurantId, value as PilotImportAnswers, staffId);
  else await saveModifierAnswers(db, restaurantId, value as ModifierAnswers, staffId);
  loaded.delete(restaurantId);
  onChange(restaurantId);
}

const touch = (restaurantId: string, part: string, staffId?: string | null) =>
  `INSERT INTO book_state (restaurant_id, part, updated_at, updated_by) VALUES (${text(restaurantId)}, ${text(part)}, clock_timestamp(), ${staffId ? text(staffId) + '::uuid' : 'NULL'})
     ON CONFLICT (restaurant_id, part) DO UPDATE SET updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;`;

type Change = 'created' | 'edited' | 'renamed' | 'removed' | 'restored' | 'imported';
interface SaveOptions { change?: Change; at?: string }

/** What a card says, apart from when and by whom: two cards that say the same thing aren't a new version. */
const contentOf = (c: RecipeCard) => JSON.stringify([c.name, c.category ?? null, c.recipeType ?? null, (c.yields ?? []).map((y) => [Number(y.amount), y.unit]), c.shelfLifeDays ?? null, c.menuPrice ?? null, c.cardTotal ?? null, c.method ?? null, c.unreadLines, c.layout, c.status ?? null,
  c.ingredients.map((i) => [i.name, Number(i.amount) || 0, i.unit ?? '', Number(i.yieldPercent) || 100, i.cardCost ?? null, i.type ?? null, i.note ?? null])]);

/**
 * The book's recipes are now these cards: new ones added, changed ones saved (each a new
 * version), missing ones taken out (kept, with their history). Cards are known by their id, or
 * (a card from a file) by name.
 */
export async function saveRecipeCards(db: Db, restaurantId: string, incoming: RecipeCard[], staffId?: string, options: SaveOptions = {}): Promise<Map<string, string>> {
  const { recipes: all, lines } = await storedRecipes(db, restaurantId, true);
  const products = await productNames(db, restaurantId);
  const aliases = await aliasMap(db, restaurantId);
  const byId = new Map(all.map((r) => [r.id, r]));
  const active = all.filter((r) => !r.removed_at);
  const staffName = staffId ? (await db.query<{ display_name: string }>('SELECT display_name FROM staff WHERE id = $1', [staffId])).rows[0]?.display_name ?? null : null;
  const storedNames = namesFor(active, products, aliases);
  const storedCard = new Map(active.map((r) => [r.id, cardOf(r, lines.get(r.id) ?? [], storedNames)]));

  // One card per name (the last, as the book has always read), each with its id.
  const lastOf = new Map<string, number>();
  incoming.forEach((c, i) => lastOf.set(keyOf(c.name), i));
  const cards = incoming.filter((c, i) => lastOf.get(keyOf(c.name)) === i && c.name.trim());
  const taken = new Set<string>();
  const ids = cards.map((c) => {
    let id = c.id && byId.has(c.id) && !taken.has(c.id) ? c.id : undefined;
    id ??= active.find((r) => sameKey(r.name, c.name) && !taken.has(r.id))?.id;
    id ??= randomUUID();
    taken.add(id);
    return id;
  });
  const n = namesFor(cards.map((c, i) => ({ id: ids[i]!, name: c.name.trim() })), products, aliases);

  const recipeRows: unknown[] = [], lineRows: unknown[] = [], versionRows: unknown[] = [];
  const rewrite = new Set<string>(), renamed = new Set<string>(), restored = new Set<string>();
  const at = options.at ?? new Date().toISOString();
  cards.forEach((c, i) => {
    const id = ids[i]!;
    const before = byId.get(id);
    const was = storedCard.get(id);
    // Each line matched by its name; a name that matches nothing keeps what it matched before.
    const oldLines = lines.get(id) ?? [];
    const own = c.ingredients.map((l, k) => {
      const m = matchOf(match(n, l.name));
      if (m.sub || m.ing) return m;
      const prev = oldLines.find((o, j) => (j === k || o.name === l.name) && (o.sub_recipe_id || o.ingredient_id) && (o.name === l.name || displayName(storedNames, o.name, o.sub_recipe_id, o.ingredient_id) === l.name));
      const keep = l.recipeId ? { sub: l.recipeId } : l.productId ? { ing: l.productId } : prev ? (prev.sub_recipe_id ? { sub: prev.sub_recipe_id } : { ing: prev.ingredient_id! }) : {};
      // A recipe that isn't in the book any more can't be pointed at.
      return keep.sub && !ids.includes(keep.sub) ? {} : keep;
    });
    const stored: RecipeCard = { ...c, id, name: c.name.trim(), ingredients: c.ingredients.map((l, k) => ({ ...l, ...(own[k]!.sub ? { recipeId: own[k]!.sub } : {}), ...(own[k]!.ing ? { productId: own[k]!.ing } : {}) })) };
    const changed = !was || contentOf(was) !== contentOf(stored);
    const pinsChanged = !changed && (oldLines.length !== own.length || oldLines.some((o, k) => (o.sub_recipe_id ?? null) !== (own[k]!.sub ?? null) || (o.ingredient_id ?? null) !== (own[k]!.ing ?? null)));
    if (before?.position !== i || changed || (before && before.removed_at)) {
      recipeRows.push({
        id, name: stored.name, position: i, category: c.category ?? null, recipe_type: c.recipeType ?? null, yields: c.yields ?? [], shelf_life_days: c.shelfLifeDays ?? null,
        menu_price: c.menuPrice ?? null, card_total: c.cardTotal ?? null, method: c.method ?? null, unread_lines: c.unreadLines ?? [], layout: c.layout ?? 'card', rough: c.status === 'rough',
        updated_at: c.updatedAt ?? null, updated_by: c.updatedBy ?? null,
      });
    }
    if (changed || pinsChanged || (before && before.removed_at)) {
      rewrite.add(id);
      c.ingredients.forEach((l, k) => lineRows.push({
        recipe_id: id, line_number: k + 1, name: l.name, amount: Number(l.amount) || 0, unit: l.unit ?? '', yield_percent: Number(l.yieldPercent) || 100, card_cost: l.cardCost ?? null,
        type: l.type ?? null, note: l.note ?? null, sub_recipe_id: own[k]!.sub ?? null, ingredient_id: own[k]!.ing ?? null,
      }));
    }
    if (before && !before.removed_at && before.name !== stored.name) renamed.add(id);
    if (before?.removed_at) restored.add(id);
    if (changed || before?.removed_at) {
      const change: Change = options.change ?? (!before ? 'created' : before.removed_at ? 'restored' : was && contentOf({ ...was, name: stored.name }) === contentOf(stored) ? 'renamed' : 'edited');
      versionRows.push({ recipe_id: id, saved_at: at, saved_by: staffId ?? null, saved_by_name: staffName ?? c.updatedBy ?? null, change, card: stored });
    }
  });
  const gone = active.filter((r) => !ids.includes(r.id));
  for (const r of gone) versionRows.push({ recipe_id: r.id, saved_at: at, saved_by: staffId ?? null, saved_by_name: staffName, change: 'removed', card: storedCard.get(r.id) });

  const rid = text(restaurantId);
  const idList = (xs: Iterable<string>) => [...xs].map((x) => `${text(x)}::uuid`).join(', ') || 'NULL';
  const script = [
    // Out first, and renamed ones out of the way, so names can move between recipes in one save.
    gone.length ? `UPDATE recipes SET removed_at = ${text(at)}::timestamptz WHERE id IN (${idList(gone.map((r) => r.id))});` : '',
    renamed.size ? `UPDATE recipes SET name = name || ' ~' || id WHERE id IN (${idList(renamed)});` : '',
    recipeRows.length ? `INSERT INTO recipes (restaurant_id, id, name, position, category, recipe_type, yields, shelf_life_days, menu_price, card_total, method, unread_lines, layout, rough, updated_at, updated_by)
      SELECT ${rid}, x.id, x.name, x.position, x.category, x.recipe_type, x.yields, x.shelf_life_days, x.menu_price, x.card_total, x.method, x.unread_lines, x.layout, x.rough, x.updated_at, x.updated_by
        FROM jsonb_to_recordset(${lit(recipeRows)}) AS x(id uuid, name text, position int, category text, recipe_type text, yields jsonb, shelf_life_days numeric, menu_price numeric, card_total numeric, method text, unread_lines jsonb, layout text, rough boolean, updated_at timestamptz, updated_by text)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, category = EXCLUDED.category, recipe_type = EXCLUDED.recipe_type, yields = EXCLUDED.yields,
        shelf_life_days = EXCLUDED.shelf_life_days, menu_price = EXCLUDED.menu_price, card_total = EXCLUDED.card_total, method = EXCLUDED.method, unread_lines = EXCLUDED.unread_lines,
        layout = EXCLUDED.layout, rough = EXCLUDED.rough, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, removed_at = NULL;` : '',
    rewrite.size ? `DELETE FROM recipe_lines WHERE recipe_id IN (${idList(rewrite)});` : '',
    lineRows.length ? `INSERT INTO recipe_lines (recipe_id, line_number, name, amount, unit, yield_percent, card_cost, type, note, sub_recipe_id, ingredient_id)
      SELECT x.recipe_id, x.line_number, x.name, x.amount, x.unit, x.yield_percent, x.card_cost, x.type, x.note, x.sub_recipe_id, x.ingredient_id
        FROM jsonb_to_recordset(${lit(lineRows)}) AS x(recipe_id uuid, line_number int, name text, amount numeric, unit text, yield_percent numeric, card_cost numeric, type text, note text, sub_recipe_id uuid, ingredient_id text);` : '',
    versionRows.length ? `INSERT INTO recipe_versions (restaurant_id, recipe_id, saved_at, saved_by, saved_by_name, change, card)
      SELECT ${rid}, x.recipe_id, x.saved_at, x.saved_by, x.saved_by_name, x.change, x.card
        FROM jsonb_to_recordset(${lit(versionRows)}) AS x(recipe_id uuid, saved_at timestamptz, saved_by uuid, saved_by_name text, change text, card jsonb);` : '',
    // Prep items and plans named for a recipe that's only now in the book find it.
    `UPDATE station_items SET recipe_id = NULL WHERE restaurant_id = ${rid} AND recipe_id IS NULL AND recipe_name IS NOT NULL;`,
    `UPDATE menu_plans SET recipe_id = NULL WHERE restaurant_id = ${rid} AND recipe_id IS NULL AND recipe_name IS NOT NULL;`,
    touch(restaurantId, 'recipeCards', staffId),
  ].filter(Boolean).join('\n');
  await db.script(script);
  // Other recipes' lines may now mean something else (a new recipe of a name an ingredient had).
  await repin(db, restaurantId);
  return new Map(cards.map((c, i) => [c.name.trim(), ids[i]!]));
}

/** Every line's match brought up to date with its name, where its name matches something now. */
async function repin(db: Db, restaurantId: string): Promise<void> {
  const { recipes, lines } = await storedRecipes(db, restaurantId);
  const n = namesFor(recipes, await productNames(db, restaurantId), await aliasMap(db, restaurantId));
  const updates: unknown[] = [];
  for (const [recipeId, ls] of lines) for (const l of ls) {
    const m = matchOf(match(n, displayName(n, l.name, l.sub_recipe_id, l.ingredient_id)));
    if (!m.sub && !m.ing) continue;
    if ((m.sub ?? null) !== (l.sub_recipe_id ?? null) || (m.ing ?? null) !== (l.ingredient_id ?? null)) updates.push({ recipe_id: recipeId, line_number: l.line_number, sub: m.sub ?? null, ing: m.ing ?? null });
  }
  if (!updates.length) return;
  await db.script(`UPDATE recipe_lines l SET sub_recipe_id = x.sub, ingredient_id = x.ing FROM jsonb_to_recordset(${lit(updates)}) AS x(recipe_id uuid, line_number int, sub uuid, ing text)
    WHERE l.recipe_id = x.recipe_id AND l.line_number = x.line_number;`);
}

/** The old name-made ids in a value, swapped for the recipes' own (a file from Claude still uses them). */
async function legacyIds(db: Db, restaurantId: string): Promise<Map<string, string>> {
  const rows = (await db.query<{ id: string; name: string; removed: boolean }>('SELECT id, name, removed_at IS NOT NULL AS removed FROM recipes WHERE restaurant_id = $1 ORDER BY removed_at IS NULL, position', [restaurantId])).rows;
  // Recipes in the book win over ones taken out with the same old id.
  return new Map(rows.map((r) => [legacyId(r.name), r.id]));
}
const swapIds = <T>(value: T, map: Map<string, string>): T => (map.size ? JSON.parse(JSON.stringify(value).replace(LEGACY_ID, (m) => map.get(m) ?? m)) : value);

export async function saveLinkAnswers(db: Db, restaurantId: string, value: LinkAnswers, staffId?: string): Promise<void> {
  const links = swapIds(value, await legacyIds(db, restaurantId));
  const recipes = (await db.query<{ id: string; name: string }>('SELECT id, name FROM recipes WHERE restaurant_id = $1 AND removed_at IS NULL', [restaurantId])).rows;
  const ids = new Set(recipes.map((r) => r.id));
  // A link names its recipe exactly as it reads (as links always have); its id, once known, wins.
  const byName = new Map(recipes.map((r) => [r.name, r.id]));
  const rows: unknown[] = [];
  const base = (x: { catalogId: string; itemName: string; variationName?: string; from?: string; note?: string; at?: string; by?: string }) => ({
    catalog_id: x.catalogId, item_name: x.itemName, variation_name: x.variationName ?? '', from_date: x.from ?? null, note: x.note ?? null, answered_at: x.at ?? null, answered_by: x.by ?? null });
  for (const x of links.confirm ?? []) {
    const rid = (x as { recipeId?: string }).recipeId;
    const id = rid && ids.has(rid) && (!x.recipe || byName.get(x.recipe) === rid || !byName.has(x.recipe)) ? rid : byName.get(x.recipe);
    rows.push({ ...base(x), kind: 'recipe', recipe_id: id ?? null, recipe_name: x.recipe ?? null, portion: x.portion ?? null });
  }
  for (const x of links.newDish ?? []) rows.push({ ...base(x), kind: 'newDish', recipe_id: null, recipe_name: null, portion: null });
  for (const x of links.notFood ?? []) rows.push({ ...base(x), kind: 'notFood', recipe_id: null, recipe_name: null, portion: null });
  const lastKey = new Map<string, number>();
  (links.dismissed ?? []).forEach((d, i) => lastKey.set(d.dedupeKey, i));
  const dismissed = (links.dismissed ?? []).filter((d, i) => lastKey.get(d.dedupeKey) === i).map((d, i) => ({ dedupe_key: d.dedupeKey, position: i, note: d.note ?? null, answered_at: d.at ?? null, answered_by: d.by ?? null }));
  const folds = [
    ...[...new Set(links.priceSplit ?? [])].map((c, i) => ({ kind: 'split', catalog_id: c, into_catalog_id: null, position: i })),
    ...[...new Map((links.priceMerge ?? []).map((m) => [m.catalogId, m])).values()].map((m, i) => ({ kind: 'merge', catalog_id: m.catalogId, into_catalog_id: m.into, position: i })),
  ];
  const lastStatus = new Map<string, number>();
  (links.menuStatus ?? []).forEach((m, i) => lastStatus.set(m.recipeId, i));
  const status = (links.menuStatus ?? []).filter((m, i) => lastStatus.get(m.recipeId) === i).map((m, i) => ({ subject: m.recipeId, position: i, status: m.status, day: m.date, name: m.name ?? null, answered_at: m.at ?? null, answered_by: m.by ?? null }));
  const rid = text(restaurantId);
  await db.script([
    `DELETE FROM dish_links WHERE restaurant_id = ${rid};`,
    rows.length ? `INSERT INTO dish_links (restaurant_id, position, kind, catalog_id, item_name, variation_name, from_date, recipe_id, recipe_name, portion, note, answered_at, answered_by)
      SELECT ${rid}, x.position, x.kind, x.catalog_id, x.item_name, x.variation_name, x.from_date, x.recipe_id, x.recipe_name, x.portion, x.note, x.answered_at, x.answered_by
        FROM jsonb_to_recordset(${lit(rows.map((r, i) => ({ ...(r as object), position: i })))}) AS x(position int, kind text, catalog_id text, item_name text, variation_name text, from_date date, recipe_id uuid, recipe_name text, portion jsonb, note text, answered_at timestamptz, answered_by text);` : '',
    `DELETE FROM dismissed_checks WHERE restaurant_id = ${rid};`,
    dismissed.length ? `INSERT INTO dismissed_checks (restaurant_id, dedupe_key, position, note, answered_at, answered_by)
      SELECT ${rid}, x.dedupe_key, x.position, x.note, x.answered_at, x.answered_by FROM jsonb_to_recordset(${lit(dismissed)}) AS x(dedupe_key text, position int, note text, answered_at timestamptz, answered_by text);` : '',
    `DELETE FROM price_folds WHERE restaurant_id = ${rid};`,
    folds.length ? `INSERT INTO price_folds (restaurant_id, kind, catalog_id, into_catalog_id, position)
      SELECT ${rid}, x.kind, x.catalog_id, x.into_catalog_id, x.position FROM jsonb_to_recordset(${lit(folds)}) AS x(kind text, catalog_id text, into_catalog_id text, position int);` : '',
    `DELETE FROM menu_status WHERE restaurant_id = ${rid};`,
    status.length ? `INSERT INTO menu_status (restaurant_id, subject, position, status, day, name, answered_at, answered_by)
      SELECT ${rid}, x.subject, x.position, x.status, x.day, x.name, x.answered_at, x.answered_by FROM jsonb_to_recordset(${lit(status)}) AS x(subject text, position int, status text, day date, name text, answered_at timestamptz, answered_by text);` : '',
    touch(restaurantId, 'linkAnswers', staffId),
  ].filter(Boolean).join('\n'));
}

export async function saveImportAnswers(db: Db, restaurantId: string, a: PilotImportAnswers, staffId?: string): Promise<void> {
  // Ingredients bought outside the invoices join the list.
  for (const p of a.offInvoiceProducts ?? []) {
    await db.query(`INSERT INTO ingredients (restaurant_id, id, name, base_unit, raw_unit, conversions, category, category_type, reference_price, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'app')
      ON CONFLICT (restaurant_id, id) DO NOTHING`, [restaurantId, p.externalId, p.name, p.baseUnit ?? null, p.rawUnit ?? null, JSON.stringify(p.conversions ?? {}), p.category ?? null, p.categoryType ?? null, p.referencePrice ?? null]);
  }
  const products = await productNames(db, restaurantId);
  const productByName = new Map([...products, ...FREE_PRODUCTS.map((p) => ({ id: p.externalId, name: p.name }))].map((p) => [p.name, p.id]));
  const recipes = (await db.query<{ id: string; name: string }>('SELECT id, name FROM recipes WHERE restaurant_id = $1 AND removed_at IS NULL', [restaurantId])).rows;
  const recipeByName = new Map(recipes.map((r) => [r.name, r.id]));
  const recipeIds = new Set(recipes.map((r) => r.id));

  const per = new Map<string, { conversions: unknown; manual_price: unknown; exclusive: boolean; partly_grown: unknown }>();
  const row = (id: string) => { let r = per.get(id); if (!r) { r = { conversions: null, manual_price: null, exclusive: false, partly_grown: null }; per.set(id, r); } return r; };
  for (const [id, c] of Object.entries(a.conversions ?? {})) row(id).conversions = c;
  for (const [id, p] of Object.entries(a.manualPrices ?? {})) row(id).manual_price = p;
  for (const name of a.exclusive ?? []) { const id = productByName.get(name) ?? (products.some((p) => p.id === name) ? name : undefined); if (id) row(id).exclusive = true; }
  for (const g of a.partlyGrown ?? []) row(g.product).partly_grown = g.note ? { note: g.note } : {};
  const answerRows = [...per].map(([id, r]) => ({ ingredient_id: id, ...r }));
  const aliasRows = [...new Map(Object.entries(a.ingredientProducts ?? {}).map(([name, id]) => [keyOf(name), { name_key: keyOf(name), name, ingredient_id: id }])).values()];
  // A portion names its recipe and ingredient as they read; their ids, once known, win.
  const portions = [...new Map((a.portions ?? []).map((p) => {
    const q = p as typeof p & { recipeId?: string; productId?: string };
    const recipe = q.recipeId && recipeIds.has(q.recipeId) && (recipeByName.get(p.recipe) ?? q.recipeId) === q.recipeId ? q.recipeId : recipeByName.get(p.recipe);
    const product = productByName.get(p.ingredient) ?? q.productId ?? null;
    return [`${recipe}|${p.ingredient}`, recipe ? { recipe_id: recipe, ingredient_name: p.ingredient, ingredient_id: product, amount: p.amount, unit: p.unit, source: p.source ?? null } : undefined];
  })).values()].filter(Boolean);
  const importer = { ...(a.packs?.length ? { packs: a.packs } : {}), ...(a.merges?.length ? { merges: a.merges } : {}) };
  const rid = text(restaurantId);
  await db.script([
    `DELETE FROM ingredient_answers WHERE restaurant_id = ${rid};`,
    answerRows.length ? `INSERT INTO ingredient_answers (restaurant_id, ingredient_id, conversions, manual_price, exclusive, partly_grown)
      SELECT ${rid}, x.ingredient_id, x.conversions, x.manual_price, x.exclusive, x.partly_grown FROM jsonb_to_recordset(${lit(answerRows)}) AS x(ingredient_id text, conversions jsonb, manual_price jsonb, exclusive boolean, partly_grown jsonb);` : '',
    `DELETE FROM ingredient_aliases WHERE restaurant_id = ${rid};`,
    aliasRows.length ? `INSERT INTO ingredient_aliases (restaurant_id, name_key, name, ingredient_id) SELECT ${rid}, x.name_key, x.name, x.ingredient_id FROM jsonb_to_recordset(${lit(aliasRows)}) AS x(name_key text, name text, ingredient_id text);` : '',
    `DELETE FROM confirmed_portions WHERE restaurant_id = ${rid};`,
    portions.length ? `INSERT INTO confirmed_portions (restaurant_id, recipe_id, ingredient_name, ingredient_id, amount, unit, source) SELECT ${rid}, x.recipe_id, x.ingredient_name, x.ingredient_id, x.amount, x.unit, x.source FROM jsonb_to_recordset(${lit(portions)}) AS x(recipe_id uuid, ingredient_name text, ingredient_id text, amount numeric, unit text, source text);` : '',
    Object.keys(importer).length ? `INSERT INTO importer_answers (restaurant_id, source, answers) VALUES (${rid}, 'marginedge', ${lit(importer)}) ON CONFLICT (restaurant_id, source) DO UPDATE SET answers = EXCLUDED.answers;`
      : `DELETE FROM importer_answers WHERE restaurant_id = ${rid} AND source = 'marginedge';`,
    touch(restaurantId, 'importAnswers', staffId),
  ].filter(Boolean).join('\n'));
  // A pinned name may now mean another ingredient.
  await repin(db, restaurantId);
}

export async function saveModifierAnswers(db: Db, restaurantId: string, value: ModifierAnswers, staffId?: string): Promise<void> {
  const m = swapIds(value, await legacyIds(db, restaurantId));
  const rows = [
    ...Object.entries(m.adds ?? {}).map(([key, answer]) => ({ kind: 'add', key, answer })),
    ...Object.entries(m.removes ?? {}).map(([key, answer]) => ({ kind: 'remove', key, answer })),
    ...Object.entries(m.waiting ?? {}).map(([key, answer]) => ({ kind: 'waiting', key, answer })),
  ];
  const rid = text(restaurantId);
  await db.script([
    `DELETE FROM modifier_answers WHERE restaurant_id = ${rid};`,
    rows.length ? `INSERT INTO modifier_answers (restaurant_id, kind, key, answer) SELECT ${rid}, x.kind, x.key, x.answer FROM jsonb_to_recordset(${lit(rows)}) AS x(kind text, key text, answer jsonb);` : '',
    touch(restaurantId, 'modifierAnswers', staffId),
  ].filter(Boolean).join('\n'));
}

// ---------------------------------------------------------------- history

export interface RecipeVersion { id: string; at: string; by?: string; change: Change; name: string; lines: number }

export async function recipeVersions(db: Db, restaurantId: string, recipeId: string): Promise<RecipeVersion[]> {
  const rows = (await db.query<{ id: string; at: string; by: string | null; change: Change; card: unknown }>(
    `SELECT v.id::text AS id, ${iso('v.saved_at')} AS at, coalesce(s.display_name, v.saved_by_name) AS by, v.change, v.card
       FROM recipe_versions v LEFT JOIN staff s ON s.id = v.saved_by WHERE v.restaurant_id = $1 AND v.recipe_id = $2 ORDER BY v.saved_at DESC, v.id DESC`, [restaurantId, recipeId])).rows;
  return rows.map((r) => { const c = js<RecipeCard>(r.card); return { id: r.id, at: r.at, ...(r.by ? { by: r.by } : {}), change: r.change, name: c?.name ?? '', lines: c?.ingredients?.length ?? 0 }; });
}

export async function recipeVersion(db: Db, restaurantId: string, versionId: string): Promise<{ recipeId: string; card: RecipeCard; at: string } | undefined> {
  if (!/^\d+$/.test(versionId)) return undefined;
  const r = (await db.query<{ recipe_id: string; card: unknown; at: string }>(`SELECT recipe_id, card, ${iso('saved_at')} AS at FROM recipe_versions WHERE restaurant_id = $1 AND id = $2`, [restaurantId, versionId])).rows[0];
  return r ? { recipeId: r.recipe_id, card: { ...js<RecipeCard>(r.card), id: r.recipe_id }, at: r.at } : undefined;
}

/** Puts an earlier version back as the recipe today (a new version, so nothing is lost). */
export async function restoreRecipeVersion(db: Db, restaurantId: string, versionId: string, staffId: string, by: string): Promise<{ name: string }> {
  const v = await recipeVersion(db, restaurantId, versionId);
  if (!v) throw new Error('No such version.');
  const book = await loadBook(db, restaurantId);
  const cards = book.recipeCards ?? [];
  const clash = cards.find((c) => c.id !== v.recipeId && sameKey(c.name, v.card.name));
  if (clash) throw Object.assign(new Error(`Another recipe is called ${clash.name} now. Rename it first.`), { status: 409 });
  const back: RecipeCard = { ...v.card, id: v.recipeId, updatedAt: new Date().toISOString(), updatedBy: by };
  const next = cards.some((c) => c.id === v.recipeId) ? cards.map((c) => (c.id === v.recipeId ? back : c)) : [...cards, back];
  await saveRecipeCards(db, restaurantId, next, staffId, { change: 'restored' });
  loaded.delete(restaurantId);
  onChange(restaurantId);
  return { name: back.name };
}

// ---------------------------------------------------------------- the old document

async function loadDocument(db: Db, restaurantId: string): Promise<Partial<KitchenBook>> {
  const { rows } = await db.query<{ key: BookKey; value: unknown }>('SELECT key, value FROM kitchen_book WHERE restaurant_id = $1', [restaurantId]);
  const out: Partial<KitchenBook> = {};
  for (const r of rows) (out as Record<string, unknown>)[r.key] = js(r.value);
  return out;
}

async function saveDocument(db: Db, restaurantId: string, key: BookKey, value: unknown, staffId?: string): Promise<void> {
  const json = JSON.stringify(value);
  await db.query('INSERT INTO kitchen_book_history (restaurant_id, key, value, saved_by) VALUES ($1, $2, $3, $4)', [restaurantId, key, json, staffId ?? null]);
  await db.query(
    `INSERT INTO kitchen_book (restaurant_id, key, value, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (restaurant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [restaurantId, key, json, staffId ?? null]);
  onChange(restaurantId);
}

/** Which recipe each old name-made id is, for the model to compare costs before and after the move. */
async function clearTables(db: Db, restaurantId: string): Promise<void> {
  const rid = text(restaurantId);
  await db.script([
    `DELETE FROM dish_links WHERE restaurant_id = ${rid};`, `DELETE FROM confirmed_portions WHERE restaurant_id = ${rid};`,
    `DELETE FROM dismissed_checks WHERE restaurant_id = ${rid};`, `DELETE FROM price_folds WHERE restaurant_id = ${rid};`, `DELETE FROM menu_status WHERE restaurant_id = ${rid};`,
    `DELETE FROM ingredient_answers WHERE restaurant_id = ${rid};`, `DELETE FROM ingredient_aliases WHERE restaurant_id = ${rid};`,
    `DELETE FROM importer_answers WHERE restaurant_id = ${rid};`, `DELETE FROM modifier_answers WHERE restaurant_id = ${rid};`,
    `UPDATE station_items SET recipe_id = NULL WHERE restaurant_id = ${rid};`, `UPDATE menu_plans SET recipe_id = NULL WHERE restaurant_id = ${rid};`,
    `DELETE FROM recipe_lines WHERE recipe_id IN (SELECT id FROM recipes WHERE restaurant_id = ${rid});`,
    `DELETE FROM recipe_versions WHERE restaurant_id = ${rid};`, `DELETE FROM recipes WHERE restaurant_id = ${rid};`,
    `DELETE FROM book_state WHERE restaurant_id = ${rid};`,
  ].join('\n'));
}

/**
 * The old document into the tables, checked: every recipe built from the tables must come out
 * the same as from the document (ingredients, amounts, yields, shelf life), the ids aside.
 */
async function moveFromDocument(db: Db, restaurantId: string): Promise<void> {
  const doc = await loadDocument(db, restaurantId);
  // Recipe lines and answers are matched against the ingredient list: brought up to date first.
  await ensureMarginEdgeImported(db, restaurantId, doc.importAnswers ?? {});
  const savedAt = (await db.query<{ at: string | null }>(`SELECT ${iso('updated_at')} AS at FROM kitchen_book WHERE restaurant_id = $1 AND key = 'recipeCards'`, [restaurantId])).rows[0]?.at ?? undefined;
  await clearTables(db, restaurantId);
  try {
    // Ingredients bought outside the invoices first: recipe lines match against them.
    if (doc.importAnswers) await saveImportAnswers(db, restaurantId, { ...doc.importAnswers, portions: [] });
    if (doc.recipeCards) await saveRecipeCards(db, restaurantId, doc.recipeCards.map((c) => ({ ...c, ...(savedAt && !c.updatedAt ? { updatedAt: savedAt } : {}) })), undefined, { change: 'imported', ...(savedAt ? { at: savedAt } : {}) });
    if (doc.importAnswers) await saveImportAnswers(db, restaurantId, doc.importAnswers);
    if (doc.linkAnswers) await saveLinkAnswers(db, restaurantId, doc.linkAnswers);
    if (doc.modifierAnswers) await saveModifierAnswers(db, restaurantId, doc.modifierAnswers);
    await checkMove(db, restaurantId, doc);
    // Nothing older to bring in: history starts here.
    if (!doc.recipeCards) await db.script(touch(restaurantId, 'history'));
    // To-dos snoozed and ideas set aside were keyed by the old ids.
    const map = await legacyIds(db, restaurantId);
    if (map.size) {
      const pairs = lit([...map].map(([from, to]) => ({ from, to })));
      await db.script(`
        UPDATE today_snoozes s SET item_key = regexp_replace(s.item_key, '(^|[^a-z0-9])' || x.from || '($|[^a-z0-9-])', '\\1' || x.to || '\\2', 'g')
          FROM jsonb_to_recordset(${pairs}) AS x("from" text, "to" text) WHERE s.restaurant_id = ${text(restaurantId)} AND s.item_key ~ ('(^|[^a-z0-9])' || x.from || '($|[^a-z0-9-])');
        UPDATE idea_dismissals d SET idea_key = regexp_replace(d.idea_key, '(^|[^a-z0-9])' || x.from || '($|[^a-z0-9-])', '\\1' || x.to || '\\2', 'g')
          FROM jsonb_to_recordset(${pairs}) AS x("from" text, "to" text) WHERE d.restaurant_id = ${text(restaurantId)} AND d.idea_key ~ ('(^|[^a-z0-9])' || x.from || '($|[^a-z0-9-])');`);
    }
    await db.script(touch(restaurantId, 'converted'));
  } catch (err) {
    await clearTables(db, restaurantId).catch(() => {});
    throw err;
  }
}

async function checkMove(db: Db, restaurantId: string, doc: Partial<KitchenBook>): Promise<void> {
  const after = await readTables(db, restaurantId);
  const products: PurchasedProduct[] = (await db.query<{ id: string; name: string; base_unit: string | null }>('SELECT id, name, base_unit FROM ingredients WHERE restaurant_id = $1 AND active ORDER BY name', [restaurantId])).rows
    .map((r) => ({ externalId: r.id, name: r.name, ...(r.base_unit ? { baseUnit: r.base_unit } : {}), conversions: {} }));
  const offList = (doc.importAnswers?.offInvoiceProducts ?? []).filter((p) => !products.some((x) => x.externalId === p.externalId));
  const before = buildRecipes(doc.recipeCards ?? [], [...products, ...offList], { ingredientProducts: doc.importAnswers?.ingredientProducts ?? {} }).recipes;
  const now = buildRecipes(after.recipeCards ?? [], products, { ingredientProducts: after.importAnswers?.ingredientProducts ?? {} }).recipes;
  const idMap = await legacyIds(db, restaurantId);
  const norm = (r: (typeof before)[number], ids?: Map<string, string>) => canonical({ ...r, id: ids?.get(r.id) ?? r.id, ingredients: r.ingredients.map((i) => ({ ...i, item: i.item.kind === 'recipe' ? { ...i.item, id: ids?.get(i.item.id) ?? i.item.id } : i.item })) });
  const want = new Map(before.map((r) => [idMap.get(r.id) ?? r.id, norm(r, idMap)]));
  const got = new Map(now.map((r) => [r.id, norm(r)]));
  const wrong = [...want].filter(([id, s]) => got.get(id) !== s).map(([id]) => id);
  if (wrong.length || want.size !== got.size) throw new Error(`recipes read differently after the move: ${wrong.slice(0, 5).join(', ')}${want.size !== got.size ? ` (${want.size} before, ${got.size} after)` : ''}`);
  const links = (doc.linkAnswers?.confirm ?? []).length, nowLinks = (after.linkAnswers?.confirm ?? []).length;
  if (links !== nowLinks) throw new Error(`dish links: ${links} before, ${nowLinks} after`);
  const mods = Object.keys(doc.modifierAnswers?.adds ?? {}).length + Object.keys(doc.modifierAnswers?.removes ?? {}).length;
  const nowMods = Object.keys(after.modifierAnswers?.adds ?? {}).length + Object.keys(after.modifierAnswers?.removes ?? {}).length;
  if (mods !== nowMods) throw new Error(`modifier answers: ${mods} before, ${nowMods} after`);
}

/**
 * Old saved copies of the recipe book (one per save, from before recipes had their own rows)
 * become versions of each recipe, so history and past periods go back to when recipes first
 * came into the app. One copy at a time, in the background.
 */
async function importHistory(db: Db, restaurantId: string): Promise<void> {
  if (await hasPart(db, restaurantId, 'history')) return;
  const first = (await db.query<{ at: string }>(`SELECT ${iso('min(saved_at)')} AS at FROM recipe_versions WHERE restaurant_id = $1 AND change = 'imported'`, [restaurantId])).rows[0]?.at;
  const copies = first ? (await db.query<{ id: string; at: string; by: string | null }>(
    `SELECT id::text AS id, ${iso('saved_at')} AS at, saved_by::text AS by FROM kitchen_book_history WHERE restaurant_id = $1 AND key = 'recipeCards' AND saved_at < $2 ORDER BY saved_at, id`, [restaurantId, first])).rows : [];
  const recipes = (await db.query<{ id: string; name: string }>('SELECT id, name FROM recipes WHERE restaurant_id = $1 ORDER BY removed_at IS NULL DESC, position', [restaurantId])).rows;
  const idOf = new Map<string, string>();
  for (const r of recipes) if (!idOf.has(keyOf(r.name))) idOf.set(keyOf(r.name), r.id);
  const products = await productNames(db, restaurantId);
  const aliases = await aliasMap(db, restaurantId);
  const names = new Map((await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM staff WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.id, r.display_name]));
  const created: { id: string; name: string; gone: string }[] = [];
  const last = new Map<string, string>(); // recipe id → content of its last version
  const lastCard = new Map<string, RecipeCard>();
  let versions: unknown[] = [];
  const flush = async () => {
    if (!versions.length && !created.length) return;
    const script = [
      created.length ? `INSERT INTO recipes (restaurant_id, id, name, removed_at) SELECT ${text(restaurantId)}, x.id, x.name, x.gone FROM jsonb_to_recordset(${lit(created)}) AS x(id uuid, name text, gone timestamptz) ON CONFLICT (id) DO NOTHING;` : '',
      versions.length ? `INSERT INTO recipe_versions (restaurant_id, recipe_id, saved_at, saved_by, saved_by_name, change, card)
        SELECT ${text(restaurantId)}, x.recipe_id, x.saved_at, x.saved_by, x.saved_by_name, x.change, x.card FROM jsonb_to_recordset(${lit(versions)}) AS x(recipe_id uuid, saved_at timestamptz, saved_by uuid, saved_by_name text, change text, card jsonb);` : '',
    ].filter(Boolean).join('\n');
    created.length = 0; versions = [];
    await db.script(script);
  };
  let present = new Set<string>();
  for (const copy of copies) {
    const value = (await db.query<{ value: unknown }>('SELECT value FROM kitchen_book_history WHERE id = $1', [copy.id])).rows[0]?.value;
    const cards = js<RecipeCard[]>(value);
    if (!Array.isArray(cards)) continue;
    const lastOf = new Map<string, RecipeCard>();
    for (const c of cards) if (c?.name) lastOf.set(keyOf(c.name), c);
    for (const k of lastOf.keys()) if (!idOf.has(k)) { const id = randomUUID(); idOf.set(k, id); created.push({ id, name: lastOf.get(k)!.name, gone: first! }); }
    const n = namesFor([...lastOf.values()].map((c) => ({ id: idOf.get(keyOf(c.name))!, name: c.name })), products, aliases);
    const now = new Set<string>();
    for (const c of lastOf.values()) {
      const id = idOf.get(keyOf(c.name))!;
      now.add(id);
      const card: RecipeCard = { ...c, id, ingredients: c.ingredients.map((l) => { const m = matchOf(match(n, l.name)); return { ...l, ...(m.sub ? { recipeId: m.sub } : {}), ...(m.ing ? { productId: m.ing } : {}) }; }) };
      const content = contentOf(card);
      if (last.get(id) === content) continue;
      versions.push({ recipe_id: id, saved_at: copy.at, saved_by: copy.by && names.has(copy.by) ? copy.by : null, saved_by_name: copy.by ? names.get(copy.by) ?? null : null, change: last.has(id) ? 'edited' : 'created', card });
      last.set(id, content);
      lastCard.set(id, card);
    }
    for (const id of present) if (!now.has(id)) { versions.push({ recipe_id: id, saved_at: copy.at, saved_by: null, saved_by_name: null, change: 'removed', card: lastCard.get(id) }); last.delete(id); }
    present = now;
    if (versions.length > 200) await flush();
  }
  await flush();
  await db.script(touch(restaurantId, 'history'));
}

/** The parts of the book and when each last changed (Settings shows these). */
export async function bookParts(db: Db, restaurantId: string): Promise<{ key: string; updated_at: string; size: number }[]> {
  if (!(await inTables(db, restaurantId))) {
    return (await db.query<{ key: string; updated_at: string; size: string }>('SELECT key, updated_at, length(value::text) AS size FROM kitchen_book WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => ({ ...r, size: Number(r.size) }));
  }
  const counts = (await db.query<{ part: string; n: string }>(
    `SELECT 'recipeCards' AS part, count(*)::text AS n FROM recipes WHERE restaurant_id = $1 AND removed_at IS NULL
     UNION ALL SELECT 'linkAnswers', ((SELECT count(*) FROM dish_links WHERE restaurant_id = $1) + (SELECT count(*) FROM dismissed_checks WHERE restaurant_id = $1) + (SELECT count(*) FROM menu_status WHERE restaurant_id = $1))::text
     UNION ALL SELECT 'importAnswers', ((SELECT count(*) FROM ingredient_answers WHERE restaurant_id = $1) + (SELECT count(*) FROM ingredient_aliases WHERE restaurant_id = $1) + (SELECT count(*) FROM confirmed_portions WHERE restaurant_id = $1))::text
     UNION ALL SELECT 'modifierAnswers', count(*)::text FROM modifier_answers WHERE restaurant_id = $1`, [restaurantId])).rows;
  const n = new Map(counts.map((c) => [c.part, Number(c.n)]));
  return (await db.query<{ part: string; updated_at: string }>("SELECT part, updated_at::text AS updated_at FROM book_state WHERE restaurant_id = $1 AND part NOT IN ('converted', 'history') ORDER BY part", [restaurantId])).rows
    .map((r) => ({ key: r.part, updated_at: r.updated_at, size: n.get(r.part) ?? 0 }));
}
