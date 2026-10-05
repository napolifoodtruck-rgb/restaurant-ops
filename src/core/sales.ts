/**
 * Turns POS sales into theoretical usage.
 *
 * Recipes attach directly to POS menu items and modifiers (Square catalog object
 * ids), so there is no separate "dish" to create and nothing to link by hand.
 * Items without a recipe yet are reported, ranked by sales, so the system knows
 * which recipe to ask the chef about next.
 */

import { emptyUsage, mergeUsage, type RecipeBook, type Usage } from './recipes.ts';
import type { Quantity } from './units.ts';

/** POS catalog object id → recipe id. */
export interface MenuLinks {
  items: Record<string, string>;
  modifiers: Record<string, string>;
}

/**
 * Resolves one sold item, by POS id and the name it sold under, to the recipe it uses
 * (see menuLinks.ts). The portion defaults to one yield of the recipe.
 */
export type LinkLookup = (catalogId: string, name: string, date?: string) => { recipeId: string; portion?: Quantity } | undefined;

/** Fixed links, or a lookup that also checks names (so renamed items aren't counted blindly). */
export type Links = MenuLinks | { lookup: LinkLookup; modifiers?: Record<string, string> };

export function toLookup(links: Links): LinkLookup {
  if ('lookup' in links) return links.lookup;
  return (catalogId) => {
    const recipeId = links.items[catalogId];
    return recipeId === undefined ? undefined : { recipeId };
  };
}

/** One menu item sold, summed over a period: neutral across POS systems. */
export interface SaleLine {
  catalogId: string;
  name: string;
  quantity: number;
  /** Net sales for these items, used to rank missing recipes and measure coverage. */
  netSales: number;
  /** Day sold (YYYY-MM-DD), when sales come by day: picks the recipe version served that day. */
  date?: string;
  /** Modifiers applied to all of the quantity above. */
  modifiers?: { catalogId: string; name: string }[];
}

export interface UnmappedItem {
  catalogId: string;
  name: string;
  quantity: number;
  netSales: number;
}

export interface TheoreticalUsage {
  usage: Usage;
  /** Menu items with no recipe yet, highest sales first. */
  unmappedItems: UnmappedItem[];
  /** Modifiers with no recipe yet, most used first. */
  unmappedModifiers: { catalogId: string; name: string; quantity: number }[];
  /** Share of net sales covered by a recipe (0 to 1). */
  coverage: number;
}

export function theoreticalUsage(book: RecipeBook, links: Links, sales: SaleLine[], options: { stopAtPrep?: boolean } = {}): TheoreticalUsage {
  const lookup = toLookup(links);
  const modifierLinks = links.modifiers ?? {};
  const usage = emptyUsage();
  const unmapped = new Map<string, UnmappedItem>();
  const unmappedModifiers = new Map<string, { catalogId: string; name: string; quantity: number }>();
  let totalSales = 0;
  let coveredSales = 0;

  const add = (recipeId: string, sold: number, portion?: Quantity): void => {
    // One sale is one yield of the recipe unless the link says how much.
    const per = portion ?? book.recipes.get(recipeId)?.yield ?? { amount: 1, unit: 'each' };
    mergeUsage(usage, book.explode({ kind: 'recipe', id: recipeId }, { amount: per.amount * sold, unit: per.unit }, options));
  };

  for (const line of sales) {
    totalSales += line.netSales;
    const link = lookup(line.catalogId, line.name, line.date);
    if (link === undefined) {
      const existing = unmapped.get(line.catalogId) ?? { catalogId: line.catalogId, name: line.name, quantity: 0, netSales: 0 };
      existing.quantity += line.quantity;
      existing.netSales += line.netSales;
      unmapped.set(line.catalogId, existing);
    } else {
      coveredSales += line.netSales;
      add(link.recipeId, line.quantity, link.portion);
    }

    for (const modifier of line.modifiers ?? []) {
      const modifierRecipe = modifierLinks[modifier.catalogId];
      if (modifierRecipe === undefined) {
        const existing = unmappedModifiers.get(modifier.catalogId) ?? { catalogId: modifier.catalogId, name: modifier.name, quantity: 0 };
        existing.quantity += line.quantity;
        unmappedModifiers.set(modifier.catalogId, existing);
      } else {
        add(modifierRecipe, line.quantity);
      }
    }
  }

  return {
    usage,
    unmappedItems: [...unmapped.values()].sort((a, b) => b.netSales - a.netSales),
    unmappedModifiers: [...unmappedModifiers.values()].sort((a, b) => b.quantity - a.quantity),
    coverage: totalSales > 0 ? coveredSales / totalSales : 0,
  };
}

export interface SellingSpan {
  catalogId: string;
  name: string;
  /** First and last day sold (YYYY-MM-DD). */
  first: string;
  last: string;
  quantity: number;
  /** Days with at least one sale. */
  days: number;
}

/**
 * First and last day each POS item sold under each name, from daily sales. For a dish that
 * sells every day it's open, these are the dates it was on the menu: the start dates for
 * seasonal recipe versions come from here rather than from anyone's memory.
 */
export function sellingSpans(sales: readonly SaleLine[]): SellingSpan[] {
  const spans = new Map<string, SellingSpan>();
  for (const line of sales) {
    if (!line.date || !(line.quantity > 0)) continue;
    const key = `${line.catalogId}|${line.name}`;
    const span = spans.get(key);
    if (!span) {
      spans.set(key, { catalogId: line.catalogId, name: line.name, first: line.date, last: line.date, quantity: line.quantity, days: 1 });
      continue;
    }
    if (line.date < span.first) span.first = line.date;
    if (line.date > span.last) span.last = line.date;
    span.quantity += line.quantity;
    span.days++;
  }
  return [...spans.values()].sort((a, b) => a.first.localeCompare(b.first) || a.name.localeCompare(b.name));
}
