/**
 * Recipe cards, written and changed in the app: dishes, drinks and the preps they use. A card
 * lists what goes in by the names of products on invoices (or other cards), so it's costed from
 * what was actually paid, and it's linked to the POS buttons that sell it.
 *
 *   GET  /api/cards?area=kitchen|bar        cards on that side, costed, with what they're linked to
 *   POST /api/cards/preview                 { card }: what it would cost, line by line
 *   POST /api/cards                         { card, previousName?, link?: [posItem], unlink?: [posItem], changedFromToday? }
 *   POST /api/cards/batch                   { cards: [{ card, link }] } (a group of drafts at once)
 *   POST /api/cards/delete                  { name }
 *   POST /api/cards/merge                   { from, into }: two recipes for one dish become the second
 *   POST /api/cards/no-card                 { items: [posItem] }: a fee or not a drink (corkage)
 *   GET  /api/cards/drafts?winePour=&draftPour=   bar drafts for drinks with no card yet
 *   GET  /api/cards/history?id=             a recipe's versions, newest first (who, when, what changed)
 *   GET  /api/cards/version?id=             one version as it read
 *   POST /api/cards/restore                 { version }: put that version back (a new version itself)
 *
 * Cards live in the recipe tables (book.ts); every save is kept as a dated version. Managers and up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, loadBook, saveBook, withAnswer, type LinkAnswers, type Model, type PilotImportAnswers } from './model.ts';
import { loadAreas, type AreaOf } from './areas.ts';
import { posItemOf } from './views.ts';
import { cardId, sameDishName, normalizeName as cardKey, yieldsToConversions, type RecipeCard } from '../core/recipeCards.ts';
import { tryConvert } from '../core/units.ts';
import { posName, type PosMenuItem } from '../core/menuLinks.ts';
import { draftDrinkCards, type BarItem } from '../core/drinkCards.ts';
import { recipeChecks } from './recipeChecks.ts';
import { recipeVersion, recipeVersions, restoreRecipeVersion } from './book.ts';

export type CardKind = 'dish' | 'drink' | 'prep' | 'barPrep';
export interface CardInput {
  name: string;
  kind: CardKind;
  yields?: { amount: number; unit: string }[];
  ingredients: { amount: number; unit: string; name: string; yieldPercent?: number; note?: string }[];
  method?: string;
  /** Mark it ready (cooks see it): only when every line is finished. */
  ready?: boolean;
}

const isPrepCard = (c: RecipeCard) => /^prep/i.test(c.recipeType ?? '') || (!!c.category && !/menu/i.test(c.category));
export function kindOf(c: RecipeCard): CardKind {
  if (isPrepCard(c)) return /bar/i.test(c.recipeType ?? '') ? 'barPrep' : 'prep';
  return /^drink/i.test(c.recipeType ?? '') ? 'drink' : 'dish';
}

