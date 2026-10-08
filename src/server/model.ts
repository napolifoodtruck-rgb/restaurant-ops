/**
 * The restaurant as the app sees it today, rebuilt from what's stored: MarginEdge's products
 * and invoices, the recipe cards, Square's catalog and daily sales, and every answer a
 * manager has given. Screens read from this; nothing here writes.
 *
 * Built on demand and cached until the next sync or saved answer.
 */

import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { ImportAnswers } from '../connectors/marginedge.ts';
import { blendedPrices, packBaseOf, type PurchasedProduct, type Purchasing } from '../core/purchasing.ts';
import { buildRecipes, cardId, FREE_PRODUCTS, type RecipeCard } from '../core/recipeCards.ts';
import { packSize, withPackSize } from '../core/packSizes.ts';
import { squareItemSales, squareMenuItems, squareModifierSales, type SquareCatalogObject } from '../connectors/square.ts';
import { applyLinks, confirmLink, emptyLinkState, linkLookup, markNewDish, matchMenu, posName, type LinkQuestion, type PosMenuItem, type SoldItem } from '../core/menuLinks.ts';
import { foldedTotals, priceFolds, type FoldedVariation } from '../core/priceVariations.ts';
import { menuMargins, type MarginReport, type MarginSaleLine } from '../core/margins.ts';
import { modifierCosts, emptyModifierAnswers, type ModifierAnswers, type ModifierCosts } from '../core/modifiers.ts';
import { RecipeBook, type Product, type Recipe } from '../core/recipes.ts';
import { entriesFromSales, menuChecks, type MenuCheck, type MenuEntry, type MenuStatusAnswer } from '../core/menu.ts';
import { sellingSpans, type LinkLookup, type SellingSpan } from '../core/sales.ts';
import { withIngredientAmount } from '../core/portionCheck.ts';
import { convert, type Quantity } from '../core/units.ts';
import { storedItemSales, storedModifierSales } from './squareSync.ts';
import { ingredientsStamp, loadIngredients } from './ingredients.ts';
import { loadStore, storeStamp, type InvoiceSource } from './invoiceStore.ts';
import { ensureMarginEdgeImported } from './meImport.ts';
import { bookStamp, loadBook, recipeCardsOn, saveBook } from './book.ts';

export { loadBook, saveBook };

// ---------------------------------------------------------------- the kitchen book

export interface PilotImportAnswers extends ImportAnswers {
  /** Products bought outside MarginEdge (salt from the store), with a price a manager gave. */
  offInvoiceProducts?: PurchasedProduct[];
  manualPrices?: Record<string, { price: number; per: Quantity; date?: string; note?: string }>;
  /** Card ingredient name → product id, when the name alone would match the wrong product. */
  ingredientProducts?: Record<string, string>;
  /** Confirmed real portions, by recipe and ingredient name. */
  portions?: { recipe: string; ingredient: string; amount: number; unit: string; source?: string; recipeId?: string; productId?: string }[];
  /** Products that go into only one dish, by name. */
  exclusive?: string[];
  partlyGrown?: { product: string; note?: string }[];
}

/** When an answer was given in the app, and by whom (answers loaded from a file have neither). */
export interface Stamp { at?: string; by?: string }
export interface LinkAnswers {
  confirm: (PosMenuItem & Stamp & { recipe: string; recipeId?: string; portion?: Quantity; from?: string; note?: string })[];
  newDish: (PosMenuItem & Stamp & { from?: string; note?: string })[];
  /** POS items confirmed as having no food cost to track (gift cards, fees, merchandise). */
  notFood?: (PosMenuItem & Stamp & { note?: string })[];
  /** Menu to-dos a manager said were false alarms, by their dedupe key. */
  dismissed?: (Stamp & { dedupeKey: string; note?: string })[];
  /** Discount buttons kept as their own item (by catalog id), and ones folded by hand. */
  priceSplit?: string[];
  priceMerge?: { catalogId: string; into: string }[];
  /** Managers' word on dishes: came off (on a day), still on, put back on. One per dish. */
  menuStatus?: (Stamp & MenuStatusAnswer & { name?: string })[];
}

