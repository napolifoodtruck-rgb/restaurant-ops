/**
 * Prep: batches with dates, the nightly prep count, and what to do with expiring prep.
 *
 * Every batch a cook logs gets a prep date and a use-by date from the recipe's shelf
 * life. The nightly count lists batches oldest first and flags anything that won't make
 * it through tomorrow's service; discarding one is a single tap that logs the waste.
 */

import type { RecipeBook } from './recipes.ts';
import { tryConvert } from './units.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrepBatch {
  id: string;
  recipeId: string;
  /** What's left in the batch now (after tonight's count, when there is one). */
  amount: number;
  unit: string;
  preppedAt: Date;
  /** Undefined when the recipe has no shelf life set yet. */
  useBy?: Date;
}

/** A window of service, e.g. tomorrow 5–9 PM. */
export interface ServiceWindow {
  start: Date;
  end: Date;
}

export interface WasteEntry {
  recipeId: string;
  batchId?: string;
  amount: number;
  unit: string;
  reason: 'expired' | 'spoiled' | 'dropped' | 'mistake' | 'comp' | 'other';
  loggedAt: Date;
}

/** Use-by date for a batch prepped at a given time, from the recipe's shelf life. */
export function useByFor(book: RecipeBook, recipeId: string, preppedAt: Date): Date | undefined {
  const days = book.recipes.get(recipeId)?.shelfLifeDays;
  return days === undefined ? undefined : new Date(preppedAt.getTime() + days * DAY_MS);
}

/** Logs a new batch with its use-by date filled in. */
export function logBatch(book: RecipeBook, input: Omit<PrepBatch, 'useBy'> & { useBy?: Date }): PrepBatch {
  return { ...input, useBy: input.useBy ?? useByFor(book, input.recipeId, input.preppedAt) };
}

/**
 * expired: past its use-by now.
 * expiring: still good now, but won't last through the end of the next service.
 * good: lasts through the next service (or has no use-by date).
 */
export type BatchStatus = 'expired' | 'expiring' | 'good';

export function batchStatus(batch: PrepBatch, now: Date, nextService: ServiceWindow): BatchStatus {
  if (!batch.useBy) return 'good';
  if (batch.useBy.getTime() <= now.getTime()) return 'expired';
  if (batch.useBy.getTime() < nextService.end.getTime()) return 'expiring';
  return 'good';
}

export interface CountSheetLine {
  recipeId: string;
  name: string;
  /** The unit the recipe yields in, used for totals. */
  unit: string;
  /** Oldest first. */
  batches: { batch: PrepBatch; status: BatchStatus }[];
  /** Everything on hand, in the recipe's unit. Undefined if a batch's unit can't be converted. */
  total?: number;
  /** On hand that is still good through the next service. */
  usable?: number;
  needsAttention: boolean;
}

/**
 * The nightly prep count: one line per prepped item that has batches on hand, batches
 * oldest first. Lines follow the walk-in order when one is given (the order cooks
 * actually count in); anything not in that order comes after, alphabetically.
 */
export function nightlyCountSheet(book: RecipeBook, batches: PrepBatch[], now: Date, nextService: ServiceWindow, walkInOrder: string[] = []): CountSheetLine[] {
  const byRecipe = new Map<string, PrepBatch[]>();
  for (const batch of batches) {
    const list = byRecipe.get(batch.recipeId) ?? [];
    list.push(batch);
    byRecipe.set(batch.recipeId, list);
  }

  const lines: CountSheetLine[] = [];
  for (const [recipeId, list] of byRecipe) {
    const recipe = book.recipes.get(recipeId);
    const unit = recipe?.yield.unit ?? list[0]!.unit;
    const sorted = [...list].sort((a, b) => (a.useBy?.getTime() ?? Infinity) - (b.useBy?.getTime() ?? Infinity) || a.preppedAt.getTime() - b.preppedAt.getTime());
    const withStatus = sorted.map((batch) => ({ batch, status: batchStatus(batch, now, nextService) }));

    let total: number | undefined = 0;
    let usable: number | undefined = 0;
    for (const { batch, status } of withStatus) {
      const amount = tryConvert({ amount: batch.amount, unit: batch.unit }, unit, recipe?.conversions);
      if (amount === undefined) {
        total = undefined;
        usable = undefined;
        break;
      }
      total += amount;
      if (status === 'good') usable += amount;
    }

    lines.push({
      recipeId,
      name: recipe?.name ?? recipeId,
      unit,
      batches: withStatus,
      total,
      usable,
      needsAttention: withStatus.some(({ status }) => status !== 'good'),
    });
  }

  const position = new Map(walkInOrder.map((id, index) => [id, index]));
  return lines.sort((a, b) => {
    const pa = position.get(a.recipeId) ?? Infinity;
    const pb = position.get(b.recipeId) ?? Infinity;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
}

/** One tap on an expired batch: the waste entry it logs. */
export function discardBatch(batch: PrepBatch, now: Date, reason: WasteEntry['reason'] = 'expired'): WasteEntry {
  return { recipeId: batch.recipeId, batchId: batch.id, amount: batch.amount, unit: batch.unit, reason, loggedAt: now };
}
