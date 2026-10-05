/**
 * The restaurant as the app sees it today, rebuilt from what's stored: MarginEdge's products
 * and invoices, the recipe cards, Square's catalog and daily sales, and every answer a
 * manager has given. Screens read from this; nothing here writes.
 *
 * Built on demand and cached until the next sync or saved answer.
 */

import type { Db } from './db.ts';
import { blendedPrices, importMarginEdge, type ImportAnswers, type ImportedProduct, type ImportResult } from '../connectors/marginedge.ts';
import { buildRecipes, FREE_PRODUCTS, type RecipeCard } from '../connectors/marginedgeRecipes.ts';
import { squareItemSales, squareMenuItems, squareModifierSales, type SquareCatalogObject } from '../connectors/square.ts';
import { applyLinks, confirmLink, emptyLinkState, linkLookup, markNewDish, matchMenu, type LinkQuestion, type PosMenuItem, type SoldItem } from '../core/menuLinks.ts';
import { menuMargins, type MarginReport, type MarginSaleLine } from '../core/margins.ts';
import { modifierCosts, emptyModifierAnswers, type ModifierAnswers, type ModifierCosts } from '../core/modifiers.ts';
import { RecipeBook, type Product, type Recipe } from '../core/recipes.ts';
import { entriesFromSales, menuChecks, type MenuCheck, type MenuEntry } from '../core/menu.ts';
import { sellingSpans, type LinkLookup, type SellingSpan } from '../core/sales.ts';
import { withIngredientAmount } from '../core/portionCheck.ts';
import { convert, type Quantity } from '../core/units.ts';
import { storedItemSales, storedModifierSales } from './squareSync.ts';
import { storedMarginEdge } from './marginedgeSync.ts';

// ---------------------------------------------------------------- the kitchen book

export interface PilotImportAnswers extends ImportAnswers {
  /** Products bought outside MarginEdge (salt from the store), with a price a manager gave. */
  offInvoiceProducts?: ImportedProduct[];
  manualPrices?: Record<string, { price: number; per: Quantity; date?: string; note?: string }>;
  /** Card ingredient name → product id, when the name alone would match the wrong product. */
  ingredientProducts?: Record<string, string>;
  /** Confirmed real portions, by recipe and ingredient name. */
  portions?: { recipe: string; ingredient: string; amount: number; unit: string; source?: string }[];
  /** Products that go into only one dish, by name. */
  exclusive?: string[];
  partlyGrown?: { product: string; note?: string }[];
}

export interface LinkAnswers {
  confirm: (PosMenuItem & { recipe: string; portion?: Quantity; from?: string; note?: string })[];
  newDish: (PosMenuItem & { from?: string; note?: string })[];
  /** Menu to-dos a manager said were false alarms, by their dedupe key. */
  dismissed?: { dedupeKey: string; note?: string }[];
}

export interface KitchenBook {
  recipeCards: RecipeCard[];
  importAnswers: PilotImportAnswers;
  linkAnswers: LinkAnswers;
  modifierAnswers: ModifierAnswers;
}

export const BOOK_KEYS = ['recipeCards', 'importAnswers', 'linkAnswers', 'modifierAnswers'] as const;
export type BookKey = (typeof BOOK_KEYS)[number];