/** One answer from a screen, folded into the kitchen book. */
export type Answer =
  | { type: 'link'; catalogId: string; itemName: string; variationName?: string; recipe: string; from?: string }
  | { type: 'newDish'; catalogId: string; itemName: string; variationName?: string; from?: string; note?: string }
  | { type: 'notFood'; catalogId: string; itemName: string; variationName?: string }
  | { type: 'dismiss'; dedupeKey: string; note?: string }
  /** What one unit of a product holds or weighs, so a recipe's units convert to how it's bought. */
  | { type: 'conversion'; productId: string; fact: 'gramsPerEach' | 'gramsPerMl' | 'customUnit'; unit?: string; amount: number; amountUnit: string }
  /** A price for a product the invoices don't give one for. */
  | { type: 'price'; productId: string; price: number; amount: number; unit: string };

export const PRODUCT_ANSWERS = new Set(['conversion', 'price']);

/** The product answers with one more answer folded in. Throws on units that don't make sense. */
export function withProductAnswer(current: PilotImportAnswers, a: Extract<Answer, { type: 'conversion' | 'price' }>, today: string): PilotImportAnswers {
  const next: PilotImportAnswers = { ...current, conversions: { ...(current.conversions ?? {}) }, manualPrices: { ...(current.manualPrices ?? {}) } };
  if (a.type === 'price') {
    next.manualPrices![a.productId] = { price: a.price, per: { amount: a.amount, unit: a.unit }, date: today, note: 'entered in the app' };
    return next;
  }
  const was = next.conversions![a.productId] ?? {};
  if (a.fact === 'gramsPerEach') next.conversions![a.productId] = { ...was, gramsPerEach: convert({ amount: a.amount, unit: a.amountUnit }, 'g') };
  else if (a.fact === 'gramsPerMl') {
    const ml = convert({ amount: 1, unit: a.unit ?? '' }, 'ml');
    next.conversions![a.productId] = { ...was, gramsPerMl: convert({ amount: a.amount, unit: a.amountUnit }, 'g') / ml };
  } else next.conversions![a.productId] = { ...was, customUnits: { ...(was.customUnits ?? {}), [a.unit ?? '']: { amount: a.amount, unit: a.amountUnit } } };
  return next;
}

export function answerProblem(a: any): string | undefined {
  if (!a || typeof a !== 'object') return 'Missing answer.';
  // A price of 0 is "costs nothing" (soda from the gun, herbs from the garden).
  if (a.type === 'price') return typeof a.productId === 'string' && a.price >= 0 && Number.isFinite(a.price) && a.amount > 0 && typeof a.unit === 'string' && a.unit ? undefined : 'A price needs the amount it buys, e.g. $25.99 for 25 lb.';
  if (a.type === 'conversion') {
    if (typeof a.productId !== 'string' || !['gramsPerEach', 'gramsPerMl', 'customUnit'].includes(a.fact)) return 'Unknown answer.';
    if (!(a.amount > 0) || typeof a.amountUnit !== 'string' || !a.amountUnit) return 'How much, and in what unit?';
    if (a.fact !== 'gramsPerEach' && (typeof a.unit !== 'string' || !a.unit)) return 'Missing which unit.';
    return undefined;
  }
  if (a.type === 'dismiss') return typeof a.dedupeKey === 'string' && a.dedupeKey ? undefined : 'Missing which to-do.';
  if (!['link', 'newDish', 'notFood'].includes(a.type)) return 'Unknown answer.';
  if (typeof a.catalogId !== 'string' || typeof a.itemName !== 'string' || !a.itemName) return 'Missing which item.';
  if (a.type === 'link' && (typeof a.recipe !== 'string' || !a.recipe)) return 'Missing which recipe.';
  if (a.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.from)) return 'Dates are YYYY-MM-DD.';
  return undefined;
}

