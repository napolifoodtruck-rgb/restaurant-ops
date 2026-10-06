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
import { getModel, type Model } from './model.ts';
import { priceHistory, purchaseKind } from '../core/costReports.ts';
import type { ItemRef } from '../core/recipes.ts';

const cents = (v: number) => Math.round(v * 100) / 100;

function quantityAsked(url: URL) {
  const amount = Number(url.searchParams.get('amount')), unit = url.searchParams.get('unit');
  return amount > 0 && unit ? { amount, unit } : undefined;
}

/** Every purchase of a product: per base unit (so packs and vendors compare), with the vendor. */
function pricesOf(model: Model, productId: string) {
  const vendors = new Map(model.imported.vendors.map((v) => [v.externalId, v.name]));
  return model.imported.prices.filter((p) => p.productExternalId === productId).map((p) => ({
    date: p.date, ...(p.vendorExternalId && vendors.get(p.vendorExternalId) ? { vendor: vendors.get(p.vendorExternalId)! } : {}),
    perUnit: p.perBaseUnit, packPrice: p.price, pack: `${+p.per.amount.toFixed(3)} ${p.per.unit}`, quantity: p.quantity,
  }));
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
    const rows = model.imported.products.filter((p) => purchaseKind(p.categoryType) === want).map((p) => {
      const points = pricesOf(model, p.externalId);
      const h = priceHistory(points, today);
      const spent = points.filter((x) => x.date >= since).reduce((a, x) => a + x.packPrice * x.quantity, 0);
      // What the change costs (or saves) at the last 90 days' buying.
      const impact = h.change90 !== undefined ? spent - spent / (1 + h.change90) : 0;
      return { id: p.externalId, name: p.name, unit: p.baseUnit, ...(h.latest !== undefined ? { perUnit: h.latest } : {}), ...(h.change90 !== undefined ? { change90: h.change90 } : {}), spent90: cents(spent), impact: cents(impact) };
    }).filter((r) => r.change90 !== undefined && Math.abs(r.change90) >= 0.03 && r.spent90 > 0);
    return send(res, 200, { area, up: rows.filter((r) => r.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 8), down: rows.filter((r) => r.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 5) }), true;
  }

  let m = path.match(/^\/api\/costs\/recipe\/(.+)$/);
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
    return send(res, 200, {
      id, name: recipe.name, kind: recipe.kind, yield: recipe.yield, ...(asked ? { asked } : {}),
      total: cents(forAsked.total), complete: forAsked.complete, perBatch: cents(one.total),
      lines: lines.map((l) => ({ ...l, share: forAsked.total > 0 ? l.cost / forAsked.total : 0 })),
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
    const imported = model.imported.products.find((p) => p.externalId === id);
    return send(res, 200, {
      id, name: product.name, unit: product.baseUnit, ...(imported?.category ? { category: imported.category } : {}),
      ...(perUnit !== undefined ? { perUnit: Math.round(perUnit * 10000) / 10000 } : {}),
      ...(asked ? { asked, ...(forAsked ? { total: cents(forAsked.total) } : {}) } : {}),
      history, dishes, usedIn,
      tenPercent: cents(dishes.reduce((a, d) => a + d.costPerPlate * d.plates, 0) * 0.1),
    }), true;
  }
  return false;
}