const UNITS = ['each', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal', 'dash'];

/** The units an amount of this product (or card) can be given in. */
export function unitsFor(base: string, conversions: any): string[] {
  const custom = Object.keys(conversions?.customUnits ?? {});
  return [...new Set([base, ...custom, ...UNITS])].filter((u) => u === base || tryConvert({ amount: 1, unit: u }, base, conversions) !== undefined);
}

/** The units a card can be used in: every way it says what it makes, and everything those convert to. */
export function cardUnits(yields: { amount: number; unit: string }[]) {
  const { primary, conversions } = yieldsToConversions(yields.length ? yields : [{ amount: 1, unit: 'each' }]);
  const base = primary?.unit ?? 'each';
  const own = yields.map((y) => y.unit).filter((u) => tryConvert({ amount: 1, unit: u }, base, conversions) !== undefined);
  return { unit: base, units: [...new Set([...own, ...unitsFor(base, conversions)])] };
}

/**
 * Where a line stands: finished, or what it still needs. Unmatched: not a product or recipe yet.
 * Convert: its unit doesn't turn into how that product is bought (a handful of arugula, until set).
 */
export type LineState = 'ok' | 'name' | 'unmatched' | 'amount' | 'unit' | 'convert';

// Name lookups, built once per model (or list of cards) instead of a scan of every product for
// every recipe line: hundreds of products times hundreds of lines added up to seconds on a small server.
const byKeyMemo = new WeakMap<object, Map<string, any>>();
function byKey<T extends { name: string }>(list: T[], key: string): T | undefined {
  let m = byKeyMemo.get(list);
  if (!m) {
    m = new Map();
    for (const x of list) { const k = cardKey(x.name); if (!m.has(k)) m.set(k, x); }
    byKeyMemo.set(list, m);
  }
  return m.get(key);
}
export const productNamed = (model: Model, name: string) => byKey(model.products, cardKey(name));
export const cardNamed = (cards: RecipeCard[], name: string) => byKey(cards, cardKey(name));

export function lineState(i: { amount?: number | string; unit?: string; name?: string }, model: Model, cards: RecipeCard[]): LineState {
  const name = typeof i.name === 'string' ? i.name.trim() : '';
  if (!name) return 'name';
  const key = cardKey(name);
  const product = byKey(model.products, key);
  const card = byKey(cards, key);
  if (!product && !card) return 'unmatched';
  if (!(Number(i.amount) > 0)) return 'amount';
  if (typeof i.unit !== 'string' || !i.unit) return 'unit';
  if (product) return tryConvert({ amount: 1, unit: i.unit }, product.baseUnit, product.conversions) === undefined ? 'convert' : 'ok';
  const units = cardUnits(card!.yields).units;
  return units.includes(i.unit) ? 'ok' : 'convert';
}

function toStored(c: CardInput, before?: RecipeCard, ready?: boolean, by?: string): RecipeCard {
  const prep = c.kind === 'prep' || c.kind === 'barPrep';
  const yields = prep ? (c.yields ?? []).filter((y) => y.amount > 0 && y.unit) : [{ amount: 1, unit: 'each' }];
  return {
    ...(before?.id ? { id: before.id } : {}),
    name: c.name.trim(),
    category: prep ? 'Prep' : 'Menu items',
    // A dish keeps the type it had (Pizza, Appetizers); the others are named for what they are.
    recipeType: c.kind === 'drink' ? 'Drink' : c.kind === 'barPrep' ? 'Prep (bar)' : c.kind === 'prep' ? 'Prep' : before && kindOf(before) === 'dish' ? before.recipeType : 'Dish',
    yields,
    ingredients: c.ingredients.map((i) => ({ amount: Number(i.amount) > 0 ? Number(i.amount) : 0, unit: typeof i.unit === 'string' ? i.unit : '', name: i.name.trim(), yieldPercent: i.yieldPercent && i.yieldPercent > 0 && i.yieldPercent <= 100 ? i.yieldPercent : 100, ...(i.note ? { note: i.note } : {}) })),
    ...(c.method?.trim() ? { method: c.method.trim() } : {}),
    unreadLines: before?.unreadLines ?? [],
    layout: 'card',
    ...(before?.shelfLifeDays ? { shelfLifeDays: before.shelfLifeDays } : {}),
    ...(ready ? {} : { status: 'rough' as const }),
    ...(by ? { updatedAt: new Date().toISOString(), updatedBy: by } : before?.updatedAt ? { updatedAt: before.updatedAt, ...(before.updatedBy ? { updatedBy: before.updatedBy } : {}) } : {}),
  };
}

/** What's wrong with a card, and the ingredient line it's on (counted in the lines sent), if it's one line. */
type CardProblem = { message: string; line?: number; field?: 'amount' | 'unit' | 'name' };
function cardProblem(c: any, model: Model, cards: RecipeCard[], previousName?: string, strict = true): CardProblem | undefined {
  const p = (message: string, line?: number, field?: CardProblem['field']): CardProblem => ({ message, ...(line !== undefined ? { line } : {}), ...(field ? { field } : {}) });
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return p('Name the recipe.');
  if (!['dish', 'drink', 'prep', 'barPrep'].includes(c.kind)) return p('Is it a dish, a drink or a prep?');
  if (!Array.isArray(c.ingredients)) return p('Missing ingredients.');
  const key = cardKey(c.name);
  if (cards.some((x) => cardKey(x.name) === key && (!previousName || cardKey(previousName) !== key))) return p(`There's already a recipe called ${c.name.trim()}. Pick another name, or open that one to change it.`);
  if (strict && (c.kind === 'prep' || c.kind === 'barPrep') && !(Array.isArray(c.yields) && c.yields.some((y: any) => y?.amount > 0 && y?.unit))) return p('Say what a batch makes (e.g. 2 qt) before it’s ready.');
  const products = new Set(model.products.map((p) => cardKey(p.name)));
  const cardNames = new Set(cards.filter((x) => !previousName || cardKey(x.name) !== cardKey(previousName)).map((x) => cardKey(x.name)));
  // Rough: anything goes but a line with nothing that goes in, and a recipe using itself.
  if (!strict) {
    for (const [n, i] of (c.ingredients as any[]).entries()) {
      if (typeof i?.name !== 'string' || !i.name.trim()) return p(`Line ${n + 1} has an amount but nothing that goes in. Fill it in or remove the line.`, n, 'name');
      if (cardKey(i.name) === key) return p(`Line ${n + 1}: a recipe can’t use itself.`, n, 'name');
    }
  }
  for (const [n, i] of (strict ? (c.ingredients as any[]) : []).entries()) {
    const where = `Line ${n + 1}`;
    if (typeof i?.name !== 'string' || !i.name.trim()) return p(`${where} has an amount but nothing that goes in. Fill it in or remove the line.`, n, 'name');
    if (cardKey(i.name) === key) return p(`${where}: a recipe can’t use itself.`, n, 'name');
    if (!products.has(cardKey(i.name)) && !cardNames.has(cardKey(i.name))) return p(`${where}: “${i.name}” isn’t a product on your invoices or another recipe. Pick it from the list as you type.`, n, 'name');
    if (!(Number(i.amount) > 0)) return p(`${where}, ${i.name}: how much? Write the amount as 2, 1.5, 1 1/2 or ½.`, n, 'amount');
    if (typeof i.unit !== 'string' || !i.unit) return p(`${where}, ${i.name}: in what unit?`, n, 'unit');
    if (lineState(i, model, cards) === 'convert') return p(`${where}, ${i.name}: how much is one ${i.unit}? Set it once (beside the unit) and it works everywhere.`, n, 'unit');
  }
  // No loops through other cards: this card can't go into anything it uses.
  const byKey = new Map(cards.map((x) => [cardKey(x.name), x]));
  const seen = new Set<string>();
  const walk = (name: string): boolean => {
    const k = cardKey(name);
    if (k === key) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return (byKey.get(k)?.ingredients ?? []).some((i) => walk(i.name));
  };
  if (c.ingredients.some((i: any) => byKey.has(cardKey(i.name)) && walk(i.name))) return p('That would make a loop: one of those recipes already uses this one.');
  return undefined;
}

/** POS buttons linked to each recipe: answered links and exact-name matches, from sales in the period. */
export function linkedItems(model: Model) {
  const posItem = posItemOf(model);
  const out = new Map<string, { catalogId: string; itemName: string; variationName?: string; name: string; sold: number; netSales: number }[]>();
  const seen = new Set<string>();
  for (const l of model.sales) {
    if (!l.date) continue;
    const link = model.lookup(l.catalogId, l.name, l.date);
    if (!link) continue;
    const key = `${link.recipeId}|${l.catalogId}|${l.name}`;
    const list = out.get(link.recipeId) ?? [];
    let row = list.find((r) => r.catalogId === l.catalogId && r.name === l.name);
    if (!seen.has(key)) {
      seen.add(key);
      row = { ...posItem(l.catalogId, l.name), name: l.name, sold: 0, netSales: 0 };
      list.push(row);
      out.set(link.recipeId, list);
    }
    row!.sold += l.quantity;
    row!.netSales += l.netSales;
  }
  return out;
}

/** A sold button's category, and which recipes use a recipe: worked out once per model. */
const indexMemo = new WeakMap<Model, { categoryOf: Map<string, string>; usedByOf: Map<string, string[]> }>();
function modelIndex(model: Model) {
  let x = indexMemo.get(model);
  if (x) return x;
  const categoryOf = new Map<string, string>();
  for (const l of model.sales) if (l.category && !categoryOf.has(l.catalogId)) categoryOf.set(l.catalogId, l.category);
  const usedByOf = new Map<string, string[]>();
  for (const r of model.recipes) {
    for (const id of new Set(r.ingredients.filter((i) => i.item.kind === 'recipe').map((i) => i.item.id))) usedByOf.set(id, [...(usedByOf.get(id) ?? []), r.name]);
  }
  x = { categoryOf, usedByOf };
  indexMemo.set(model, x);
  return x;
}

export function cardView(model: Model, card: RecipeCard, linked: ReturnType<typeof linkedItems>, areaOf: AreaOf, cards: RecipeCard[] = []) {
  const id = cardId(card);
  const recipe = model.book.recipes.get(id);
  const kind = kindOf(card);
  const cost = recipe ? model.book.costOf({ kind: 'recipe', id }, recipe.yield) : undefined;
  const items = (linked.get(id) ?? []).sort((a, b) => b.netSales - a.netSales);
  const sold = items.reduce((s, i) => s + i.sold, 0), net = items.reduce((s, i) => s + i.netSales, 0);
  const { categoryOf, usedByOf } = modelIndex(model);
  const categories = new Set(items.map((i) => categoryOf.get(i.catalogId)).filter(Boolean) as string[]);
  const area = categories.size ? ([...categories].some((c) => areaOf(c) === 'bar') ? 'bar' : 'kitchen') : kind === 'drink' || kind === 'barPrep' ? 'bar' : 'kitchen';
  const usedBy = usedByOf.get(id) ?? [];
  return {
    id, name: card.name, kind, area,
    yields: card.yields,
    status: card.status === 'rough' ? 'rough' : 'ready',
    ingredients: card.ingredients.map((i) => {
      const state = cards.length ? lineState(i, model, cards) : 'ok';
      return { amount: i.amount > 0 ? i.amount : '', unit: i.unit, name: i.name, ...(state !== 'ok' ? { state } : {}), ...(i.yieldPercent && i.yieldPercent !== 100 ? { yieldPercent: i.yieldPercent } : {}), ...(i.note ? { note: i.note } : {}) };
    }),
    ...(card.status === 'rough' && cards.length ? { toFinish: card.ingredients.filter((i) => lineState(i, model, cards) !== 'ok').length } : {}),
    ...(card.method ? { method: card.method } : {}),
    ...(cost ? { cost: Math.round(cost.total * 100) / 100, complete: cost.complete, problems: [...new Set(cost.issues.map(issueText))] } : {}),
    ...(kind === 'dish' || kind === 'drink' ? { averagePrice: sold > 0 ? Math.round((net / sold) * 100) / 100 : undefined } : {}),
    linked: items.map((i) => ({ catalogId: i.catalogId, itemName: i.itemName, ...(i.variationName ? { variationName: i.variationName } : {}), name: i.name, sold: Math.round(i.sold), netSales: Math.round(i.netSales) })),
    usedBy,
  };
}

function issueText(i: any): string {
  if (i.type === 'missingCost') return `${i.productName}: no price yet`;
  if (i.type === 'missingConversion') return `${i.itemName}: can’t turn ${i.from ?? 'that unit'} into ${i.to ?? 'how it’s bought'}`;
  if (i.type === 'unknownItem') return `Something on the recipe isn’t a product or recipe`;
  return i.type;
}

// The product list only changes with invoices and their answers (which make a new `purchasing`).
const productsMemo = new WeakMap<object, ReturnType<typeof buildProductsView>>();
function productsView(model: Model) {
  let v = productsMemo.get(model.purchasing);
  if (!v) { v = buildProductsView(model); productsMemo.set(model.purchasing, v); }
  return v;
}
function buildProductsView(model: Model) {
  const typeOf = new Map(model.purchasing.products.map((p) => [p.externalId, p.categoryType]));
  const lastBought = new Map<string, string>();
  for (const p of model.purchasing.prices) if ((lastBought.get(p.productExternalId) ?? '') < p.date) lastBought.set(p.productExternalId, p.date.slice(0, 10));
  return model.products.map((p) => ({
    id: p.id, name: p.name, unit: p.baseUnit, units: unitsFor(p.baseUnit, p.conversions), type: typeOf.get(p.id) ?? (p.id.startsWith('free-') ? 'FREE' : undefined),
    ...(model.book.unitCost(p.id) !== undefined ? { price: Math.round(model.book.unitCost(p.id)! * 10000) / 10000 } : {}),
    ...(lastBought.get(p.id) ? { lastBought: lastBought.get(p.id) } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function saveCards(db: Db, who: SignedIn, changes: { card: CardInput; previousName?: string; link?: PosMenuItem[]; unlink?: PosMenuItem[]; changedFromToday?: boolean }[]) {
  const book = await loadBook(db, who.restaurantId);
  let cards: RecipeCard[] = [...(book.recipeCards ?? [])];
  let links: LinkAnswers = book.linkAnswers ?? { confirm: [], newDish: [] };
  const importAnswers = book.importAnswers ?? {};
  let importChanged = false;
  for (const ch of changes) {
    const prev = ch.previousName ? cards.find((c) => cardKey(c.name) === cardKey(ch.previousName!)) : cards.find((c) => cardKey(c.name) === cardKey(ch.card.name));
    const stored = toStored(ch.card, prev, ch.card.ready === true, who.name);
    cards = prev ? cards.map((c) => (c === prev ? stored : c)) : [...cards, stored];
    // A rename follows the card everywhere it's named.
    if (prev && prev.name !== stored.name) {
      const r = await followRename(db, who, { cards, links, importAnswers }, prev.name, stored.name);
      cards = r.cards; links = r.links;
      importChanged ||= r.importChanged;
    }
    // Stamped, so a button linked here counts over an earlier "recipe to come" or "not food".
    for (const item of ch.link ?? []) links = withAnswer(links, { type: 'link', catalogId: item.catalogId, itemName: item.itemName, ...(item.variationName ? { variationName: item.variationName } : {}), recipe: stored.name }, { at: new Date().toISOString(), by: who.staffId });
    for (const item of ch.unlink ?? []) {
      const same = (x: PosMenuItem) => x.catalogId === item.catalogId && x.itemName === item.itemName && (x.variationName ?? '') === (item.variationName ?? '');
      // Unlinked by hand: it goes back to "selling without a card" (not to an automatic name match).
      links = { ...links, confirm: links.confirm.filter((x) => !same(x)), newDish: [...links.newDish.filter((x) => !same(x)), { catalogId: item.catalogId, itemName: item.itemName, ...(item.variationName ? { variationName: item.variationName } : {}), note: 'unlinked in the app', at: new Date().toISOString(), by: who.staffId }] };
    }
  }
  // A real change from today (not a fix): past periods keep the recipe as it was.
  const dated = new Set(changes.filter((ch) => ch.changedFromToday).map((ch) => ch.card.name.trim()));
  await saveBook(db, who.restaurantId, 'recipeCards', cards, who.staffId, dated);
  await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
  if (importChanged) await saveBook(db, who.restaurantId, 'importAnswers', importAnswers, who.staffId);
}

/** Everything that names a card by name, renamed with it: other cards, links, portions, station items, plans. */
async function followRename(db: Db, who: SignedIn, state: { cards: RecipeCard[]; links: LinkAnswers; importAnswers: PilotImportAnswers }, from: string, to: string) {
  const was = cardKey(from);
  const cards = state.cards.map((c) => ({ ...c, ingredients: c.ingredients.map((i) => (cardKey(i.name) === was ? { ...i, name: to } : i)) }));
  const links = { ...state.links, confirm: state.links.confirm.map((l) => (cardKey(l.recipe) === was ? { ...l, recipe: to } : l)) };
  let importChanged = false;
  if (state.importAnswers.portions?.some((p) => cardKey(p.recipe) === was)) {
    state.importAnswers.portions = state.importAnswers.portions.map((p) => (cardKey(p.recipe) === was ? { ...p, recipe: to } : p));
    importChanged = true;
  }
  await db.query('UPDATE station_items SET recipe_name = $1 WHERE restaurant_id = $2 AND lower(recipe_name) = lower($3)', [to, who.restaurantId, from]);
  await db.query('UPDATE menu_plans SET recipe_name = $1 WHERE restaurant_id = $2 AND lower(recipe_name) = lower($3)', [to, who.restaurantId, from]);
  return { cards, links, importChanged };
}

export function sameDishAs(card: RecipeCard, cards: readonly RecipeCard[]): string[] {
  const kind = kindOf(card);
  return cards.filter((c) => c !== card && cardKey(c.name) !== cardKey(card.name) && kindOf(c) === kind && sameDishName(c.name, card.name)).map((c) => c.name);
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'or', 'of', 'with', 'in', 'on', 'the', 'to', 'for', 'de', 'di', 'del', 'della', 'al', 'alla', 'e', 'la', 'le']);
/** "apricot glaze" → "Apricot Glaze"; "BOH chili oil" → "BOH Chili Oil"; "Gluten Free dough1" → "Gluten Free Dough". */
export function titleCase(name: string): string {
  const words = name.trim().replace(/\s+/g, ' ').split(' ');
  return words.map((w, i) => {
    w = w.replace(/(?<=[a-z])\d+$/i, '');
    if (/^[A-Z0-9&]{2,}$/.test(w) || /[a-z][A-Z]/.test(w)) return w; // BOH, McX: as written
    if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
    return w.toLowerCase().replace(/(^|[-'’(/])([a-zà-ÿ])/g, (_m, p, c) => p + c.toUpperCase());
  }).join(' ');
}

const PRICE_VARIATION = /off|wednesday|tuesday|thursday|monday|friday|happy|special|\$|regular price|cocktail tues/i;

/**
 * Names to tidy: dishes and drinks named as they sell on the POS (the plain button, not a
 * price variation of it), everything else in title case, and duplicate cards (only one of a
 * name is ever used) to remove.
 */
function tidyProposals(model: Model, cards: RecipeCard[], links: LinkAnswers) {
  const linked = linkedItems(model);
  const out: { index: number; from: string; to?: string; remove?: true; why: string }[] = [];
  // Duplicates: the app has been using the last card of a name; the others are dead weight.
  const lastOf = new Map<string, number>();
  cards.forEach((c, i) => lastOf.set(cardKey(c.name), i));
  cards.forEach((c, i) => { if (lastOf.get(cardKey(c.name)) !== i) out.push({ index: i, from: c.name, remove: true, why: `Two recipes are called ${c.name}; the app has been using the other one (${cards[lastOf.get(cardKey(c.name))!]!.ingredients.length} lines; this one has ${c.ingredients.length}).` }); });
  const taken = new Set(cards.map((c) => cardKey(c.name)));
  cards.forEach((c, i) => {
    if (lastOf.get(cardKey(c.name)) !== i) return;
    const kind = kindOf(c);
    let to = titleCase(c.name), why = 'Capitalized like the rest of the book.';
    if (kind === 'dish' || kind === 'drink') {
      const id = cardId(c);
      const sold = (linked.get(id) ?? []).sort((a, b) => b.sold - a.sold);
      const answered = links.confirm.filter((l) => cardKey(l.recipe) === cardKey(c.name));
      const button = sold.find((b) => !b.variationName || !PRICE_VARIATION.test(b.variationName)) ?? sold[0] ?? answered[0];
      if (button) {
        // One button that has carried other cards too (seasonal versions) keeps each version's own name.
        const versions = new Set(links.confirm.filter((l) => l.catalogId === button.catalogId).map((l) => cardKey(l.recipe)));
        const seasonal = versions.size > 1 || links.newDish.some((n) => n.catalogId === button.catalogId && n.from);
        const pos = button.variationName && !PRICE_VARIATION.test(button.variationName) && !/^regular$/i.test(button.variationName) ? `${button.itemName} (${button.variationName})` : button.itemName;
        if (seasonal) {
          why = `Keeps its own name: ${pos} has had more than one version, and each version keeps its recipe's name.`;
          if (to === c.name) { out.push({ index: i, from: c.name, why }); return; }
        }
        else { to = pos.trim(); why = `Named as it sells in Square.`; }
      }
    }
    if (to === c.name) return;
    if (cardKey(to) !== cardKey(c.name) && taken.has(cardKey(to))) { out.push({ index: i, from: c.name, why: `Would be ${to}, but another recipe already has that name.` }); return; }
    taken.add(cardKey(to));
    out.push({ index: i, from: c.name, to, why });
  });
  return out;
}

const posItemArg = (v: unknown): PosMenuItem[] => (Array.isArray(v) ? v : []).filter((x: any) => typeof x?.catalogId === 'string' && typeof x?.itemName === 'string' && x.itemName)
  .map((x: any) => ({ catalogId: x.catalogId, itemName: x.itemName, ...(typeof x.variationName === 'string' && x.variationName ? { variationName: x.variationName } : {}) }));

export async function cardRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/cards')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const model = await getModel(db, who.restaurantId, today);
  const areaOf = await loadAreas(db, who.restaurantId);

  if (method === 'GET' && path === '/api/cards') {
    const area = url.searchParams.get('area') === 'bar' ? 'bar' : url.searchParams.get('area') === 'kitchen' ? 'kitchen' : undefined;
    const book = await loadBook(db, who.restaurantId);
    const linked = linkedItems(model);
    const cards = (book.recipeCards ?? []).map((c) => cardView(model, c, linked, areaOf, book.recipeCards ?? []));
    // Preps a side's cards use are that side's too.
    const areaByName = new Map(cards.map((x) => [x.name, x.area]));
    const usedOn = (c: (typeof cards)[number]) => c.area === area || c.usedBy.some((n) => areaByName.get(n) === area);
    const posItem = posItemOf(model);
    const notFood = new Set((book.linkAnswers?.notFood ?? []).map((x) => posName(x)));
    return send(res, 200, {
      cards: (area ? cards.filter(usedOn) : cards).sort((a, b) => a.name.localeCompare(b.name)),
      allCards: cards.map((c) => ({ name: c.name, id: c.id, kind: c.kind, status: c.status, ...cardUnits(c.kind === 'prep' || c.kind === 'barPrep' ? c.yields : [{ amount: 1, unit: 'each' }]) })),
      products: productsView(model),
      noCard: model.margins.unlinked.filter((u) => u.catalogId && u.netSales > 0 && !notFood.has(u.name) && (!area || areaOf(u.category) === area))
        .map((u) => ({ ...posItem(u.catalogId, u.name), name: u.name, category: u.category, sold: Math.round(u.quantity), netSales: Math.round(u.netSales) })),
    }), true;
  }

  // Recipe checks: what the menu uses but hasn't been bought in far too long, and what's bought but in no recipe.
  if (method === 'GET' && path === '/api/cards/checks') {
    const book = await loadBook(db, who.restaurantId);
    const checks = recipeChecks(model, today, (book.linkAnswers?.dismissed ?? []).map((d) => d.dedupeKey));
    const area = url.searchParams.get('area');
    const mine = <T extends { side: string }>(xs: T[]) => (area === 'kitchen' || area === 'bar' ? xs.filter((x) => x.side === area) : xs);
    return send(res, 200, {
      notBought: mine(checks.notBought), notInRecipes: mine(checks.notInRecipes), quietVendors: mine(checks.quietVendors),
      // To pick a replacement by hand: everything bought, newest first.
      products: productsView(model).filter((p) => p.type !== 'FREE').map((p) => ({ id: p.id, name: p.name, unit: p.unit, ...(p.lastBought ? { lastBought: p.lastBought } : {}) })),
    }), true;
  }

  // Swap a product for another in recipes (the cream you stopped buying for the one you buy now).
  // The amount and unit stay; a ready recipe whose line no longer converts goes back to rough.
  if (method === 'POST' && path === '/api/cards/swap') {
    const b = await body(req);
    const from = model.products.find((p) => p.id === String(b.from ?? '')), to = model.products.find((p) => p.id === String(b.to ?? ''));
    if (!from || !to) throw new HttpError(404, 'No such product.');
    if (from.id === to.id) throw new HttpError(400, 'Pick a different product to swap in.');
    const only = Array.isArray(b.recipes) ? new Set((b.recipes as unknown[]).map(String)) : undefined;
    const book = await loadBook(db, who.restaurantId);
    const cards = book.recipeCards ?? [];
    const importAnswers: PilotImportAnswers = book.importAnswers ?? {};
    const told = new Map(Object.entries(importAnswers.ingredientProducts ?? {}).map(([n, id]) => [cardKey(n), id]));
    // A line names `from` the way the recipes read it: told by a manager, or by its own name (and not a recipe's).
    const isFrom = (name: string) => { const k = cardKey(name); return told.has(k) ? told.get(k) === from.id : k === cardKey(from.name) && !cardNamed(cards, name); };
    const changed: string[] = [], rough: string[] = [];
    let next = cards.map((c) => {
      if ((only && !only.has(c.name)) || !c.ingredients.some((i) => isFrom(i.name))) return c;
      changed.push(c.name);
      return { ...c, ingredients: c.ingredients.map((i) => (isFrom(i.name) ? { ...i, name: to.name } : i)), updatedAt: new Date().toISOString(), updatedBy: who.name };
    });
    if (!changed.length) throw new HttpError(409, `No recipe${only ? ' of those' : ''} uses ${from.name} any more.`);
    next = next.map((c) => {
      if (!changed.includes(c.name) || c.status === 'rough') return c;
      if (c.ingredients.every((i) => cardKey(i.name) !== cardKey(to.name) || lineState(i, model, next) === 'ok')) return c;
      rough.push(c.name);
      return { ...c, status: 'rough' as const };
    });
    await saveBook(db, who.restaurantId, 'recipeCards', next, who.staffId);
    if (importAnswers.portions?.some((p) => p.ingredient === from.name && changed.includes(p.recipe))) {
      await saveBook(db, who.restaurantId, 'importAnswers', { ...importAnswers, portions: importAnswers.portions.map((p) => (p.ingredient === from.name && changed.includes(p.recipe) ? { ...p, ingredient: to.name } : p)) }, who.staffId);
    }
    return send(res, 200, { changed, rough }), true;
  }

  if (method === 'POST' && path === '/api/cards/preview') {
    const b = await body(req);
    const book = await loadBook(db, who.restaurantId);
    const c = b.card as any;
    if (!c?.ingredients) throw new HttpError(400, 'Missing recipe.');
    // Cost each line on its own: what it costs and what's missing.
    const lines = (c.ingredients as any[]).map((i) => {
      const product = productNamed(model, String(i.name ?? ''));
      const card = cardNamed(book.recipeCards ?? [], String(i.name ?? ''));
      const amount = Number(i.amount) / ((Number(i.yieldPercent) || 100) / 100);
      // Where the price comes from shows as soon as the line names something, before an amount.
      const source = product ? model.priceSource.get(product.id) : card ? { from: 'recipe' as const } : undefined;
      if (!(amount > 0) || !i.unit) return source ? { source } : {};
      const item = product ? { kind: 'product' as const, id: product.id } : card ? { kind: 'recipe' as const, id: cardId(card) } : undefined;
      if (!item) return { problem: 'Not a product or recipe' };
      const r = model.book.costOf(item, { amount, unit: String(i.unit) });
      // Said where the line is, not in a tooltip: why it has no cost, and what fixes it.
      const own = product && r.issues.some((x) => x.type === 'missingCost' && x.productId === product.id);
      const convert = r.issues.find((x) => x.type === 'missingConversion');
      return {
        cost: Math.round(r.total * 100) / 100,
        ...(r.complete ? {} : { problem: [...new Set(r.issues.map(issueText))].join('; ') }),
        ...(product && own ? { needsPrice: { productId: product.id, name: product.name, unit: product.baseUnit } } : {}),
        ...(convert ? { cantConvert: true } : {}),
        ...(source ? { source } : {}),
      };
    });
    const total = lines.reduce((s, l: any) => s + (l.cost ?? 0), 0);
    return send(res, 200, { lines, total: Math.round(total * 100) / 100, complete: lines.every((l: any) => l.cost !== undefined && !l.problem) }), true;
  }

  if (method === 'POST' && (path === '/api/cards' || path === '/api/cards/batch')) {
    const b = await body(req, 1024 * 1024);
    const list = path === '/api/cards' ? [b] : Array.isArray(b.cards) ? (b.cards as any[]) : [];
    if (!list.length) throw new HttpError(400, 'No recipes.');
    const book = await loadBook(db, who.restaurantId);
    let cards = [...(book.recipeCards ?? [])];
    const batch = path === '/api/cards/batch';
    const statuses: ('rough' | 'ready')[] = [];
    for (const ch of list) {
      const prev = typeof ch.previousName === 'string' ? ch.previousName : undefined;
      const before = (book.recipeCards ?? []).find((c) => cardKey(c.name) === cardKey(prev ?? ch.card?.name ?? ''));
      const wantReady = batch || ch.card?.ready === true;
      // Already ready, and still finished after this change: it stays ready.
      const finished = !cardProblem(ch.card, model, cards, prev, true);
      const ready = wantReady || (Boolean(before) && before!.status !== 'rough' && finished);
      statuses.push(ready ? 'ready' : 'rough');
      if (ch.card) ch.card.ready = ready;
      const problem = cardProblem(ch.card, model, cards, prev, wantReady);
      if (problem) throw new HttpError(400, list.length > 1 ? `${ch.card?.name ?? 'A recipe'}: ${problem.message}` : problem.message, list.length > 1 ? undefined : { ...(problem.line !== undefined ? { line: problem.line } : {}), ...(problem.field ? { field: problem.field } : {}) });
      // Later cards in a batch may use earlier ones.
      cards = [...cards.filter((c) => cardKey(c.name) !== cardKey(prev ?? ch.card.name)), toStored(ch.card, undefined, ch.card.ready)];
    }
    await saveCards(db, who, list.map((ch) => ({ card: ch.card as CardInput, ...(typeof ch.previousName === 'string' ? { previousName: ch.previousName } : {}), link: posItemArg(ch.link), unlink: posItemArg(ch.unlink), ...(ch.changedFromToday === true ? { changedFromToday: true } : {}) })));
    const toFinish = (list[0]?.card?.ingredients ?? []).filter((i: any) => lineState(i, model, cards) !== 'ok').length;
    return send(res, 200, { saved: list.length, status: statuses[0], ...(statuses[0] === 'rough' ? { toFinish } : {}) }), true;
  }

  // Two recipes for one dish (a draft made from the button, and the real one): everything that pointed
  // at the first (buttons, other recipes, prep lists, what came off the menu) moves to the second.
  if (method === 'POST' && path === '/api/cards/merge') {
    const b = await body(req);
    const book = await loadBook(db, who.restaurantId);
    let cards = [...(book.recipeCards ?? [])];
    const from = cards.find((c) => c.name === String(b.from ?? '')), into = cards.find((c) => c.name === String(b.into ?? ''));
    if (!from || !into) throw new HttpError(404, 'One of those recipes isn’t there any more. Reload and try again.');
    if (from === into) throw new HttpError(400, 'That’s the same recipe.');
    if (kindOf(from) !== kindOf(into)) throw new HttpError(400, 'Only a dish with a dish, a prep with a prep.');
    const importAnswers = book.importAnswers ?? {};
    cards = cards.filter((c) => c !== from);
    const r = await followRename(db, who, { cards, links: book.linkAnswers ?? { confirm: [], newDish: [] }, importAnswers }, from.name, into.name);
    const fromId = cardId(from), intoId = cardId(into);
    const status = r.links.menuStatus ?? [];
    const links = { ...r.links, menuStatus: status.some((m) => m.recipeId === intoId) ? status.filter((m) => m.recipeId !== fromId) : status.map((m) => (m.recipeId === fromId ? { ...m, recipeId: intoId } : m)) };
    await saveBook(db, who.restaurantId, 'recipeCards', r.cards, who.staffId);
    await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
    if (r.importChanged) await saveBook(db, who.restaurantId, 'importAnswers', importAnswers, who.staffId);
    return send(res, 200, { ok: true, into: into.name }), true;
  }

  if (method === 'POST' && path === '/api/cards/delete') {
    const b = await body(req);
    const book = await loadBook(db, who.restaurantId);
    const name = String(b.name ?? '');
    const card = (book.recipeCards ?? []).find((c) => c.name === name);
    if (!card) throw new HttpError(404, 'No such recipe.');
    const users = (book.recipeCards ?? []).filter((c) => c.ingredients.some((i) => cardKey(i.name) === cardKey(name)));
    if (users.length) throw new HttpError(409, `${users.map((u) => u.name).join(', ')} still use${users.length === 1 ? 's' : ''} it.`);
    const links = book.linkAnswers ?? { confirm: [], newDish: [] };
    await saveBook(db, who.restaurantId, 'recipeCards', (book.recipeCards ?? []).filter((c) => c !== card), who.staffId);
    await saveBook(db, who.restaurantId, 'linkAnswers', { ...links, confirm: links.confirm.filter((l) => l.recipe !== name) }, who.staffId);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'GET' && path === '/api/cards/tidy') {
    const book = await loadBook(db, who.restaurantId);
    return send(res, 200, { proposals: tidyProposals(model, book.recipeCards ?? [], book.linkAnswers ?? { confirm: [], newDish: [] }) }), true;
  }

  if (method === 'POST' && path === '/api/cards/tidy') {
    const b = await body(req, 256 * 1024);
    const book = await loadBook(db, who.restaurantId);
    let cards = [...(book.recipeCards ?? [])];
    let links: LinkAnswers = book.linkAnswers ?? { confirm: [], newDish: [] };
    const importAnswers = book.importAnswers ?? {};
    let importChanged = false;
    const renames = (Array.isArray(b.renames) ? b.renames : []) as { index: number; from: string; to: string }[];
    const removes = (Array.isArray(b.removes) ? b.removes : []) as { index: number; from: string }[];
    // Checked against the book as it is now, by position and name, so a stale screen can't remove the wrong card.
    for (const x of [...renames, ...removes]) if (cards[x.index]?.name !== x.from) throw new HttpError(409, 'The recipes changed since this list was made. Reload and try again.');
    for (const x of renames) {
      if (typeof x.to !== 'string' || !x.to.trim()) throw new HttpError(400, `A new name for ${x.from}?`);
      const clash = cards.findIndex((c, i) => i !== x.index && cardKey(c.name) === cardKey(x.to) && !removes.some((r) => r.index === i) && !renames.some((r) => r.index === i && cardKey(r.to) !== cardKey(x.to)));
      if (clash >= 0) throw new HttpError(409, `${x.to.trim()} is already another recipe's name.`);
    }
    const renamed = cards.map((c, i) => { const r = renames.find((x) => x.index === i); return r ? { ...c, name: r.to.trim() } : c; });
    cards = renamed.filter((_c, i) => !removes.some((r) => r.index === i));
    // References follow each rename (a removed duplicate's name stays with the card that kept it).
    // Through placeholders first, so swapped names (A → B, B → A) don't run into each other.
    const steps = [...renames.map((x, n) => [x.from, `tidyplaceholder${n}x`]), ...renames.map((x, n) => [`tidyplaceholder${n}x`, x.to.trim()])];
    for (const [from, to] of steps) {
      const r = await followRename(db, who, { cards, links, importAnswers }, from!, to!);
      cards = r.cards; links = r.links; importChanged ||= r.importChanged;
    }
    await saveBook(db, who.restaurantId, 'recipeCards', cards, who.staffId);
    await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
    if (importChanged) await saveBook(db, who.restaurantId, 'importAnswers', importAnswers, who.staffId);
    return send(res, 200, { renamed: renames.length, removed: removes.length }), true;
  }

  // A button taken off a recipe by hand: it goes back to "selling without a recipe", recipe to come.
  if (method === 'POST' && path === '/api/cards/unlink') {
    const b = await body(req);
    const items = posItemArg(b.items);
    if (!items.length) throw new HttpError(400, 'Which button?');
    const book = await loadBook(db, who.restaurantId);
    let links: LinkAnswers = book.linkAnswers ?? { confirm: [], newDish: [] };
    const at = new Date().toISOString();
    for (const item of items) {
      const same = (x: PosMenuItem) => x.catalogId === item.catalogId && x.itemName === item.itemName && (x.variationName ?? '') === (item.variationName ?? '');
      links = { ...links, confirm: links.confirm.filter((x) => !same(x)), newDish: [...links.newDish.filter((x) => !same(x)), { ...item, note: 'unlinked in the app', at, by: who.staffId }] };
    }
    await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && path === '/api/cards/no-card') {
    const b = await body(req);
    const book = await loadBook(db, who.restaurantId);
    let links: LinkAnswers = book.linkAnswers ?? { confirm: [], newDish: [] };
    for (const item of posItemArg(b.items)) links = withAnswer(links, { type: 'notFood', ...item }, { at: new Date().toISOString(), by: who.staffId });
    await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'GET' && path === '/api/cards/history') {
    const id = String(url.searchParams.get('id') ?? '');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Which recipe?');
    return send(res, 200, { versions: await recipeVersions(db, who.restaurantId, id) }), true;
  }

  if (method === 'GET' && path === '/api/cards/version') {
    const v = await recipeVersion(db, who.restaurantId, String(url.searchParams.get('id') ?? ''));
    if (!v) throw new HttpError(404, 'No such version.');
    const c = v.card;
    return send(res, 200, { recipeId: v.recipeId, at: v.at, card: { name: c.name, kind: kindOf(c), yields: c.yields, ingredients: c.ingredients.map((i) => ({ amount: i.amount, unit: i.unit, name: i.name, ...(i.yieldPercent && i.yieldPercent !== 100 ? { yieldPercent: i.yieldPercent } : {}), ...(i.note ? { note: i.note } : {}) })), ...(c.method ? { method: c.method } : {}), ...(c.status === 'rough' ? { rough: true } : {}) } }), true;
  }

  if (method === 'POST' && path === '/api/cards/restore') {
    const b = await body(req);
    try {
      const r = await restoreRecipeVersion(db, who.restaurantId, String(b.version ?? ''), who.staffId, who.name);
      return send(res, 200, { ok: true, name: r.name }), true;
    } catch (err) {
      const status = (err as { status?: number }).status ?? (/No such version/.test((err as Error).message) ? 404 : 500);
      if (status === 500) throw err;
      throw new HttpError(status, (err as Error).message);
    }
  }

  if (method === 'GET' && path === '/api/cards/drafts') {
    const book = await loadBook(db, who.restaurantId);
    const notFood = new Set((book.linkAnswers?.notFood ?? []).map((x) => posName(x)));
    const awaiting = new Set((book.linkAnswers?.newDish ?? []).filter((x) => x.note !== 'unlinked in the app').map((x) => posName(x)));
    const posItem = posItemOf(model);
    const items: BarItem[] = model.margins.unlinked
      .filter((u) => u.catalogId && areaOf(u.category) === 'bar' && !notFood.has(u.name) && u.quantity > 0)
      .map((u) => ({ ...posItem(u.catalogId, u.name), category: u.category, netSales: u.netSales, quantity: u.quantity }));
    const num = (k: string, d: number) => { const v = Number(url.searchParams.get(k)); return v > 0 && v < 64 ? v : d; };
    const products = productsView(model);
    const drafts = draftDrinkCards(items, products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, ...(p.type ? { type: p.type } : {}), ...(p.lastBought ? { lastBought: p.lastBought } : {}) })), { winePour: num('winePour', 6), draftPour: num('draftPour', 16), espressoDose: num('dose', 18) });
    // Cards already named like a draft: link to that card rather than writing a second one.
    const existing = new Set((book.recipeCards ?? []).map((c) => cardKey(c.name)));
    return send(res, 200, {
      drafts: drafts.map((d) => ({ ...d, ...(existing.has(cardKey(d.name)) ? { cardExists: true } : {}), ...(d.items.some((i) => awaiting.has(posName(i))) ? { markedNew: true } : {}) })),
      products: products.filter((p) => ['WINE', 'BEER', 'LIQUOR', 'NA_BEVERAGES'].includes(p.type ?? '') || /coffee|milk/i.test(p.name)).map((p) => ({ id: p.id, name: p.name, unit: p.unit, units: p.units, type: p.type })),
    }), true;
  }
  return false;
}

export function yieldConversions(yields: { amount: number; unit: string }[]) {
  // A card's yields name the same batch several ways (2 qt = 64 floz = 12 portions): each is a unit of it.
  const first = yields[0];
  if (!first) return {};
  return { customUnits: Object.fromEntries(yields.slice(1).filter((y) => y.amount > 0).map((y) => [y.unit, { amount: first.amount / y.amount, unit: first.unit }])) };
}
