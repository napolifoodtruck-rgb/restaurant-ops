/**
 * Recipe checks from invoices (see core/ingredientChecks.ts): what the menu uses but hasn't been
 * bought in far too long, with the likely replacement, and what's bought every week but sits in
 * no recipe. Shown on Recipe checks and in Needs you; answered there (swap, or "it's right").
 */

import { boughtNotInRecipes, notBoughtLately, quietVendors, type QuietVendor, type ProductKind, type Bought, type CheckProduct, type NotBought, type NotInRecipes, type WeeklyUse } from '../core/ingredientChecks.ts';
import { purchaseKind } from '../core/costReports.ts';
import { packBaseOf } from '../core/purchasing.ts';
import { dimensionOf } from '../core/units.ts';
import type { Model } from './model.ts';

export const notBoughtKey = (productId: string) => `ingredient:notBought:${productId}`;
export const notInRecipesKey = (productId: string) => `ingredient:notInRecipe:${productId}`;
/** Keyed by the last invoice too: answered once, it asks again if they go quiet again later. */
export const quietVendorKey = (vendorId: string, lastDate: string) => `vendor:quiet:${vendorId}:${lastDate}`;

export interface RecipeChecks {
  notBought: (NotBought & { side: 'kitchen' | 'bar'; recipes: string[] })[];
  notInRecipes: (NotInRecipes & { side: 'kitchen' | 'bar' })[];
  quietVendors: (QuietVendor & { side: 'kitchen' | 'bar' })[];
}

const memo = new WeakMap<Model, Map<string, RecipeChecks>>();

export function recipeChecks(model: Model, today: string, dismissed: string[] = []): RecipeChecks {
  const key = dismissed.join('|');
  const hit = memo.get(model)?.get(key);
  if (hit) return hit;

  const kindOf = new Map(model.purchasing.products.map((p) => [p.externalId, purchaseKind(p.categoryType)]));
  const products: CheckProduct[] = model.products.filter((p) => !p.id.startsWith('free-')).map((p) => {
    const unitPrice = model.book.unitCost(p.id);
    const dimension = dimensionOf(p.baseUnit);
    return { id: p.id, name: p.name, baseUnit: p.baseUnit, kind: kindOf.get(p.id) ?? 'other', ...(unitPrice !== undefined ? { unitPrice } : {}), ...(dimension ? { dimension } : {}) };
  });
  const vendorName = new Map(model.purchasing.vendors.map((v) => [v.externalId, v.name]));
  // Anything that came in counts as bought, the garden's free herbs too.
  const bought: Bought[] = model.purchasing.prices.filter((pt) => packBaseOf(pt) > 0).map((pt) => ({
    productId: pt.productExternalId, date: pt.date, invoiceId: pt.invoiceExternalId,
    packBase: packBaseOf(pt), packs: pt.quantity, dollars: pt.price * pt.quantity,
    ...(pt.vendorExternalId && vendorName.get(pt.vendorExternalId) ? { vendor: vendorName.get(pt.vendorExternalId)! } : {}),
  }));

  // Weekly use from dishes still on the menu: each plate as the recipe says, times plates sold.
  const onMenu = new Set(model.entries.filter((e) => e.recipeId && (!e.endsOn || e.endsOn >= today)).map((e) => e.recipeId!));
  const start = model.dataFrom && model.dataFrom > model.from ? model.dataFrom : model.from;
  const weeks = Math.max(1, ((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000 + 1) / 7);
  const use = new Map<string, { perWeek: number; byDish: Map<string, number> }>();
  for (const d of model.margins.dishes) {
    if (!onMenu.has(d.recipeId) || !(d.quantity > 0)) continue;
    for (const l of d.cost.lines) {
      if (!(l.amount > 0)) continue;
      const u = use.get(l.productId) ?? { perWeek: 0, byDish: new Map<string, number>() };
      const amount = (l.amount * d.quantity) / weeks;
      u.perWeek += amount;
      u.byDish.set(d.name, (u.byDish.get(d.name) ?? 0) + amount);
      use.set(l.productId, u);
    }
  }
  const uses: WeeklyUse[] = [...use].map(([productId, u]) => ({ productId, perWeek: u.perWeek, dishes: [...u.byDish].sort((a, b) => b[1] - a[1]).map(([n]) => n) }));

  // Which recipes name each product directly (what a swap changes).
  const recipesOf = new Map<string, string[]>();
  for (const r of model.recipes) {
    for (const id of new Set(r.ingredients.filter((i) => i.item.kind === 'product').map((i) => i.item.id))) recipesOf.set(id, [...(recipesOf.get(id) ?? []), r.name]);
  }
  const invoicesFrom = model.purchasing.invoices.map((i) => i.invoiceDate).filter(Boolean).sort()[0];
  // Not ingredients: deposits, fees and delivery charges ride on food and bar invoices too.
  const notFood = /\b(deposit|fee|charge|delivery|fuel|surcharge|credit)\b/i;
  const input = { products: products.filter((p) => !notFood.test(p.name)), bought, uses, inRecipes: new Set(recipesOf.keys()), recipesOf, today, ...(invoicesFrom ? { invoicesFrom } : {}) };
  const gone = new Set(dismissed);
  const sideOf = (kind: string) => (kind === 'bar' ? 'bar' as const : 'kitchen' as const);
  const result: RecipeChecks = {
    notBought: notBoughtLately(input).filter((x) => !gone.has(notBoughtKey(x.productId)))
      .map((x) => ({ ...x, side: sideOf(kindOf.get(x.productId) ?? 'food'), recipes: (recipesOf.get(x.productId) ?? []).sort() })),
    notInRecipes: boughtNotInRecipes(input).filter((x) => !gone.has(notInRecipesKey(x.productId))).map((x) => ({ ...x, side: sideOf(x.kind) })),
    // Vendors gone quiet: food and bar only (a cleaning supplier skipping a month doesn't touch food cost).
    // The garden goes quiet every winter; that's not a vendor to chase.
    quietVendors: quietVendors(model.purchasing.invoices.filter((i) => i.invoiceDate && !i.isCredit && (i.vendorExternalId || i.vendorName) && !(i.vendorExternalId && model.gardenVendors.has(i.vendorExternalId))).map((i) => {
      const kinds = i.lines.map((l) => (l.productExternalId ? kindOf.get(l.productExternalId) : undefined)).filter((k): k is ProductKind => Boolean(k));
      const kind = (['food', 'bar', 'other'] as const).map((k) => [k, kinds.filter((x) => x === k).length] as const).sort((a, b) => b[1] - a[1])[0]!;
      return { vendorId: i.vendorExternalId ?? i.vendorName!, vendor: (i.vendorName ?? 'A vendor').replace(/\s+/g, ' ').trim(), date: i.invoiceDate!, kind: kind[1] ? kind[0] : 'other' };
    }), today).filter((v) => v.kind !== 'other' && !gone.has(quietVendorKey(v.vendorId, v.lastDate))).map((v) => ({ ...v, side: sideOf(v.kind) })),
  };
  const m = memo.get(model) ?? new Map<string, RecipeChecks>();
  m.set(key, result);
  memo.set(model, m);
  return result;
}
