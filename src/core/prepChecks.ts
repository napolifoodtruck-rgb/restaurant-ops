/**
 * Two checks that run off the nightly prep count:
 *
 * Surplus specials: if a batch won't sell through before its use-by date at the expected
 * pace, suggest running a special that uses it, while there's still time.
 *
 * The daily prep check: tonight's count should equal last night's count, plus what was
 * prepped, minus what sales say was used, minus logged waste. Gaps are ranked by dollar
 * value so a big miss on proteins isn't buried under a small one on herbs.
 */

import type { RecipeBook } from './recipes.ts';
import type { PrepBatch } from './prep.ts';
import { tryConvert } from './units.ts';

export interface ServiceDemand {
  /** End of that day's service. A batch is usable for the day if its use-by is at or after this. */
  serviceEnd: Date;
  /** Expected use per prepped item that day, in each item's yield unit. */
  demand: ReadonlyMap<string, number>;
}

export interface SurplusSuggestion {
  recipeId: string;
  name: string;
  batchId: string;
  useBy: Date;
  /** Expected to be left when the batch expires, in the recipe's yield unit. */
  surplus: number;
  unit: string;
  /** Surplus as a share of the batch. */
  share: number;
  /** Ingredient cost of the surplus, when every price is known. */
  value?: number;
}

/**
 * Simulates the coming services, using the oldest usable batch first, and reports
 * batches expected to expire with a meaningful amount left. Only batches that expire
 * within the simulated days are judged; demand beyond that is unknown. Batches already
 * expired at `now` are left to the discard flow, not suggested as specials.
 */
export function surplusPrep(book: RecipeBook, batches: PrepBatch[], days: ServiceDemand[], now: Date, options: { minShare?: number } = {}): SurplusSuggestion[] {
  const minShare = options.minShare ?? 0.15;
  const ordered = [...days].sort((a, b) => a.serviceEnd.getTime() - b.serviceEnd.getTime());
  const horizon = ordered.at(-1)?.serviceEnd;
  if (!horizon) return [];

  const suggestions: SurplusSuggestion[] = [];
  const byRecipe = new Map<string, PrepBatch[]>();
  for (const batch of batches) {
    if (batch.useBy && batch.useBy.getTime() <= now.getTime()) continue;
    byRecipe.set(batch.recipeId, [...(byRecipe.get(batch.recipeId) ?? []), batch]);
  }

  for (const [recipeId, list] of byRecipe) {
    const recipe = book.recipes.get(recipeId);
    if (!recipe) continue;
    const unit = recipe.yield.unit;
    const remaining = new Map<string, number>();
    const sorted = [...list].sort((a, b) => (a.useBy?.getTime() ?? Infinity) - (b.useBy?.getTime() ?? Infinity));
    for (const batch of sorted) {
      remaining.set(batch.id, tryConvert({ amount: batch.amount, unit: batch.unit }, unit, recipe.conversions) ?? Number.NaN);
    }

    for (const day of ordered) {
      let need = day.demand.get(recipeId) ?? 0;
      for (const batch of sorted) {
        if (need <= 0) break;
        if (batch.useBy && batch.useBy.getTime() < day.serviceEnd.getTime()) continue; // expired by then
        const left = remaining.get(batch.id)!;
        if (!(left > 0)) continue;
        const used = Math.min(left, need);
        remaining.set(batch.id, left - used);
        need -= used;
      }
    }

    for (const batch of sorted) {
      // Still usable on the last simulated day: it may yet be used after that.
      if (!batch.useBy || batch.useBy.getTime() >= horizon.getTime()) continue;
      const left = remaining.get(batch.id)!;
      const start = tryConvert({ amount: batch.amount, unit: batch.unit }, unit, recipe.conversions);
      if (!start || !(left > 0)) continue;
      const share = left / start;
      if (share < minShare) continue;
      const cost = book.costOf({ kind: 'recipe', id: recipeId }, { amount: left, unit });
      suggestions.push({ recipeId, name: recipe.name, batchId: batch.id, useBy: batch.useBy, surplus: left, unit, share, value: cost.complete ? cost.total : undefined });
    }
  }

  return suggestions.sort((a, b) => a.useBy.getTime() - b.useBy.getTime());
}

export interface PrepCheckInput {
  /** Last night's count, per prepped item, in yield units. */
  previous: ReadonlyMap<string, number>;
  /** Logged today, per prepped item, in yield units. */
  prepped: ReadonlyMap<string, number>;
  /** Used according to today's sales (theoretical usage stopping at prep), in yield units. */
  used: ReadonlyMap<string, number>;
  /** Logged waste today, in yield units. */
  wasted: ReadonlyMap<string, number>;
  /** Tonight's count, in yield units. Items not counted are skipped, not treated as zero. */
  counted: ReadonlyMap<string, number>;
}

export interface PrepCheckLine {
  recipeId: string;
  name: string;
  unit: string;
  expected: number;
  counted: number;
  /** counted − expected: negative means less on hand than there should be. */
  difference: number;
  /** Dollar value of the difference, when every price is known. */
  value?: number;
}

/** Compares tonight's prep count with what it should be, largest dollar gaps first. */
export function prepCheck(book: RecipeBook, input: PrepCheckInput, options: { tolerance?: number } = {}): PrepCheckLine[] {
  const tolerance = options.tolerance ?? 0.05; // ignore gaps under 5% of expected
  const lines: PrepCheckLine[] = [];

  for (const [recipeId, counted] of input.counted) {
    const recipe = book.recipes.get(recipeId);
    if (!recipe) continue;
    const expected = (input.previous.get(recipeId) ?? 0) + (input.prepped.get(recipeId) ?? 0) - (input.used.get(recipeId) ?? 0) - (input.wasted.get(recipeId) ?? 0);
    const difference = counted - expected;
    if (Math.abs(difference) <= Math.max(Math.abs(expected) * tolerance, 1e-9)) continue;

    const cost = book.costOf({ kind: 'recipe', id: recipeId }, { amount: Math.abs(difference), unit: recipe.yield.unit });
    lines.push({
      recipeId,
      name: recipe.name,
      unit: recipe.yield.unit,
      expected,
      counted,
      difference,
      value: cost.complete ? Math.sign(difference) * cost.total : undefined,
    });
  }

  return lines.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
}
