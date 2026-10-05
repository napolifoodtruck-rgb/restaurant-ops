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
export type LinkLookup = (catalogId: string, name: string) => { recipeId: string; portion?: Quantity } | undefined;

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
    const link = lookup(line.catalogId, line.name);
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
