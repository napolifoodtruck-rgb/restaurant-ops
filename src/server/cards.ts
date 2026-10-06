/**
 * Recipe cards, written and changed in the app: dishes, drinks and the preps they use. A card
 * lists what goes in by the names of products on invoices (or other cards), so it's costed from
 * what was actually paid, and it's linked to the POS buttons that sell it.
 *
 *   GET  /api/cards?area=kitchen|bar        cards on that side, costed, with what they're linked to
 *   POST /api/cards/preview                 { card }: what it would cost, line by line
 *   POST /api/cards                         { card, previousName?, link?: [posItem], unlink?: [posItem] }
 *   POST /api/cards/batch                   { cards: [{ card, link }] } (a group of drafts at once)
 *   POST /api/cards/delete                  { name }
 *   POST /api/cards/no-card                 { items: [posItem] }: a fee or not a drink (corkage)
 *   GET  /api/cards/drafts?winePour=&draftPour=   bar drafts for drinks with no card yet
 *
 * Cards live in the kitchen book (every save is kept in its history). Managers and up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, loadBook, saveBook, withAnswer, type LinkAnswers, type Model, type PilotImportAnswers } from './model.ts';
import { loadAreas, type AreaOf } from './areas.ts';
import { posItemOf } from './views.ts';
import { normalizeName as cardKey, recipeId, type RecipeCard } from '../connectors/marginedgeRecipes.ts';
import { tryConvert } from '../core/units.ts';
import { posName, type PosMenuItem } from '../core/menuLinks.ts';
import { draftDrinkCards, type BarItem } from '../core/drinkCards.ts';

export type CardKind = 'dish' | 'drink' | 'prep' | 'barPrep';
export interface CardInput {
  name: string;
  kind: CardKind;
  yields?: { amount: number; unit: string }[];
  ingredients: { amount: number; unit: string; name: string; yieldPercent?: number; note?: string }[];
  method?: string;
}

const isPrepCard = (c: RecipeCard) => /^prep/i.test(c.recipeType ?? '') || (!!c.category && !/menu/i.test(c.category));
export function kindOf(c: RecipeCard): CardKind {
  if (isPrepCard(c)) return /bar/i.test(c.recipeType ?? '') ? 'barPrep' : 'prep';
  return /^drink/i.test(c.recipeType ?? '') ? 'drink' : 'dish';
}

const UNITS = ['each', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal', 'dash'];

/** The units an amount of this product (or card) can be given in. */
function unitsFor(base: string, conversions: any): string[] {
  const custom = Object.keys(conversions?.customUnits ?? {});
  return [...new Set([base, ...custom, ...UNITS])].filter((u) => u === base || tryConvert({ amount: 1, unit: u }, base, conversions) !== undefined);
}

function toStored(c: CardInput, before?: RecipeCard): RecipeCard {
  const prep = c.kind === 'prep' || c.kind === 'barPrep';
  const yields = prep ? (c.yields ?? []).filter((y) => y.amount > 0 && y.unit) : [{ amount: 1, unit: 'each' }];
  return {
    name: c.name.trim(),
    category: prep ? 'Prep' : 'Menu items',
    // A dish keeps the type it had (Pizza, Appetizers); the others are named for what they are.
    recipeType: c.kind === 'drink' ? 'Drink' : c.kind === 'barPrep' ? 'Prep (bar)' : c.kind === 'prep' ? 'Prep' : before && kindOf(before) === 'dish' ? before.recipeType : 'Dish',
    yields,
    ingredients: c.ingredients.map((i) => ({ amount: Number(i.amount), unit: i.unit, name: i.name.trim(), yieldPercent: i.yieldPercent && i.yieldPercent > 0 && i.yieldPercent <= 100 ? i.yieldPercent : 100, ...(i.note ? { note: i.note } : {}) })),
    ...(c.method?.trim() ? { method: c.method.trim() } : {}),
    unreadLines: before?.unreadLines ?? [],
    layout: 'card',
    ...(before?.shelfLifeDays ? { shelfLifeDays: before.shelfLifeDays } : {}),
  };
}

