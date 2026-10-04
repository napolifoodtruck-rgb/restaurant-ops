/**
 * Tomorrow's prep list.
 *
 *   to make = forecast demand + buffer − on hand that will still be good
 *
 * Demand for prepped items comes from tomorrow's dish forecast, broken down through the
 * recipes. Prepped items used inside other prepped items (chopped garlic in vodka sauce)
 * get demand from the batches that will actually be made, so the list is ordered with
 * those sub-preps first. Amounts round up to whole batches, since that's how cooks prep.
 */

import { type RecipeBook } from './recipes.ts';
import { theoreticalUsage, type MenuLinks } from './sales.ts';
import type { PrepBatch } from './prep.ts';
import { tryConvert } from './units.ts';

/** Demand for each prepped item, in its yield unit, from a forecast of portions per menu item. */
export function prepDemand(book: RecipeBook, links: MenuLinks, forecast: ReadonlyMap<string, number>): Map<string, number> {
  const sales = [...forecast].map(([catalogId, quantity]) => ({ catalogId, name: catalogId, quantity, netSales: 0 }));
  const { usage } = theoreticalUsage(book, links, sales, { stopAtPrep: true });
  const demand = new Map<string, number>();
  for (const [recipeId, amount] of usage.recipes) {
    if (book.recipes.get(recipeId)?.kind === 'prep') demand.set(recipeId, amount);
  }
  return demand;
}

export interface PrepListOptions {
  /** Extra on top of forecast demand. Default 0.1 (10%). */
  buffer?: number;
  /** Buffer when on-hand amounts are estimates because tonight's count was skipped. Default 0.2. */
  estimateBuffer?: number;
  onHandIsEstimate?: boolean;
  /** Round up to whole batches. Default true. */
  wholeBatches?: boolean;
}

export interface PrepListLine {
  recipeId: string;
  name: string;
  unit: string;
  /** Demand from dishes, buffer included. */
  forDishes: number;
  /** Demand from other prep being made tomorrow (no extra buffer: those batches already have it). */
  forOtherPrep: number;
  /** On hand that stays good through tomorrow's service. */
  onHand: number;
  toMake: number;
  /** Number of batches, when rounding to whole batches. */
  batches?: number;
  /** True when on-hand amounts are estimates. */
  estimated: boolean;
}

/**
 * Builds the prep list. `batches` are what's on hand after tonight's count; batches whose
 * use-by falls before `serviceEnd` don't count toward on hand.
 */
export function prepList(book: RecipeBook, directDemand: ReadonlyMap<string, number>, batches: PrepBatch[], serviceEnd: Date, options: PrepListOptions = {}): PrepListLine[] {
  const estimated = options.onHandIsEstimate ?? false;
  const buffer = estimated ? (options.estimateBuffer ?? 0.2) : (options.buffer ?? 0.1);
  const wholeBatches = options.wholeBatches ?? true;

  const order = parentsFirst(book);
  const fromParents = new Map<string, number>();
  const lines: PrepListLine[] = [];

  for (const recipeId of order) {
    const recipe = book.recipes.get(recipeId)!;
    const forDishes = (directDemand.get(recipeId) ?? 0) * (1 + buffer);
    const forOtherPrep = fromParents.get(recipeId) ?? 0;
    if (forDishes <= 0 && forOtherPrep <= 0) continue;

    const onHand = usableOnHand(book, recipeId, batches, serviceEnd);
    const shortfall = Math.max(0, forDishes + forOtherPrep - onHand);
    let toMake = shortfall;
    let batchCount: number | undefined;
    if (wholeBatches && shortfall > 0) {
      batchCount = Math.ceil(shortfall / recipe.yield.amount - 1e-9);
      toMake = batchCount * recipe.yield.amount;
    }

    // Making this creates demand for the prepped items inside it.
    if (toMake > 0) {
      const usage = book.explode({ kind: 'recipe', id: recipeId }, { amount: toMake, unit: recipe.yield.unit }, { stopAtPrep: true });
      for (const [childId, amount] of usage.recipes) {
        if (childId !== recipeId && book.recipes.get(childId)?.kind === 'prep') {
          fromParents.set(childId, (fromParents.get(childId) ?? 0) + amount);
        }
      }
    }

    lines.push({ recipeId, name: recipe.name, unit: recipe.yield.unit, forDishes, forOtherPrep, onHand, toMake, batches: batchCount, estimated });
  }

  // Cooks make sub-preps first: reverse of parents-first.
  return lines.reverse();
}

/** On hand for a prepped item that is still good at the end of the service, in its yield unit. */
export function usableOnHand(book: RecipeBook, recipeId: string, batches: PrepBatch[], serviceEnd: Date): number {
  const recipe = book.recipes.get(recipeId);
  if (!recipe) return 0;
  let total = 0;
  for (const batch of batches) {
    if (batch.recipeId !== recipeId) continue;
    if (batch.useBy && batch.useBy.getTime() < serviceEnd.getTime()) continue;
    total += tryConvert({ amount: batch.amount, unit: batch.unit }, recipe.yield.unit, recipe.conversions) ?? 0;
  }
  return total;
}

/**
 * Prepped items ordered so every item comes before the prepped items it uses.
 * Assumes no loops (RecipeBook.validate catches those).
 */
function parentsFirst(book: RecipeBook): string[] {
  const prep = [...book.recipes.values()].filter((r) => r.kind === 'prep');
  const prepIds = new Set(prep.map((r) => r.id));
  const parentCount = new Map<string, number>(prep.map((r) => [r.id, 0]));
  const children = new Map<string, string[]>();
  for (const recipe of prep) {
    const kids = new Set<string>();
    for (const ingredient of recipe.ingredients) {
      if (ingredient.item.kind === 'recipe' && prepIds.has(ingredient.item.id)) kids.add(ingredient.item.id);
    }
    children.set(recipe.id, [...kids]);
    for (const kid of kids) parentCount.set(kid, (parentCount.get(kid) ?? 0) + 1);
  }

  const ready = prep.filter((r) => parentCount.get(r.id) === 0).map((r) => r.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const kid of children.get(id) ?? []) {
      const remaining = parentCount.get(kid)! - 1;
      parentCount.set(kid, remaining);
      if (remaining === 0) ready.push(kid);
    }
  }
  return order;
}