/** The link answers with one more answer folded in. Later answers about the same item replace earlier ones. */
export function withAnswer(current: LinkAnswers, a: Exclude<Answer, { type: 'conversion' | 'price' }>, stamp: Stamp = {}): LinkAnswers {
  const next: LinkAnswers = { confirm: [...current.confirm], newDish: [...current.newDish], notFood: [...(current.notFood ?? [])], dismissed: [...(current.dismissed ?? [])] };
  const st = { ...(stamp.at ? { at: stamp.at } : {}), ...(stamp.by ? { by: stamp.by } : {}) };
  if (a.type === 'dismiss') {
    if (!next.dismissed!.some((d) => d.dedupeKey === a.dedupeKey)) next.dismissed!.push({ dedupeKey: a.dedupeKey, ...(a.note ? { note: a.note } : {}), ...st });
    return next;
  }
  const item = { catalogId: a.catalogId, itemName: a.itemName, ...(a.variationName ? { variationName: a.variationName } : {}), ...st };
  const same = (x: PosMenuItem & { from?: string }) => x.catalogId === a.catalogId && x.itemName === a.itemName && (x.variationName ?? '') === (a.variationName ?? '') && (x.from ?? '') === ((a as any).from ?? '');
  next.confirm = next.confirm.filter((x) => !same(x));
  next.newDish = next.newDish.filter((x) => !same(x));
  next.notFood = next.notFood!.filter((x) => !same(x));
  if (a.type === 'link') next.confirm.push({ ...item, recipe: a.recipe, ...(a.from ? { from: a.from } : {}) });
  if (a.type === 'newDish') next.newDish.push({ ...item, ...(a.from ? { from: a.from } : {}), ...(a.note ? { note: a.note } : {}) });
  if (a.type === 'notFood') next.notFood!.push(item);
  return next;
}

/** Which answer to take back: a menu to-do by its key, or a POS item (and the date it changed, for a new version). */
export type AnswerTarget = { dedupeKey: string } | { menuRecipe: string } | (PosMenuItem & { from?: string });

/** The answers with one taken back, so the question it settled asks again. */
export function withoutAnswer(current: LinkAnswers, t: AnswerTarget): LinkAnswers {
  if ('dedupeKey' in t) return { ...current, dismissed: (current.dismissed ?? []).filter((d) => d.dedupeKey !== t.dedupeKey) };
  if ('menuRecipe' in t) return { ...current, menuStatus: (current.menuStatus ?? []).filter((m) => m.recipeId !== t.menuRecipe) };
  const same = (x: PosMenuItem & { from?: string }) => x.catalogId === t.catalogId && x.itemName === t.itemName && (x.variationName ?? '') === (t.variationName ?? '') && (x.from ?? '') === (t.from ?? '');
  return { ...current, confirm: current.confirm.filter((x) => !same(x)), newDish: current.newDish.filter((x) => !same(x)), notFood: (current.notFood ?? []).filter((x) => !same(x)) };
}

export interface RecentAnswer { type: 'link' | 'newDish' | 'notFood' | 'dismiss' | 'menuOff' | 'menuOn' | 'stillOn'; target: AnswerTarget; name: string; recipe?: string; note?: string; date?: string; at?: string; by?: string }

/** Every answer, the newest first; those without a time (loaded from a file) last, latest added first. */
export function recentAnswers(links: LinkAnswers): RecentAnswer[] {
  const item = (x: PosMenuItem & { from?: string }) => ({ catalogId: x.catalogId, itemName: x.itemName, ...(x.variationName ? { variationName: x.variationName } : {}), ...(x.from ? { from: x.from } : {}) });
  const nameOf = (x: PosMenuItem) => (x.variationName && !/^regular$/i.test(x.variationName) ? `${x.itemName} (${x.variationName})` : x.itemName);
  const stamp = (x: Stamp) => ({ ...(x.at ? { at: x.at } : {}), ...(x.by ? { by: x.by } : {}) });
  const all: (RecentAnswer & { n: number })[] = [
    ...links.confirm.map((x, n) => ({ type: 'link' as const, target: item(x), name: nameOf(x), recipe: x.recipe, ...stamp(x), n })),
    ...links.newDish.map((x, n) => ({ type: 'newDish' as const, target: item(x), name: nameOf(x), ...(x.note ? { note: x.note } : {}), ...stamp(x), n })),
    ...(links.notFood ?? []).map((x, n) => ({ type: 'notFood' as const, target: item(x), name: nameOf(x), ...stamp(x), n })),
    ...(links.dismissed ?? []).map((x, n) => ({ type: 'dismiss' as const, target: { dedupeKey: x.dedupeKey }, name: x.note ?? x.dedupeKey, ...stamp(x), n })),
    ...(links.menuStatus ?? []).map((x, n) => ({ type: (x.status === 'off' ? 'menuOff' : x.status === 'on' ? 'menuOn' : 'stillOn') as RecentAnswer['type'], target: { menuRecipe: x.recipeId }, name: x.name ?? x.recipeId, date: x.date, ...stamp(x), n })),
  ];
  return all.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || b.n - a.n).map(({ n: _n, ...r }) => r);
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

