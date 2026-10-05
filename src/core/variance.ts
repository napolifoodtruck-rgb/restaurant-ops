/**
 * Counts and variance: what was really used against what sales say should have been used.
 *
 *   actual use   = opening count + purchases − closing count
 *   expected use = theoretical use from sales (recipes, modifiers) + logged waste
 *   variance     = actual use − expected use
 *
 * A positive variance is product that went somewhere the system can't explain: heavy
 * portioning, unlogged waste, a mistake in a recipe, a count error, or theft. A negative one
 * usually means a recipe overstates an ingredient or a delivery wasn't recorded.
 *
 * Counts can be skipped. Between real counts the app keeps a running estimate of what's on
 * hand (last real count + purchases − expected use − waste), used for ordering and for the
 * nightly sheet. Estimates never stand in for a count in the variance: the next real count
 * closes the whole period since the last real one.
 *
 * All amounts are in each product's base unit; dates are YYYY-MM-DD. A count is taken at
 * the end of its day, so movements on a count's date fall before it.
 */

import type { RecipeBook } from './recipes.ts';

export interface Movement {
  productId: string;
  date: string;
  amount: number;
}

export interface ProductCount extends Movement {
  /** Filled in for a skipped count; never used as a variance end point. */
  estimate?: boolean;
}

export interface VarianceInput {
  counts: readonly ProductCount[];
  purchases: readonly Movement[];
  /** Theoretical use from sales, by day. */
  expectedUse: readonly Movement[];
  waste: readonly Movement[];
}

const sumBetween = (moves: readonly Movement[], productId: string, after: string, upTo: string) =>
  moves.reduce((s, m) => (m.productId === productId && m.date > after && m.date <= upTo ? s + m.amount : s), 0);

const realCounts = (input: VarianceInput, productId: string) =>
  input.counts.filter((c) => c.productId === productId && !c.estimate).sort((a, b) => a.date.localeCompare(b.date));

export interface OnHandEstimate {
  amount: number;
  lastCount: ProductCount;
  purchased: number;
  expectedUse: number;
  wasted: number;
}

/** What should be on hand at the end of `asOf`, from the last real count before it. */
export function estimateOnHand(input: VarianceInput, productId: string, asOf: string): OnHandEstimate | undefined {
  const lastCount = realCounts(input, productId).filter((c) => c.date <= asOf).at(-1);
  if (!lastCount) return undefined;
  const purchased = sumBetween(input.purchases, productId, lastCount.date, asOf);
  const expectedUse = sumBetween(input.expectedUse, productId, lastCount.date, asOf);
  const wasted = sumBetween(input.waste, productId, lastCount.date, asOf);
  return { amount: Math.max(0, lastCount.amount + purchased - expectedUse - wasted), lastCount, purchased, expectedUse, wasted };
}

export interface PeriodVariance {
  productId: string;
  from: string;
  to: string;
  opening: number;
  purchased: number;
  closing: number;
  actualUse: number;
  expectedUse: number;
  wasted: number;
  /** Actual − (expected + waste). Positive: more went out than sales and waste explain. */
  variance: number;
  /** Variance ÷ (expected + waste). */
  share: number;
}

/** Variance between two real counts of a product. */
export function periodVariance(input: VarianceInput, productId: string, from: ProductCount, to: ProductCount): PeriodVariance {
  const purchased = sumBetween(input.purchases, productId, from.date, to.date);
  const expectedUse = sumBetween(input.expectedUse, productId, from.date, to.date);
  const wasted = sumBetween(input.waste, productId, from.date, to.date);
  const actualUse = from.amount + purchased - to.amount;
  const variance = actualUse - expectedUse - wasted;
  const basis = expectedUse + wasted;
  return { productId, from: from.date, to: to.date, opening: from.amount, purchased, closing: to.amount, actualUse, expectedUse, wasted, variance, share: basis > 0 ? variance / basis : variance === 0 ? 0 : Infinity };
}

export interface VarianceLine extends PeriodVariance {
  name: string;
  unit: string;
  /** Dollar value of the variance at today's price; undefined without a price. */
  value?: number;
  direction: 'over' | 'under';
  /** Dishes that use the product, to check portioning on. */
  usedIn: string[];
  /** Big enough, and counted recently enough, to be worth a recount first. */
  recount: boolean;
  message: string;
}

export interface VarianceOptions {
  /** Gaps under this share of expected use are noise. Default 0.05. */
  tolerance?: number;
  /** Gaps worth less than this aren't reported. Default $5. */
  minValue?: number;
  /** A gap over this share on the latest count suggests a recount. Default 0.25. */
  recountShare?: number;
  /** The latest count date, for recount suggestions. Default: the latest count in the input. */
  today?: string;
}

/**
 * Variance for every product with two real counts, over its latest period, worth reporting,
 * biggest dollar gap first.
 */
export function varianceReport(book: RecipeBook, input: VarianceInput, options: VarianceOptions = {}): VarianceLine[] {
  const tolerance = options.tolerance ?? 0.05;
  const minValue = options.minValue ?? 5;
  const recountShare = options.recountShare ?? 0.25;
  const today = options.today ?? input.counts.reduce((d, c) => (c.date > d ? c.date : d), '');
  const lines: VarianceLine[] = [];

  for (const productId of new Set(input.counts.map((c) => c.productId))) {
    const counts = realCounts(input, productId);
    if (counts.length < 2) continue;
    const period = periodVariance(input, productId, counts.at(-2)!, counts.at(-1)!);
    if (Math.abs(period.variance) < 1e-9 || Math.abs(period.share) <= tolerance) continue;
    const product = book.products.get(productId);
    const perUnit = book.unitCost(productId);
    const value = perUnit === undefined ? undefined : period.variance * perUnit;
    if (value !== undefined && Math.abs(value) < minValue) continue;

    const name = product?.name ?? productId;
    const unit = product?.baseUnit ?? '';
    const direction = period.variance > 0 ? 'over' : 'under';
    const usedIn = dishesUsing(book, productId);
    const amount = `${+Math.abs(period.variance).toFixed(2)} ${unit}`;
    const dollars = value === undefined ? '' : ` ($${Math.abs(value).toFixed(2)})`;
    const message =
      direction === 'over'
        ? `${amount} more ${name} went out than sales and waste explain${dollars}. Check portioning${usedIn.length ? ` on ${listed(usedIn)}` : ''}, look for unlogged waste, or recount.`
        : `${amount} less ${name} was used than sales say${dollars}. A recipe may overstate it, or a delivery wasn't recorded.`;
    lines.push({ ...period, name, unit, ...(value !== undefined ? { value } : {}), direction, usedIn, recount: period.to === today && Math.abs(period.share) > recountShare, message });
  }
  return lines.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
}

const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Dishes whose recipe uses the product, most of it first (up to three). */
function dishesUsing(book: RecipeBook, productId: string): string[] {
  const uses: { name: string; amount: number }[] = [];
  for (const recipe of book.recipes.values()) {
    if (recipe.kind !== 'dish') continue;
    const amount = book.explode({ kind: 'recipe', id: recipe.id }, recipe.yield).products.get(productId);
    if (amount && amount > 0) uses.push({ name: recipe.name, amount });
  }
  return uses.sort((a, b) => b.amount - a.amount).slice(0, 3).map((u) => u.name);
}