function cardProblem(c: any, model: Model, cards: RecipeCard[], previousName?: string): string | undefined {
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return 'Name the recipe.';
  if (!['dish', 'drink', 'prep', 'barPrep'].includes(c.kind)) return 'Is it a dish, a drink or a prep?';
  if (!Array.isArray(c.ingredients)) return 'Missing ingredients.';
  const key = cardKey(c.name);
  if (cards.some((x) => cardKey(x.name) === key && (!previousName || cardKey(previousName) !== key))) return `There's already a recipe called ${c.name.trim()}.`;
  if ((c.kind === 'prep' || c.kind === 'barPrep') && !(Array.isArray(c.yields) && c.yields.some((y: any) => y?.amount > 0 && y?.unit))) return 'Say what a batch makes (e.g. 2 qt).';
  const products = new Set(model.products.map((p) => cardKey(p.name)));
  const cardNames = new Set(cards.filter((x) => !previousName || cardKey(x.name) !== cardKey(previousName)).map((x) => cardKey(x.name)));
  for (const i of c.ingredients) {
    if (typeof i?.name !== 'string' || !i.name.trim()) return 'Each line needs what goes in.';
    if (!(Number(i.amount) > 0)) return `How much ${i.name}?`;
    if (typeof i.unit !== 'string' || !i.unit) return `${i.name}: in what unit?`;
    if (cardKey(i.name) === key) return 'A recipe can’t use itself.';
    if (!products.has(cardKey(i.name)) && !cardNames.has(cardKey(i.name))) return `${i.name} isn’t a product on your invoices or another recipe. Pick it from the list.`;
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
  if (c.ingredients.some((i: any) => byKey.has(cardKey(i.name)) && walk(i.name))) return 'That would make a loop: one of those recipes already uses this one.';
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

export function cardView(model: Model, card: RecipeCard, linked: ReturnType<typeof linkedItems>, areaOf: AreaOf) {
  const id = recipeId(card.name);
  const recipe = model.book.recipes.get(id);
  const kind = kindOf(card);
  const cost = recipe ? model.book.costOf({ kind: 'recipe', id }, recipe.yield) : undefined;
  const items = (linked.get(id) ?? []).sort((a, b) => b.netSales - a.netSales);
  const sold = items.reduce((s, i) => s + i.sold, 0), net = items.reduce((s, i) => s + i.netSales, 0);
  const categories = new Set(items.map((i) => model.sales.find((l) => l.catalogId === i.catalogId)?.category).filter(Boolean) as string[]);
  const area = categories.size ? ([...categories].some((c) => areaOf(c) === 'bar') ? 'bar' : 'kitchen') : kind === 'drink' || kind === 'barPrep' ? 'bar' : 'kitchen';
  const usedBy = model.recipes.filter((r) => r.ingredients.some((i) => i.item.kind === 'recipe' && i.item.id === id)).map((r) => r.name);
  return {
    name: card.name, kind, area,
    yields: card.yields,
    ingredients: card.ingredients.map((i) => ({ amount: i.amount, unit: i.unit, name: i.name, ...(i.yieldPercent && i.yieldPercent !== 100 ? { yieldPercent: i.yieldPercent } : {}), ...(i.note ? { note: i.note } : {}) })),
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

function productsView(model: Model) {
  const typeOf = new Map(model.imported.products.map((p) => [p.externalId, p.categoryType]));
  const lastBought = new Map<string, string>();
  for (const p of model.imported.prices) if ((lastBought.get(p.productExternalId) ?? '') < p.date) lastBought.set(p.productExternalId, p.date.slice(0, 10));
  return model.products.map((p) => ({
    id: p.id, name: p.name, unit: p.baseUnit, units: unitsFor(p.baseUnit, p.conversions), type: typeOf.get(p.id) ?? (p.id.startsWith('free-') ? 'FREE' : undefined),
    ...(model.book.unitCost(p.id) !== undefined ? { price: Math.round(model.book.unitCost(p.id)! * 10000) / 10000 } : {}),
    ...(lastBought.get(p.id) ? { lastBought: lastBought.get(p.id) } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function saveCards(db: Db, who: SignedIn, changes: { card: CardInput; previousName?: string; link?: PosMenuItem[]; unlink?: PosMenuItem[] }[]) {
  const book = await loadBook(db, who.restaurantId);
  let cards: RecipeCard[] = [...(book.recipeCards ?? [])];
  let links: LinkAnswers = book.linkAnswers ?? { confirm: [], newDish: [] };
  const importAnswers = book.importAnswers ?? {};
  let importChanged = false;
  for (const ch of changes) {
    const prev = ch.previousName ? cards.find((c) => cardKey(c.name) === cardKey(ch.previousName!)) : cards.find((c) => cardKey(c.name) === cardKey(ch.card.name));
    const stored = toStored(ch.card, prev);
    cards = prev ? cards.map((c) => (c === prev ? stored : c)) : [...cards, stored];
    // A rename follows the card everywhere it's named.
    if (prev && prev.name !== stored.name) {
      const r = await followRename(db, who, { cards, links, importAnswers }, prev.name, stored.name);
      cards = r.cards; links = r.links;
      importChanged ||= r.importChanged;
    }
    for (const item of ch.link ?? []) links = withAnswer(links, { type: 'link', catalogId: item.catalogId, itemName: item.itemName, ...(item.variationName ? { variationName: item.variationName } : {}), recipe: stored.name });
    for (const item of ch.unlink ?? []) {
      const same = (x: PosMenuItem) => x.catalogId === item.catalogId && x.itemName === item.itemName && (x.variationName ?? '') === (item.variationName ?? '');
      // Unlinked by hand: it goes back to "selling without a card" (not to an automatic name match).
      links = { ...links, confirm: links.confirm.filter((x) => !same(x)), newDish: [...links.newDish.filter((x) => !same(x)), { catalogId: item.catalogId, itemName: item.itemName, ...(item.variationName ? { variationName: item.variationName } : {}), note: 'unlinked in the app' }] };
    }
  }
  await saveBook(db, who.restaurantId, 'recipeCards', cards, who.staffId);
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
      const id = recipeId(c.name);
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
    const cards = (book.recipeCards ?? []).map((c) => cardView(model, c, linked, areaOf));
    // Preps a side's cards use are that side's too.
    const usedOn = (c: (typeof cards)[number]) => c.area === area || c.usedBy.some((n) => cards.find((x) => x.name === n)?.area === area);
    const posItem = posItemOf(model);
    const notFood = new Set((book.linkAnswers?.notFood ?? []).map((x) => posName(x)));
    return send(res, 200, {
      cards: (area ? cards.filter(usedOn) : cards).sort((a, b) => a.name.localeCompare(b.name)),
      allCards: cards.map((c) => ({ name: c.name, kind: c.kind, unit: c.yields[0]?.unit ?? 'each', units: unitsFor(c.yields[0]?.unit ?? 'each', yieldConversions(c.yields)) })),
      products: productsView(model),
      noCard: model.margins.unlinked.filter((u) => u.catalogId && u.netSales > 0 && !notFood.has(u.name) && (!area || areaOf(u.category) === area))
        .map((u) => ({ ...posItem(u.catalogId, u.name), name: u.name, category: u.category, sold: Math.round(u.quantity), netSales: Math.round(u.netSales) })),
    }), true;
  }

  if (method === 'POST' && path === '/api/cards/preview') {
    const b = await body(req);
    const book = await loadBook(db, who.restaurantId);
    const c = b.card as any;
    if (!c?.ingredients) throw new HttpError(400, 'Missing recipe.');
    // Cost each line on its own: what it costs and what's missing.
    const lines = (c.ingredients as any[]).map((i) => {
      const product = model.products.find((p) => cardKey(p.name) === cardKey(String(i.name ?? '')));
      const card = (book.recipeCards ?? []).find((x) => cardKey(x.name) === cardKey(String(i.name ?? '')));
      const amount = Number(i.amount) / ((Number(i.yieldPercent) || 100) / 100);
      if (!(amount > 0) || !i.unit) return {};
      const item = product ? { kind: 'product' as const, id: product.id } : card ? { kind: 'recipe' as const, id: recipeId(card.name) } : undefined;
      if (!item) return { problem: 'Not a product or recipe' };
      const r = model.book.costOf(item, { amount, unit: String(i.unit) });
      return { cost: Math.round(r.total * 100) / 100, ...(r.complete ? {} : { problem: [...new Set(r.issues.map(issueText))].join('; ') }) };
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
    for (const ch of list) {
      const prev = typeof ch.previousName === 'string' ? ch.previousName : undefined;
      const problem = cardProblem(ch.card, model, cards, prev);
      if (problem) throw new HttpError(400, list.length > 1 ? `${ch.card?.name ?? 'A recipe'}: ${problem}` : problem);
      // Later cards in a batch may use earlier ones.
      cards = [...cards.filter((c) => cardKey(c.name) !== cardKey(prev ?? ch.card.name)), toStored(ch.card)];
    }
    await saveCards(db, who, list.map((ch) => ({ card: ch.card as CardInput, ...(typeof ch.previousName === 'string' ? { previousName: ch.previousName } : {}), link: posItemArg(ch.link), unlink: posItemArg(ch.unlink) })));
    return send(res, 200, { saved: list.length }), true;
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
    for (const item of posItemArg(b.items)) links = withAnswer(links, { type: 'notFood', ...item });
    await saveBook(db, who.restaurantId, 'linkAnswers', links, who.staffId);
    return send(res, 200, { ok: true }), true;
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