// ---------------------------------------------------------------- the model

/** Where a product's price came from: the latest invoice (and how many recent ones are averaged), a price set in the app, or MarginEdge's last price. */
export type PriceSource = { from: 'invoice'; vendor?: string; date: string; invoices: number; garden?: boolean } | { from: 'manual'; date?: string } | { from: 'marginedge' } | { from: 'free'; manual?: boolean };

/** Free by nature, when nothing prices it: tap water, ice, soda water or club soda from the gun. */
export function costsNothing(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(tap |filtered |still )?water$|^ice$|^(soda water|water soda|club soda|soda club|seltzer|seltzer water|sparkling water)( gun)?$/.test(n);
}

export interface Model {
  /** Last day of the period (today, unless a past range was asked for). */
  today: string;
  from: string;
  /** First day any sales are stored for. */
  dataFrom?: string;
  missing: string[];
  book: RecipeBook;
  recipes: Recipe[];
  products: Product[];
  purchasing: Purchasing;
  menuItems: PosMenuItem[];
  lookup: LinkLookup;
  sales: MarginSaleLine[];
  linkQuestions: LinkQuestion[];
  modifiers: ModifierCosts;
  margins: MarginReport;
  spans: SellingSpan[];
  entries: MenuEntry[];
  checks: MenuCheck[];
  /** Square's photo for a sold button (item variation id), from the item it belongs to. */
  imageOf: (catalogId: string) => string | undefined;
  /** Discount buttons folded into a regular one, by the regular one's id, with what each sold in the period. */
  folded: Map<string, FoldedVariation[]>;
  /** Managers' word on what's on the menu, by recipe id (or pos:<catalog id> for buttons with no recipe). */
  menuStatus: MenuStatusAnswer[];
  /** Recipes still rough (R&D), by recipe id. */
  rough: Set<string>;
  /** Where each product's price came from. */
  priceSource: Map<string, PriceSource>;
  /** Vendor ids that are the restaurant's own garden. */
  gardenVendors: Set<string>;
  /** Where each invoice came from (photo, typed, garden, marginedge), by its id. */
  invoiceSources: Map<string, InvoiceSource>;
}

