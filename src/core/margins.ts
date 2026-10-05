/**
 * Real margins: what each dish actually sold for in the POS against what it costs to make
 * at today's invoice prices. Prices come from the POS, never typed in.
 *
 * Dishes are judged by the money they bring in overall (what each plate leaves after food
 * cost × how many sold), not by the plate alone: a cheap-to-make pizza that sells all night
 * is the best thing on the menu even if a pricier one leaves more per plate. Within each
 * category (a salad isn't held to a pizza's numbers):
 *  - earner: the dishes that together bring in most of the category's money (80% by default).
 *    Protect them: portions, consistency, price.
 *  - sellMore: leaves at least the category's average per plate but sells too little to be an
 *    earner. Worth a push: servers, the specials board, a better spot on the menu.
 *  - minor: small money overall and below average per plate. A candidate to rework or cut.
 */

import type { CostResult, RecipeBook } from './recipes.ts';
import type { LinkLookup, SaleLine } from './sales.ts';

export type DishRole = 'earner' | 'sellMore' | 'minor';

export interface MarginSaleLine extends SaleLine {
  category?: string;
  /** Today's list price, from the POS catalog. */
  listPrice?: number;
}

export interface DishMargin {
  catalogId: string;
  recipeId: string;
  /**
   * The name it sold under most. When one POS button has carried several recipes (seasonal
   * versions), the recipe's name is added so each version reads as its own dish.
   */
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
  /** One plate as the recipe is written. */
  cost: CostResult;
  /** Modifiers' food cost per plate on average: add-ons less what "no X" saves. */
  modifierCost: number;
  /** Recipe cost + modifier cost: what an average plate really cost. */
  plateCost: number;
  /** Plate cost ÷ average price: what the period actually ran. */
  foodCostShare: number;
  /** Recipe cost ÷ today's list price: what the dish as written runs from now on. */
  listFoodCostShare?: number;
  /** Average price − cost: what each plate leaves to pay for everything else. */
  contribution: number;
  totalContribution: number;
  /** Share of its category's total contribution (0 to 1). */
  profitShare?: number;
  /** See the header. Undefined for staff meals and items with no sales. */
  role?: DishRole;
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
  /** Earners are the top dishes that together bring in this share of a category's contribution. Default 0.8. */
  earnerShare?: number;
  /** Lines with no catalog id (gift cards, custom amounts, fees) are left out of coverage. Default true. */
  skipNonMenu?: boolean;
  /** `${POS catalog id}|${recipe id}` → modifiers' total food cost over the same period (modifiers.ts byItem). */
  modifierCosts?: ReadonlyMap<string, number>;
}

export function menuMargins(book: RecipeBook, lookup: LinkLookup, sales: readonly MarginSaleLine[], options: MarginOptions = {}): MarginReport {
  const earnerShare = options.earnerShare ?? 0.8;
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
    const link = lookup(line.catalogId, line.name, line.date);
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
    const soldAs = [...g.names].sort((a, b) => b[1] - a[1])[0]![0];
    const shared = [...groups.values()].filter((other) => other.catalogId === g.catalogId).length > 1;
    const recipe = book.recipes.get(g.recipeId);
    const name = shared && recipe ? `${soldAs} (${recipe.name})` : soldAs;
    const cost = g.portion ? book.costOf({ kind: 'recipe', id: g.recipeId }, g.portion) : book.portionCost(g.recipeId);
    if (g.netSales <= 0 || g.quantity <= 0) {
      if (g.quantity > 0) staffMeals.push({ catalogId: g.catalogId, recipeId: g.recipeId, name, quantity: g.quantity, cost, totalCost: cost.total * g.quantity });
      continue;
    }
    const averagePrice = g.netSales / g.quantity;
    const modifierCost = (options.modifierCosts?.get(`${g.catalogId}|${g.recipeId}`) ?? 0) / g.quantity;
    const plateCost = cost.total + modifierCost;
    const contribution = averagePrice - plateCost;
    dishes.push({
      catalogId: g.catalogId,
      recipeId: g.recipeId,
      name,
      category: g.category,
      quantity: g.quantity,
      netSales: g.netSales,
      averagePrice,
      listPrice: g.listPrice,
      discountShare: g.listPrice ? Math.max(0, 1 - averagePrice / g.listPrice) : undefined,
      cost,
      modifierCost,
      plateCost,
      foodCostShare: plateCost / averagePrice,
      ...(g.listPrice ? { listFoodCostShare: cost.total / g.listPrice } : {}),
      contribution,
      totalContribution: contribution * g.quantity,
    });
  }

  // Roles, within each category, by total money brought in.
  const byCategory = new Map<string, DishMargin[]>();
  for (const d of dishes) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.totalContribution - a.totalContribution);
    const units = list.reduce((s, d) => s + d.quantity, 0);
    const total = list.reduce((s, d) => s + d.totalContribution, 0);
    const averagePerPlate = total / units;
    let before = 0;
    for (const d of list) {
      d.profitShare = total > 0 ? d.totalContribution / total : 0;
      // An earner if the dishes ahead of it haven't yet reached the earner share.
      if (total > 0 && before < earnerShare && d.totalContribution > 0) d.role = 'earner';
      else d.role = d.contribution >= averagePerPlate ? 'sellMore' : 'minor';
      before += d.profitShare;
    }
  }

  dishes.sort((a, b) => b.totalContribution - a.totalContribution);
  const netSales = dishes.reduce((s, d) => s + d.netSales, 0);
  const foodCost = dishes.reduce((s, d) => s + d.plateCost * d.quantity, 0);
  return {
    dishes,
    staffMeals,
    unlinked: [...unlinked.values()].sort((a, b) => b.netSales - a.netSales),
    totals: { netSales, foodCost, foodCostShare: netSales > 0 ? foodCost / netSales : 0, contribution: netSales - foodCost },
    coverage: allSales > 0 ? linkedSales / allSales : 0,
  };
}