export function bookProblem(key: BookKey, value: unknown): string | undefined {
  const obj = value as any;
  if (key === 'recipeCards') {
    const ok = Array.isArray(obj) && obj.every((c) => typeof c?.name === 'string' && Array.isArray(c?.ingredients) && Array.isArray(c?.yields) && Array.isArray(c?.unreadLines));
    return ok ? undefined : 'recipeCards must be a list of cards, each with a name, yields, ingredients and unreadLines.';
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return `${key} must be an object.`;
  if (key === 'linkAnswers' && !(Array.isArray(obj.confirm) && Array.isArray(obj.newDish))) return 'linkAnswers needs confirm and newDish lists.';
  if (key === 'modifierAnswers' && !(obj.adds && obj.removes)) return 'modifierAnswers needs adds and removes.';
  return undefined;
}

export async function loadBook(db: Db, restaurantId: string): Promise<Partial<KitchenBook>> {
  const { rows } = await db.query<{ key: BookKey; value: any }>('SELECT key, value FROM kitchen_book WHERE restaurant_id = $1', [restaurantId]);
  const out: Partial<KitchenBook> = {};
  for (const r of rows) (out as any)[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
  return out;
}

export async function saveBook(db: Db, restaurantId: string, key: BookKey, value: unknown, staffId?: string): Promise<void> {
  const json = JSON.stringify(value);
  await db.query('INSERT INTO kitchen_book_history (restaurant_id, key, value, saved_by) VALUES ($1, $2, $3, $4)', [restaurantId, key, json, staffId ?? null]);
  await db.query(
    `INSERT INTO kitchen_book (restaurant_id, key, value, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (restaurant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [restaurantId, key, json, staffId ?? null],
  );
  invalidate(restaurantId);
}

// ---------------------------------------------------------------- the model

export interface Model {
  today: string;
  from: string;
  missing: string[];
  book: RecipeBook;
  recipes: Recipe[];
  products: Product[];
  imported: ImportResult;
  menuItems: PosMenuItem[];
  lookup: LinkLookup;
  sales: MarginSaleLine[];
  linkQuestions: LinkQuestion[];
  modifiers: ModifierCosts;
  margins: MarginReport;
  spans: SellingSpan[];
  entries: MenuEntry[];
  checks: MenuCheck[];
}

const cache = new Map<string, { stamp: string; model: Promise<Model> }>();
export function invalidate(restaurantId: string): void {
  cache.delete(restaurantId);
}

function minusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The model over the last `days` days up to `today`, cached until data changes. */
export async function getModel(db: Db, restaurantId: string, today: string, days = 90): Promise<Model> {
  const stamp = (await db.query<{ stamp: string }>(
    `SELECT concat_ws('|', $2::text, $3::text,
       (SELECT max(finished_at)::text FROM sync_runs WHERE restaurant_id = $1 AND status = 'ok'),
       (SELECT max(updated_at)::text FROM kitchen_book WHERE restaurant_id = $1)) AS stamp`,
    [restaurantId, today, days],
  )).rows[0]!.stamp;
  const hit = cache.get(restaurantId);
  if (hit && hit.stamp === stamp) return hit.model;
  const model = buildModel(db, restaurantId, today, days);
  cache.set(restaurantId, { stamp, model });
  model.catch(() => cache.delete(restaurantId));
  return model;
}

async function buildModel(db: Db, restaurantId: string, today: string, days: number): Promise<Model> {
  const from = minusDays(today, days - 1);
  const missing: string[] = [];
  const bookData = await loadBook(db, restaurantId);
  const me = await storedMarginEdge(db, restaurantId);
  if (!me) missing.push('marginedge');
  if (!bookData.recipeCards?.length) missing.push('recipeCards');
  const answers: PilotImportAnswers = bookData.importAnswers ?? {};
  const imported = me ? importMarginEdge(me, answers) : { vendors: [], products: [], invoices: [], prices: [], flags: [] };

  // Products and recipes.
  const allProducts = [...imported.products, ...(answers.offInvoiceProducts ?? [])];
  let recipes = buildRecipes(bookData.recipeCards ?? [], allProducts, { ingredientProducts: answers.ingredientProducts ?? {} }).recipes;
  for (const p of answers.portions ?? []) {
    const recipe = recipes.find((r) => r.name === p.recipe);
    const product = allProducts.find((x) => x.name === p.ingredient);
    if (recipe && product) recipes = withIngredientAmount(recipes, recipe.id, { kind: 'product', id: product.externalId }, { amount: p.amount, unit: p.unit });
  }
  const blended = blendedPrices(imported.prices, today);
  const products: Product[] = [...allProducts, ...FREE_PRODUCTS].filter((p) => p.baseUnit).map((p) => {
    let price = blended.get(p.externalId);
    const manual = answers.manualPrices?.[p.externalId];
    if (price === undefined && manual) {
      try { price = manual.price / convert(manual.per, p.baseUnit!, p.conversions); } catch {}
    }
    return {
      id: p.externalId,
      name: p.name,
      baseUnit: p.baseUnit!,
      conversions: p.conversions,
      ...(p.externalId.startsWith('free-') ? { cost: { price: 0, per: { amount: 1, unit: p.baseUnit! } } } : price !== undefined ? { cost: { price, per: { amount: 1, unit: p.baseUnit! } } } : {}),
    };
  });
  const book = new RecipeBook(products, recipes);

  // Square: catalog and sales.
  const catalogRows = (await db.query<{ data: any }>('SELECT data FROM pos_catalog WHERE restaurant_id = $1', [restaurantId])).rows;
  const catalog: SquareCatalogObject[] = catalogRows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  const categoryNames = Object.fromEntries(catalog.filter((o: any) => o.type === 'CATEGORY').map((o: any) => [o.id, o.category_data?.name ?? o.id]));
  const menuItems = squareMenuItems(catalog, categoryNames);
  const itemRows = await storedItemSales(db, restaurantId, from, today);
  if (!itemRows.length) missing.push('square');
  const sales = squareItemSales(itemRows, menuItems);

  // Links: confirmed answers, then exact-name matches, then new dishes awaiting cards.
  const sold = new Map<string, SoldItem>();
  for (const r of itemRows) {
    const catalogId = String(r['ItemSales.item_variation_id'] ?? '');
    if (!catalogId) continue;
    const itemName = String(r['ItemSales.item_name'] ?? '');
    const variationName = r['ItemSales.item_variation_name'] ? String(r['ItemSales.item_variation_name']) : undefined;
    const key = `${catalogId}|${itemName}|${variationName ?? ''}`;
    const s = sold.get(key) ?? { catalogId, itemName, ...(variationName ? { variationName } : {}), ...(r['ItemSales.category_name'] ? { category: String(r['ItemSales.category_name']) } : {}), quantity: 0, netSales: 0 };
    s.quantity! += Number(r['ItemSales.items_sold_count'] ?? 0);
    s.netSales! += Number(r['ItemSales.item_net_sales'] ?? 0);
    sold.set(key, s);
  }
  const soldItems = [...sold.values()];
  const linkAnswers = bookData.linkAnswers ?? { confirm: [], newDish: [] };
  let state = emptyLinkState();
  for (const a of linkAnswers.confirm) {
    const recipe = recipes.find((x) => x.name === a.recipe);
    if (recipe) state = confirmLink(state, a, recipe.id, a.portion, a.from);
  }
  state = applyLinks(state, matchMenu(soldItems, recipes, state).newLinks);
  for (const a of linkAnswers.newDish) state = markNewDish(state, a, a.from);
  const lookup = linkLookup(state);
  const linkQuestions = matchMenu(soldItems, recipes, state).questions;

  // Modifiers, margins, menu.
  const modRows = await storedModifierSales(db, restaurantId, from, today);
  const modifiers = modifierCosts(book, squareModifierSales(modRows), (id, name, date) => lookup(id, name, date)?.recipeId, bookData.modifierAnswers ?? emptyModifierAnswers());
  const margins = menuMargins(book, lookup, sales, { modifierCosts: modifiers.byItem });
  const recipeName = (id: string) => book.recipes.get(id)?.name ?? id;
  const spans = sellingSpans(sales);
  const entries = entriesFromSales(spans, lookup, recipeName, 'dinner', today);
  const modifierLines = modRows.map((r) => ({
    catalogId: String(r['ItemSales.item_variation_id'] ?? ''),
    modifierName: String(r['ItemSales.modifier_name'] ?? ''),
    ...(r['ItemSales.modifier_list_name'] ? { listName: String(r['ItemSales.modifier_list_name']) } : {}),
    date: String(r['ItemSales.reporting_day.day']).slice(0, 10),
    quantity: Number(r['ItemSales.modifier_net_quantity'] ?? 0),
  }));
  const dismissed = new Set((linkAnswers.dismissed ?? []).map((d) => d.dedupeKey));
  const checks = menuChecks({ entries, sales, modifiers: modifierLines, lookup, recipeName, today }).filter((c) => !dismissed.has(c.dedupeKey));

  return { today, from, missing, book, recipes, products, imported, menuItems, lookup, sales, linkQuestions, modifiers, margins, spans, entries, checks };
}