const cache = new Map<string, { stamp: string; model: Promise<Model> }>();
export function invalidate(restaurantId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${restaurantId}|`)) cache.delete(key);
}

function minusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * The model for a period: the last 90 days up to `today` by default, or `range`. Costs are
 * priced as of the period's last day, so a past month shows what its plates cost then.
 * Cached until data changes.
 */
export async function getModel(db: Db, restaurantId: string, today: string, range?: { from: string; to: string }): Promise<Model> {
  const to = range?.to ?? today;
  const from = range?.from ?? minusDays(today, 89);
  const key = `${restaurantId}|${from}|${to}`;
  const synced = (await db.query<{ stamp: string | null }>("SELECT max(finished_at)::text AS stamp FROM sync_runs WHERE restaurant_id = $1 AND status = 'ok'", [restaurantId])).rows[0]?.stamp ?? '';
  const stamp = `${synced}|${await bookStamp(db, restaurantId)}`;
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.model;
  // A handful of periods per restaurant is plenty; drop the oldest beyond that.
  const mine = [...cache.keys()].filter((k) => k.startsWith(`${restaurantId}|`));
  if (mine.length >= 8) cache.delete(mine[0]!);
  // A period that ended before today is costed with the recipes as they were on its last day.
  const model = buildModel(db, restaurantId, from, to, to < today);
  cache.set(key, { stamp, model });
  model.catch(() => cache.delete(key));
  return model;
}

/**
 * What only a sync changes: invoices read in, the POS catalog, sales and modifier rows. Kept
 * apart from the recipes, so saving a recipe (several times a minute while the chef writes)
 * rebuilds only the part the recipes touch, not the invoices and sales underneath.
 */
interface Base {
  /** Ingredients, vendors, invoices and prices, from the app's own tables. */
  purchasing: Purchasing;
  /** Vendor keys that are the restaurant's own garden. */
  garden: Set<string>;
  /** Where each invoice came from, by its id. */
  sources: Map<string, InvoiceSource>;
  menuItems: PosMenuItem[];
  images: Map<string, string>;
  rawRows: Awaited<ReturnType<typeof storedItemSales>>;
  modRows: Awaited<ReturnType<typeof storedModifierSales>>;
  dataFrom?: string;
}
const baseCache = new Map<string, { stamp: string; base: Promise<Base> }>();

async function getBase(db: Db, restaurantId: string, from: string, today: string, answers: PilotImportAnswers): Promise<Base> {
  const key = `${restaurantId}|${from}|${today}`;
  // While MarginEdge runs, whatever it brought since last time goes into the app's tables first.
  await ensureMarginEdgeImported(db, restaurantId, answers);
  const synced = (await db.query<{ stamp: string | null }>(
    "SELECT max(finished_at)::text AS stamp FROM sync_runs WHERE restaurant_id = $1 AND status = 'ok'", [restaurantId])).rows[0]?.stamp ?? '';
  // Import answers (which invoice line is which product) change how invoices read, so they're part of the stamp.
  const stamp = `${synced}|${await storeStamp(db, restaurantId)}|${await ingredientsStamp(db, restaurantId)}|${createHash('sha1').update(JSON.stringify(answers)).digest('hex')}`;
  const hit = baseCache.get(key);
  if (hit && hit.stamp === stamp) return hit.base;
  const mine = [...baseCache.keys()].filter((k) => k.startsWith(`${restaurantId}|`));
  if (mine.length >= 8) baseCache.delete(mine[0]!);
  const base = buildBase(db, restaurantId, from, today, answers);
  baseCache.set(key, { stamp, base });
  base.catch(() => baseCache.delete(key));
  return base;
}

async function buildBase(db: Db, restaurantId: string, from: string, today: string, answers: PilotImportAnswers): Promise<Base> {
  // The app's own ingredient list and invoices, whatever brought them in.
  const products = await loadIngredients(db, restaurantId, answers.conversions ?? {});
  const store = await loadStore(db, restaurantId, products);
  const purchasing: Purchasing = { vendors: store.vendors, products, invoices: store.invoices, prices: store.prices };
  const catalogRows = (await db.query<{ data: any }>('SELECT data FROM pos_catalog WHERE restaurant_id = $1', [restaurantId])).rows;
  const catalog: SquareCatalogObject[] = catalogRows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  const categoryNames = Object.fromEntries(catalog.filter((o: any) => o.type === 'CATEGORY').map((o: any) => [o.id, o.category_data?.name ?? o.id]));
  const menuItems = squareMenuItems(catalog, categoryNames);
  // Photos: an item's first image, for the item and each of its variations (a variation's own image first).
  const imageUrls = new Map(catalog.filter((o: any) => o.type === 'IMAGE' && o.image_data?.url).map((o: any) => [o.id, o.image_data.url as string]));
  const images = new Map<string, string>();
  for (const o of catalog as any[]) {
    if (o.type !== 'ITEM') continue;
    const itemImage = (o.item_data?.image_ids ?? []).map((id: string) => imageUrls.get(id)).find(Boolean);
    if (itemImage) images.set(o.id, itemImage);
    for (const v of o.item_data?.variations ?? []) {
      const own = (v.item_variation_data?.image_ids ?? []).map((id: string) => imageUrls.get(id)).find(Boolean);
      if (own ?? itemImage) images.set(v.id, own ?? itemImage);
    }
  }
  const rawRows = await storedItemSales(db, restaurantId, from, today);
  const modRows = await storedModifierSales(db, restaurantId, from, today);
  const dataFrom = (await db.query<{ day: string | null }>('SELECT min(day)::text AS day FROM pos_item_sales_daily WHERE restaurant_id = $1', [restaurantId])).rows[0]?.day ?? undefined;
  return { purchasing, garden: store.garden, sources: store.sources, menuItems, images, rawRows, modRows, ...(dataFrom ? { dataFrom } : {}) };
}

async function buildModel(db: Db, restaurantId: string, from: string, today: string, past = false): Promise<Model> {
  const missing: string[] = [];
  const bookData = await loadBook(db, restaurantId);
  const cards = (past ? await recipeCardsOn(db, restaurantId, today) : undefined) ?? bookData.recipeCards ?? [];
  const answers: PilotImportAnswers = bookData.importAnswers ?? {};
  const base = await getBase(db, restaurantId, from, today, answers);
  const { purchasing, menuItems, images, rawRows, modRows, dataFrom } = base;
  // No ingredients yet: nothing to cost with (named for the source most restaurants start from).
  if (!purchasing.products.length) missing.push('marginedge');
  if (!cards.length) missing.push('recipeCards');

  // Products and recipes.
  // Ingredients from an earlier answer are on the list now; kept here too in case one isn't yet.
  const listed = new Set(purchasing.products.map((p) => p.externalId));
  const allProducts = [...purchasing.products, ...(answers.offInvoiceProducts ?? []).filter((p) => !listed.has(p.externalId))];
  let recipes = buildRecipes(cards, allProducts, { ingredientProducts: answers.ingredientProducts ?? {} }).recipes;
  for (const p of answers.portions ?? []) {
    const recipe = (p.recipeId ? recipes.find((r) => r.id === p.recipeId) : undefined) ?? recipes.find((r) => r.name === p.recipe);
    const product = (p.productId ? allProducts.find((x) => x.externalId === p.productId) : undefined) ?? allProducts.find((x) => x.name === p.ingredient);
    if (recipe && product) recipes = withIngredientAmount(recipes, recipe.id, { kind: 'product', id: product.externalId }, { amount: p.amount, unit: p.unit });
  }
  const blended = blendedPrices(purchasing.prices, today);
  // Where a price comes from: recent invoices first, then one entered in the app, then MarginEdge's
  // own last price (a product bought before the invoices we read, like a case of San Pellegrino).
  // Kept per product so a recipe line can show it: the vendor and date catch a wrong price early.
  const priceSource = new Map<string, PriceSource>();
  const vendorName = new Map(purchasing.vendors.map((v) => [v.externalId, v.name]));
  const since = minusDays(today, 60); // blendedPrices' window: invoices after this day are averaged
  const lastPoint = new Map<string, (typeof purchasing.prices)[number]>();
  const recentInvoices = new Map<string, Set<string>>();
  for (const pt of purchasing.prices) {
    const day = pt.date.slice(0, 10);
    if (day > today) continue;
    const cur = lastPoint.get(pt.productExternalId);
    if (!cur || pt.date >= cur.date) lastPoint.set(pt.productExternalId, pt);
    if (day > since && packBaseOf(pt) > 0) recentInvoices.set(pt.productExternalId, (recentInvoices.get(pt.productExternalId) ?? new Set()).add(pt.invoiceExternalId));
  }
  const products: Product[] = [...allProducts, ...FREE_PRODUCTS].filter((p) => p.baseUnit).map((p) => {
    let price = blended.get(p.externalId);
    const last = lastPoint.get(p.externalId);
    if (price !== undefined && last) {
      const vendor = last.vendorExternalId ? vendorName.get(last.vendorExternalId) : undefined;
      priceSource.set(p.externalId, { from: 'invoice', ...(vendor ? { vendor } : {}), date: last.date.slice(0, 10), invoices: recentInvoices.get(p.externalId)?.size || 1, ...(last.vendorExternalId && base.garden.has(last.vendorExternalId) ? { garden: true } : {}) });
    }
    const manual = answers.manualPrices?.[p.externalId];
    if (price === undefined && manual) {
      try {
        price = manual.price / convert(manual.per, p.baseUnit!, p.conversions);
        priceSource.set(p.externalId, manual.price === 0 ? { from: 'free', manual: true } : { from: 'manual', ...(manual.date ? { date: manual.date } : {}) });
      } catch {}
    }
    // Water, ice and soda water from the gun cost nothing, unless an invoice says otherwise.
    if (price === undefined && costsNothing(p.name)) { price = 0; priceSource.set(p.externalId, { from: 'free' }); }
    const reference = (p as { referencePrice?: number }).referencePrice;
    if (price === undefined && reference && reference > 0) { price = reference; priceSource.set(p.externalId, { from: 'marginedge' }); }
    // Drinks bought by the each or bottle: what one holds, assumed from its name or type when unknown.
    const conversions = withPackSize(p.conversions, p.baseUnit!, packSize(p.name, (p as { categoryType?: string }).categoryType, p.baseUnit!));
    return {
      id: p.externalId,
      name: p.name,
      baseUnit: p.baseUnit!,
      conversions,
      ...(p.externalId.startsWith('free-') ? { cost: { price: 0, per: { amount: 1, unit: p.baseUnit! } } } : price !== undefined ? { cost: { price, per: { amount: 1, unit: p.baseUnit! } } } : {}),
    };
  });
  const book = new RecipeBook(products, recipes);

  const imageOf = (catalogId: string) => images.get(catalogId);
  // Discount buttons (Tuesday $10, half-price Wednesday) fold into the drink they discount.
  const saleOf = (r: (typeof rawRows)[number]) => ({ catalogId: String(r['ItemSales.item_variation_id'] ?? ''), itemName: String(r['ItemSales.item_name'] ?? ''), ...(r['ItemSales.item_variation_name'] ? { variationName: String(r['ItemSales.item_variation_name']) } : {}) });
  const fold = priceFolds(menuItems, bookData.linkAnswers ?? {}, rawRows.map(saleOf).filter((x) => x.catalogId));
  const manualFolds = new Set((bookData.linkAnswers?.priceMerge ?? []).map((m) => m.catalogId));
  const foldedSales: Parameters<typeof foldedTotals>[0] = [];
  const itemRows = rawRows.map((r) => {
    const sale = saleOf(r);
    const into = sale.catalogId ? fold(sale) : undefined;
    if (!into) return r;
    foldedSales.push({ into: into.catalogId, ...sale, quantity: Number(r['ItemSales.items_sold_count'] ?? 0), netSales: Number(r['ItemSales.item_net_sales'] ?? 0), ...(manualFolds.has(sale.catalogId) ? { manual: true } : {}) });
    // Marked, so Performance can show full-price and specials sales apart.
    return { ...r, 'ItemSales.item_variation_id': into.catalogId, 'ItemSales.item_name': into.itemName, 'ItemSales.item_variation_name': into.variationName ?? null, special: 1 };
  });
  const folded = foldedTotals(foldedSales);
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
    const recipe = (a.recipeId ? recipes.find((x) => x.id === a.recipeId) : undefined) ?? recipes.find((x) => x.name === a.recipe);
    if (recipe) state = confirmLink(state, a, recipe.id, a.portion, a.from);
  }
  state = applyLinks(state, matchMenu(soldItems, recipes, state).newLinks);
  for (const a of linkAnswers.newDish) state = markNewDish(state, a, a.from);
  for (const a of linkAnswers.notFood ?? []) state = confirmLink(state, a, null);
  const lookup = linkLookup(state);
  const linkQuestions = matchMenu(soldItems, recipes, state).questions;

  // Modifiers, margins, menu.
  const modifiers = modifierCosts(book, squareModifierSales(modRows), (id, name, date) => lookup(id, name, date)?.recipeId, bookData.modifierAnswers ?? emptyModifierAnswers());
  const margins = menuMargins(book, lookup, sales, { modifierCosts: modifiers.byItem });
  // Buttons answered "not food" (a fee, a gift card) aren't waiting on a card.
  const notFoodNames = new Set((linkAnswers.notFood ?? []).map((x) => posName(x)));
  margins.unlinked = margins.unlinked.filter((u) => !notFoodNames.has(u.name));
  const recipeName = (id: string) => book.recipes.get(id)?.name ?? id;
  const spans = sellingSpans(sales);
  // What's on the menu: from what sold, but a dish only comes off when a manager says so, or
  // when a planned dish replaces it; a quiet one stays on and is asked about.
  const sellingDays = new Map<string, string[]>();
  for (const l of sales) {
    if (!l.date || l.quantity <= 0) continue;
    const id = lookup(l.catalogId, l.name, l.date)?.recipeId;
    if (id) sellingDays.set(id, [...(sellingDays.get(id) ?? []), l.date]);
  }
  const replacedFrom = new Map<string, string>();
  const plans = (await db.query<{ replaces: string; starts_on: string }>("SELECT replaces, starts_on::text AS starts_on FROM menu_plans WHERE restaurant_id = $1 AND status <> 'cancelled' AND replaces IS NOT NULL AND starts_on <= $2", [restaurantId, today])).rows;
  for (const p of plans) {
    const key = p.replaces.trim().toLowerCase();
    const id = margins.dishes.find((d) => d.name.toLowerCase() === key)?.recipeId ?? recipes.find((r) => r.name.toLowerCase() === key)?.id;
    if (id && (!replacedFrom.has(id) || p.starts_on < replacedFrom.get(id)!)) replacedFrom.set(id, p.starts_on);
  }
  const entries = entriesFromSales(spans, lookup, recipeName, 'dinner', today, { sellingDays, answers: linkAnswers.menuStatus ?? [], replacedFrom });
  const modifierLines = modRows.map((r) => ({
    catalogId: String(r['ItemSales.item_variation_id'] ?? ''),
    modifierName: String(r['ItemSales.modifier_name'] ?? ''),
    ...(r['ItemSales.modifier_list_name'] ? { listName: String(r['ItemSales.modifier_list_name']) } : {}),
    date: String(r['ItemSales.reporting_day.day']).slice(0, 10),
    quantity: Number(r['ItemSales.modifier_net_quantity'] ?? 0),
  }));
  // To-dos already answered: dismissed ones (a key also covers its dated variants), and new
  // buttons already marked as new dishes awaiting a card.
  const dismissed = (linkAnswers.dismissed ?? []).map((d) => d.dedupeKey);
  const awaiting = new Set(linkAnswers.newDish.map((d) => d.catalogId));
  const checks = menuChecks({ entries, sales, modifiers: modifierLines, lookup, recipeName, today, statusAware: true })
    // Entries are rebuilt from sales each time, so a quiet dish is keyed by its recipe.
    .map((c) => (c.kind === 'notSelling' && c.recipeId ? { ...c, dedupeKey: `menu:quiet:${c.recipeId}` } : c))
    .filter((c) => c.kind === 'notSelling' || !dismissed.some((d) => c.dedupeKey === d || c.dedupeKey.startsWith(`${d}:`)))
    .filter((c) => !(c.kind === 'newButton' && c.catalogId && awaiting.has(c.catalogId)))
    // A dish change already answered: a version on that button starts within a week of the suggested day.
    .filter((c) => !(c.kind === 'dishChanged' && c.catalogId && c.suggestedDate && [...linkAnswers.confirm, ...linkAnswers.newDish].some((v) => v.catalogId === c.catalogId && v.from && Math.abs(Date.parse(v.from) - Date.parse(c.suggestedDate!)) <= 7 * 86_400_000)));

  return { today, from, ...(dataFrom ? { dataFrom } : {}), missing, book, recipes, products, purchasing, menuItems, lookup, sales, linkQuestions, modifiers, margins, spans, entries, checks, imageOf, folded, menuStatus: linkAnswers.menuStatus ?? [], rough: new Set(cards.filter((c) => c.status === 'rough').map(cardId)), priceSource, gardenVendors: base.garden, invoiceSources: base.sources };
}
