/**
 * Real margins: what each dish actually sold for in the POS against what it costs to make
 * at today's invoice prices. Prices come from the POS, never typed in.
 *
 * Dishes are sorted into the four menu-engineering groups, compared only with their own
 * category (a salad isn't held to a pizza's margin):
 *  - star: sells well and earns well. Keep it as it is.
 *  - workhorse: sells well, earns less per plate. Look at portion or price first.
 *  - puzzle: earns well, sells slowly. Move it on the menu, have servers push it.
 *  - dog: sells slowly and earns less. A candidate to cut or rework.
 */

import type { CostResult, RecipeBook } from './recipes.ts';
import type { LinkLookup, SaleLine } from './sales.ts';

export type MenuClass = 'star' | 'workhorse' | 'puzzle' | 'dog';

export interface MarginSaleLine extends SaleLine {
  category?: string;
  /** Today's list price, from the POS catalog. */
  listPrice?: number;
}

export interface DishMargin {
  catalogId: string;
  recipeId: string;
  /** The name it sold under most. */
  name: string;
  category: string;
  quantity: number;
  netSales: number;
  /** Net sales ÷ quantity: what a plate really brought in after discounts and comps. */
  averagePrice: number;
  listPrice?: number;
  /**
   * How far the average sat below today's list price (0.05 = 5%): discounts and comps,
   * plus any price raise during the period. Paid add-ons count in the average, so it can be 0.
   */
  discountShare?: number;
  cost: CostResult;
  /** Cost ÷ average price: what the period actually ran. */
  foodCostShare: number;
  /** Cost ÷ today's list price: what it runs from now on. */
  listFoodCostShare?: number;
  /** Average price − cost: what each plate leaves to pay for everything else. */
  contribution: number;
  totalContribution: number;
  /** Undefined for staff meals and items with no sales. */
  menuClass?: MenuClass;
}

export interface StaffMealCost {
  catalogId: string;
  recipeId: string;
  name: string;
  quantity: number;
  cost: CostResult;
  totalCost: number;
}

export interface MarginReport {
  dishes: DishMargin[];
  staffMeals: StaffMealCost[];
  /** Sold items with no recipe yet, highest sales first. */
  unlinked: { catalogId: string; name: string; category: string; quantity: number; netSales: number }[];
  /** Totals over linked dishes with sales. */
  totals: { netSales: number; foodCost: number; foodCostShare: number; contribution: number };
  /** Share of all net sales covered by a linked recipe (0 to 1). */
  coverage: number;
}

export interface MarginOptions {
  /** Popular when a dish sells at least this share of its category's average. Default 0.7, the usual menu-engineering line. */
  popularityLine?: number;
  /** Lines with no catalog id (gift cards, custom amounts, fees) are left out of coverage. Default true. */
  skipNonMenu?: boolean;
}

export function menuMargins(book: RecipeBook, lookup: LinkLookup, sales: readonly MarginSaleLine[], options: MarginOptions = {}): MarginReport {
  const popularityLine = options.popularityLine ?? 0.7;
  const skipNonMenu = options.skipNonMenu ?? true;

  interface Group {
    catalogId: string;
    recipeId: string;
    portion?: { amount: number; unit: string };
    names: Map<string, number>;
    category: string;
    quantity: number;
    netSales: number;
    listPrice?: number;
  }
  const groups = new Map<string, Group>();
  const unlinked = new Map<string, MarginReport['unlinked'][number]>();
  let allSales = 0;
  let linkedSales = 0;

  for (const line of sales) {
    if (skipNonMenu && !line.catalogId) continue;
    allSales += line.netSales;
    const link = lookup(line.catalogId, line.name);
    const category = line.category ?? 'Other';
    if (!link) {
      const key = `${line.catalogId}|${line.name}`;
      const u = unlinked.get(key) ?? { catalogId: line.catalogId, name: line.name, category, quantity: 0, netSales: 0 };
      u.quantity += line.quantity;
      u.netSales += line.netSales;
      unlinked.set(key, u);
      continue;
    }
    linkedSales += line.netSales;
    // A renamed item that turned out to be a different dish keeps its own row.
    const key = `${line.catalogId}|${link.recipeId}`;
    const g = groups.get(key) ?? { catalogId: line.catalogId, recipeId: link.recipeId, portion: link.portion, names: new Map(), category, quantity: 0, netSales: 0, listPrice: line.listPrice };
    g.quantity += line.quantity;
    g.netSales += line.netSales;
    g.names.set(line.name, (g.names.get(line.name) ?? 0) + line.quantity);
    g.listPrice ??= line.listPrice;
    groups.set(key, g);
  }

  const dishes: DishMargin[] = [];
  const staffMeals: StaffMealCost[] = [];
  for (const g of groups.values()) {
    const name = [...g.names].sort((a, b) => b[1] - a[1])[0]![0];
    const recipe = book.recipes.get(g.recipeId);
    const cost = g.portion ? book.costOf({ kind: 'recipe', id: g.recipeId }, g.portion) : book.portionCost(g.recipeId);
    if (g.netSales <= 0 || g.quantity <= 0) {
      if (g.quantity > 0) staffMeals.push({ catalogId: g.catalogId, recipeId: g.recipeId, name, quantity: g.quantity, cost, totalCost: cost.total * g.quantity });
      continue;
    }
    const averagePrice = g.netSales / g.quantity;
    const contribution = averagePrice - cost.total;
    dishes.push({
      catalogId: g.catalogId,
      recipeId: g.recipeId,
      name: name ?? recipe?.name ?? g.recipeId,
      category: g.category,
      quantity: g.quantity,
      netSales: g.netSales,
      averagePrice,
      listPrice: g.listPrice,
      discountShare: g.listPrice ? Math.max(0, 1 - averagePrice / g.listPrice) : undefined,
      cost,
      foodCostShare: cost.total / averagePrice,
      ...(g.listPrice ? { listFoodCostShare: cost.total / g.listPrice } : {}),
      contribution,
      totalContribution: contribution * g.quantity,
    });
  }

  // Menu engineering, within each category.
  const byCategory = new Map<string, DishMargin[]>();
  for (const d of dishes) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);
  for (const list of byCategory.values()) {
    const units = list.reduce((s, d) => s + d.quantity, 0);
    const averageShare = 1 / list.length;
    const averageContribution = list.reduce((s, d) => s + d.totalContribution, 0) / units;
    for (const d of list) {
      const popular = d.quantity / units >= popularityLine * averageShare;
      const earns = d.contribution >= averageContribution;
      d.menuClass = popular ? (earns ? 'star' : 'workhorse') : earns ? 'puzzle' : 'dog';
    }
  }

  dishes.sort((a, b) => b.totalContribution - a.totalContribution);
  const netSales = dishes.reduce((s, d) => s + d.netSales, 0);
  const foodCost = dishes.reduce((s, d) => s + d.cost.total * d.quantity, 0);
  return {
    dishes,
    staffMeals,
    unlinked: [...unlinked.values()].sort((a, b) => b.netSales - a.netSales),
    totals: { netSales, foodCost, foodCostShare: netSales > 0 ? foodCost / netSales : 0, contribution: netSales - foodCost },
    coverage: allSales > 0 ? linkedSales / allSales : 0,
  };
}
