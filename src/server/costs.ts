/**
 * Following the money down a recipe, for managers:
 *
 *   GET /api/costs/dishes?area=               the menu with each plate's cost
 *   GET /api/costs/recipe/:id?amount=&unit=   a recipe's lines, each with its cost (for that amount)
 *   GET /api/costs/product/:id?amount=&unit=  an ingredient: what it costs, its price over time
 *                                             with the vendor each purchase came from, and the dishes it's in
 *   GET /api/costs/search?q=                  recipes and ingredients by name
 *   GET /api/costs/movers?area=               ingredients whose price moved most, by what it costs you
 *
 * Margherita → Pizza Dough → Flour: each step costs what the step above uses of it.
 */

import type { ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { areaFor, loadAreas } from './areas.ts';
import { getModel, loadBook, type Model } from './model.ts';
import { hasMarkers, treeAlerts, type Markers } from './treeAlerts.ts';
import { recipeChecks } from './recipeChecks.ts';
import { kindOf } from './cards.ts';
import { cardId } from '../core/recipeCards.ts';
import { priceHistory, purchaseKind } from '../core/costReports.ts';
import { squareModifierSales } from '../connectors/square.ts';
import { storedModifierSales } from './squareSync.ts';
import { purchasesOf } from './reports.ts';
import type { ItemRef } from '../core/recipes.ts';
import { costHistory, type PricePoint } from '../core/costHistory.ts';

const cents = (v: number) => Math.round(v * 100) / 100;

function quantityAsked(url: URL) {
  const amount = Number(url.searchParams.get('amount')), unit = url.searchParams.get('unit');
  return amount > 0 && unit ? { amount, unit } : undefined;
}

/** Every purchase of a product: per base unit (so packs and vendors compare), with the vendor. */
export function pricesOf(model: Model, productId: string) {
  const vendors = new Map(model.purchasing.vendors.map((v) => [v.externalId, v.name]));
  return model.purchasing.prices.filter((p) => p.productExternalId === productId).map((p) => ({
    date: p.date, ...(p.vendorExternalId && vendors.get(p.vendorExternalId) ? { vendor: vendors.get(p.vendorExternalId)! } : {}),
    perUnit: p.perBaseUnit, packPrice: p.price, pack: `${+p.per.amount.toFixed(3)} ${p.per.unit}`, quantity: p.quantity,
  }));
}

/** Each product's invoice prices by date (per base unit), worked out once per model. */
const pointsMemo = new WeakMap<Model, Map<string, PricePoint[]>>();
function pricePoints(model: Model): Map<string, PricePoint[]> {
  let m = pointsMemo.get(model);
  if (m) return m;
  m = new Map();
  for (const p of model.purchasing.prices) if (p.perBaseUnit > 0) m.set(p.productExternalId, [...(m.get(p.productExternalId) ?? []), { date: p.date.slice(0, 10), perUnit: p.perBaseUnit }]);
  for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  pointsMemo.set(model, m);
  return m;
}
/** A recipe's cost over time, as written today, from its ingredients' invoices. */
export function recipeCostHistory(model: Model, recipeId: string, today: string, opts: { weeks?: number; every?: number } = {}) {
  const recipe = model.book.recipes.get(recipeId);
  if (!recipe) return undefined;
  const cost = model.book.costOf({ kind: 'recipe', id: recipeId }, recipe.yield);
  const points = pricePoints(model);
  return costHistory({
    lines: cost.lines.filter((l) => !l.productId.startsWith('free-')).map((l) => ({ productId: l.productId, name: l.productName, amount: l.amount })),
    pricesOf: (id) => points.get(id) ?? [], priceNow: (id) => model.book.unitCost(id), today, ...opts,
  });
}

export async function costRoutes(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/costs/')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const model = await getModel(db, who.restaurantId, today);
  const book = model.book;

  if (path === '/api/costs/dishes') {
    const area = areaFor(who, url.searchParams.get('area'));
    const areaOf = await loadAreas(db, who.restaurantId);
    const dishes = model.margins.dishes.filter((d) => areaOf(d.category) === area && d.quantity > 0)
      .map((d) => ({ id: d.recipeId, name: d.name, category: d.category, plateCost: cents(d.cost.total), complete: d.cost.complete, price: cents(d.averagePrice), share: d.averagePrice > 0 ? d.cost.total / d.averagePrice : undefined, sold: Math.round(d.quantity) }));
    return send(res, 200, { area, dishes }), true;
  }

  if (path === '/api/costs/search') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (q.length < 2) return send(res, 200, { recipes: [], products: [] }), true;
    const recipes = [...book.recipes.values()].filter((r) => r.kind !== 'modifier' && r.name.toLowerCase().includes(q)).slice(0, 12).map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
    const products = [...book.products.values()].filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20)
      .map((p) => { const u = book.unitCost(p.id); return { id: p.id, name: p.name, unit: p.baseUnit, ...(u !== undefined ? { perUnit: Math.round(u * 10000) / 10000 } : {}) }; });
    return send(res, 200, { recipes, products }), true;
  }

  if (path === '/api/costs/movers') {
    const area = areaFor(who, url.searchParams.get('area'));
    const want = area === 'bar' ? 'bar' : 'food';
    const since = new Date(Date.parse(`${today}T12:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
    const rows = model.purchasing.products.filter((p) => purchaseKind(p.categoryType) === want).map((p) => {
      const points = pricesOf(model, p.externalId);
      const h = priceHistory(points, today);
      const spent = points.filter((x) => x.date >= since).reduce((a, x) => a + x.packPrice * x.quantity, 0);
      // What the change costs (or saves) at the last 90 days' buying.
      const impact = h.change90 !== undefined ? spent - spent / (1 + h.change90) : 0;
      return { id: p.externalId, name: p.name, unit: p.baseUnit, ...(h.latest !== undefined ? { perUnit: h.latest } : {}), ...(h.change90 !== undefined ? { change90: h.change90 } : {}), spent90: cents(spent), impact: cents(impact) };
    }).filter((r) => r.change90 !== undefined && Math.abs(r.change90) >= 0.03 && r.spent90 > 0);
    return send(res, 200, { area, up: rows.filter((r) => r.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 8), down: rows.filter((r) => r.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 5) }), true;
  }

  // One dish or drink, a layer down: its discount days (full price against each), or its add-ons
  // (the dish itself against each paid add-on; free changes counted apart). For the clickable charts.
  if (path === '/api/costs/breakdown') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const ranged = from && to && day.test(from) && day.test(to) && from <= to ? await getModel(db, who.restaurantId, to, { from, to }) : model;
    const recipeId = url.searchParams.get('recipeId'), name = url.searchParams.get('name');
    if (!recipeId && !name) throw new HttpError(400, 'Which dish?');
    const lines = ranged.sales.filter((l) => (recipeId ? ranged.lookup(l.catalogId, l.name, l.date)?.recipeId === recipeId : l.name === name));
    const ids = new Set(lines.map((l) => l.catalogId));
    const sales = lines.reduce((a, l) => a + l.netSales, 0), plates = lines.reduce((a, l) => a + l.quantity, 0);
    const versions = [...ids].flatMap((id) => ranged.folded.get(id) ?? []);
    for (const v of versions) ids.add(v.catalogId);
    const mods = new Map<string, { name: string; uses: number; sales: number }>();
    for (const l of squareModifierSales(await storedModifierSales(db, who.restaurantId, ranged.from, ranged.today))) {
      if (!ids.has(l.catalogId)) continue;
      const key = l.modifier.name;
      const x = mods.get(key) ?? { name: key.replace(/^[+-]+\s*/, ''), uses: 0, sales: 0 };
      x.uses += l.quantity; x.sales += l.sales;
      mods.set(key, x);
    }
    const paid = [...mods.values()].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales);
    const free = [...mods.values()].filter((x) => x.sales <= 0 && x.uses > 0).sort((a, b) => b.uses - a.uses);
    const fullPrice = sales - versions.reduce((a, v) => a + v.netSales, 0);
    return send(res, 200, {
      name: recipeId ? (book.recipes.get(recipeId)?.name ?? recipeId) : name, sales: cents(sales), plates: Math.round(plates),
      ...(versions.length ? { versions: [{ name: 'Full price', value: cents(fullPrice), quantity: Math.round(plates - versions.reduce((a, v) => a + v.quantity, 0)) }, ...versions.map((v) => ({ name: v.variationName || v.name, value: cents(v.netSales), quantity: Math.round(v.quantity) }))] } : {}),
      base: cents(sales - paid.reduce((a, x) => a + x.sales, 0)),
      addOns: paid.map((x) => ({ name: x.name, value: cents(x.sales), uses: Math.round(x.uses) })),
      free: free.slice(0, 12).map((x) => ({ name: x.name, uses: Math.round(x.uses) })),
    }), true;
  }

  // Where the money went: each vendor, and what was bought from them, over the last days asked for.
  if (path === '/api/costs/spend') {
    const both = url.searchParams.get('area') === 'both';
    const area = both ? 'both' : areaFor(who, url.searchParams.get('area'));
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 7), 365);
    const since = new Date(Date.parse(`${today}T12:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const want = (k: string) => (both ? k === 'food' || k === 'bar' : k === (area === 'bar' ? 'bar' : 'food'));
    const names = new Map(model.purchasing.products.map((p) => [p.externalId, p.name]));
    const vendors = new Map<string, { vendor: string; spent: number; items: Map<string, { id?: string; name: string; spent: number }> }>();
    for (const p of purchasesOf(model, since, today)) {
      if (!want(p.kind)) continue;
      const v = vendors.get(p.vendor ?? 'Unknown vendor') ?? { vendor: p.vendor ?? 'Unknown vendor', spent: 0, items: new Map() };
      v.spent += p.amount;
      const key = p.productId ?? 'other';
      const it = v.items.get(key) ?? { ...(p.productId ? { id: p.productId } : {}), name: p.productId ? names.get(p.productId) ?? 'Unnamed item' : 'Lines with no item', spent: 0 };
      it.spent += p.amount;
      v.items.set(key, it);
      vendors.set(v.vendor, v);
    }
    return send(res, 200, { area, days, from: since, to: today,
      vendors: [...vendors.values()].filter((v) => v.spent > 0).sort((a, b) => b.spent - a.spent).map((v) => ({ vendor: v.vendor, spent: cents(v.spent), items: [...v.items.values()].filter((i) => i.spent > 0).sort((a, b) => b.spent - a.spent).map((i) => ({ ...i, spent: cents(i.spent) })) })) }), true;
  }

  const dismissed = async () => ((await loadBook(db, who.restaurantId)).linkAnswers?.dismissed ?? []).map((d) => d.dedupeKey);

  // The Recipes home for managers: only what needs a look. Selling dishes with a marker anywhere
  // under them, recipes no selling dish uses that have one, counts for the tiles, and recent changes.
  if (path === '/api/costs/home') {
    const area = areaFor(who, url.searchParams.get('area'));
    const areaOf = await loadAreas(db, who.restaurantId);
    const gone = await dismissed();
    const alerts = treeAlerts(model, today, gone);
    const book2 = await loadBook(db, who.restaurantId);
    const sold = model.margins.dishes.filter((d) => areaOf(d.category) === area && d.quantity > 0);
    const seen = new Set<string>();
    const dishes = sold.filter((d) => !seen.has(d.recipeId) && seen.add(d.recipeId)).map((d) => ({
      id: d.recipeId, name: d.name, category: d.category, plateCost: cents(d.cost.total), complete: d.cost.complete,
      price: cents(d.averagePrice), share: d.averagePrice > 0 ? d.cost.total / d.averagePrice : undefined, markers: alerts.recipes.get(d.recipeId) ?? {},
    }));
    // Everything a selling dish (either side) reaches: the rest is "not under any dish".
    const reach = new Set<string>();
    const walk = (id: string) => { if (reach.has(id)) return; reach.add(id); for (const i of model.book.recipes.get(id)?.ingredients ?? []) if (i.item.kind === 'recipe') walk(i.item.id); };
    for (const d of model.margins.dishes) if (d.quantity > 0) walk(d.recipeId);
    const sideOfCard = (k: string) => (k === 'drink' || k === 'barPrep' ? 'bar' : 'kitchen');
    const others = (book2.recipeCards ?? []).filter((c) => sideOfCard(kindOf(c)) === area && !reach.has(cardId(c)))
      .map((c) => ({ id: cardId(c), name: c.name, kind: kindOf(c), markers: alerts.recipes.get(cardId(c)) ?? {} }))
      .filter((x) => hasMarkers(x.markers));
    const flagged = [...dishes.filter((d) => hasMarkers(d.markers)), ...others];
    const count = (k: keyof Markers) => flagged.filter((x) => x.markers[k]?.length).length;
    const checks = recipeChecks(model, today, gone);
    const unlinked = model.margins.unlinked.filter((u) => u.catalogId && u.netSales > 0 && areaOf(u.category) === area);
    const recent = (book2.recipeCards ?? []).filter((c) => c.updatedAt && sideOfCard(kindOf(c)) === area).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!)).slice(0, 6)
      .map((c) => ({ id: cardId(c), name: c.name, at: c.updatedAt, by: c.updatedBy }));
    return send(res, 200, {
      area, dishes: dishes.filter((d) => hasMarkers(d.markers)), allDishes: dishes.length, others,
      counts: { notBought: count('notBought'), noCost: count('noCost'), red: count('red'), yellow: count('yellow'), rough: count('rough'),
        checks: checks.notBought.filter((x) => x.side === area).length + checks.quietVendors.filter((x) => x.side === area).length + checks.notInRecipes.filter((x) => x.side === area).length,
        noRecipe: unlinked.length, noRecipeSales: Math.round(unlinked.reduce((a, u) => a + u.netSales, 0)) },
      recent,
    }), true;
  }
  // Every selling dish on a side, with its markers (the whole menu, when the manager wants it all).
  if (path === '/api/costs/menu') {
    const area = areaFor(who, url.searchParams.get('area'));
    const areaOf = await loadAreas(db, who.restaurantId);
    const alerts = treeAlerts(model, today, await dismissed());
    const seen = new Set<string>();
    const dishes = model.margins.dishes.filter((d) => areaOf(d.category) === area && d.quantity > 0 && !seen.has(d.recipeId) && seen.add(d.recipeId)).map((d) => ({
      id: d.recipeId, name: d.name, category: d.category, plateCost: cents(d.cost.total), complete: d.cost.complete,
      price: cents(d.averagePrice), share: d.averagePrice > 0 ? d.cost.total / d.averagePrice : undefined, markers: alerts.recipes.get(d.recipeId) ?? {},
    }));
    return send(res, 200, { area, dishes }), true;
  }

  // Cost over time: one recipe in full (a point a week for a year), or every dish on a side as a sparkline.
  let m = path.match(/^\/api\/costs\/history\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const h = recipeCostHistory(model, id, today);
    if (!h) throw new HttpError(404, 'No recipe by that name.');
    const dish = model.margins.dishes.find((d) => d.recipeId === id && d.quantity > 0);
    return send(res, 200, { id, ...h, ...(dish ? { price: cents(dish.listPrice ?? dish.averagePrice) } : {}) }), true;
  }
  if (path === '/api/costs/sparks') {
    const area = areaFor(who, url.searchParams.get('area'));
    const areaOf = await loadAreas(db, who.restaurantId);
    const out: Record<string, number[]> = {};
    for (const d of model.margins.dishes) {
      if (areaOf(d.category) !== area || !(d.quantity > 0) || out[d.recipeId]) continue;
      const h = recipeCostHistory(model, d.recipeId, today, { weeks: 52, every: 28 });
      if (h) out[d.recipeId] = h.points.map((p) => p.cost);
    }
    return send(res, 200, { sparks: out }), true;
  }

  m = path.match(/^\/api\/costs\/recipe\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const recipe = book.recipes.get(id);
    if (!recipe) throw new HttpError(404, 'No recipe by that name.');
    const asked = quantityAsked(url);
    const one = book.costOf({ kind: 'recipe', id }, recipe.yield);
    const forAsked = asked ? book.costOf({ kind: 'recipe', id }, asked) : one;
    // Every line scales with how much of the recipe the step above uses.
    const scale = asked && one.total > 0 ? forAsked.total / one.total : asked && asked.unit === recipe.yield.unit ? asked.amount / recipe.yield.amount : 1;
    const lines = recipe.ingredients.map((ing) => {
      const qty = { amount: ing.quantity.amount * scale, unit: ing.quantity.unit };
      const c = book.costOf(ing.item, qty);
      return { kind: ing.item.kind, id: ing.item.id, name: book.nameOf(ing.item), amount: Math.round(qty.amount * 1000) / 1000, unit: qty.unit, cost: cents(c.total), complete: c.complete };
    }).sort((a, b) => b.cost - a.cost);
    const dish = model.margins.dishes.find((d) => d.recipeId === id && d.quantity > 0);
    const usedIn = [...book.recipes.values()].filter((r) => r.ingredients.some((i) => i.item.kind === 'recipe' && i.item.id === id)).map((r) => ({ id: r.id, name: r.name }));
    const gone = await dismissed();
    const alerts = treeAlerts(model, today, gone);
    const lineMarkers = (l: (typeof lines)[number]): Markers => {
      if (l.kind === 'recipe') return alerts.recipes.get(l.id) ?? {};
      const own: Markers = { ...(alerts.products.get(l.id) ?? {}) };
      delete own.noCost;
      return l.complete ? own : { ...own, noCost: [l.name] };
    };
    const markers = alerts.recipes.get(id) ?? {};
    // The checks behind a "not bought lately" anywhere below, with their suggested swap.
    const stale = recipeChecks(model, today, gone).notBought.filter((x) => markers.notBought?.includes(x.name));
    return send(res, 200, {
      id, name: recipe.name, kind: recipe.kind, yield: recipe.yield, ...(asked ? { asked } : {}),
      total: cents(forAsked.total), complete: forAsked.complete, perBatch: cents(one.total),
      markers, stale, rough: model.rough.has(id),
      lines: lines.map((l) => ({ ...l, share: forAsked.total > 0 ? l.cost / forAsked.total : 0, markers: lineMarkers(l), ...(l.kind === 'product' && model.priceSource.get(l.id) ? { source: model.priceSource.get(l.id) } : {}) })),
      ...(dish ? { price: cents(dish.averagePrice), sold: Math.round(dish.quantity) } : {}),
      usedIn,
    }), true;
  }

  m = path.match(/^\/api\/costs\/product\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const product = book.products.get(id);
    if (!product) throw new HttpError(404, 'No ingredient by that name.');
    const asked = quantityAsked(url);
    const item: ItemRef = { kind: 'product', id };
    const perUnit = book.unitCost(id);
    const forAsked = asked ? book.costOf(item, asked) : undefined;
    const history = priceHistory(pricesOf(model, id), today);
    // The dishes it's in, and what a 10% price rise would cost over the last 90 days of plates.
    const dishes = model.margins.dishes.flatMap((d) => {
      const line = d.cost.lines.find((l) => l.productId === id);
      return line && d.quantity > 0 ? [{ id: d.recipeId, name: d.name, perPlate: line.amount, unit: product.baseUnit, costPerPlate: cents(line.cost ?? 0), plates: Math.round(d.quantity), share: d.cost.total > 0 ? (line.cost ?? 0) / d.cost.total : 0 }] : [];
    }).sort((a, b) => b.costPerPlate * b.plates - a.costPerPlate * a.plates);
    const usedIn = [...book.recipes.values()].filter((r) => r.ingredients.some((i) => i.item.kind === 'product' && i.item.id === id)).map((r) => ({ id: r.id, name: r.name }));
    const imported = model.purchasing.products.find((p) => p.externalId === id);
    return send(res, 200, {
      id, name: product.name, unit: product.baseUnit, ...(imported?.category ? { category: imported.category } : {}),
      ...(perUnit !== undefined ? { perUnit: Math.round(perUnit * 10000) / 10000 } : {}),
      ...(asked ? { asked, ...(forAsked ? { total: cents(forAsked.total) } : {}) } : {}),
      history, dishes, usedIn,
      ...(model.priceSource.get(id) ? { source: model.priceSource.get(id) } : {}),
      markers: treeAlerts(model, today, await dismissed()).products.get(id) ?? {},
      stale: recipeChecks(model, today, await dismissed()).notBought.filter((x) => x.productId === id),
      tenPercent: cents(dishes.reduce((a, d) => a + d.costPerPlate * d.plates, 0) * 0.1),
    }), true;
  }
  return false;
}
