/**
 * Real portions from purchases.
 *
 * Over a long enough stretch, what's bought is what's used (stock on hand barely moves
 * compared with two or three months of deliveries). When an ingredient goes into only one
 * dish that sells, the gap between purchases and what the card implies is that dish's
 * portion being different from the card: 120 lb of pepperoni over 1,114 servings is
 * 1.7 oz each, not the card's 3 oz. The app proposes the real portion; a manager confirms
 * it or weighs a few.
 *
 * Ingredients shared by several dishes, or used inside preps, can't be pinned on one dish
 * this way; counts and variance cover those. While some dishes still have no card, only
 * "bought less than the card says" is conclusive, unless a manager has said the ingredient
 * goes nowhere else.
 */

import type { ItemRef, RecipeBook } from './recipes.ts';
import type { Quantity } from './units.ts';

export interface PortionCheckInput {
  /** What sales say was used over the period, per product, in its base unit (dishes + modifiers). */
  expectedUse: ReadonlyMap<string, number>;
  /** What was bought over the same period, per product, in its base unit. */
  purchased: ReadonlyMap<string, number>;
  /** Portions of each dish recipe sold over the period. */
  dishesSold: ReadonlyMap<string, number>;
  /**
   * Whether anything sold in the period with no recipe yet. Those dishes may use the same
   * ingredients, so buying more than the card implies proves nothing then; buying less
   * still does, since dishes without cards can only add use.
   */
  unlinkedSales?: boolean;
  /** Products a manager confirmed go into nothing else ("lettuce is only in the House Salad"). */
  exclusive?: ReadonlySet<string>;
}

export interface PortionSuggestion {
  productId: string;
  productName: string;
  recipeId: string;
  recipeName: string;
  card: Quantity;
  suggested: Quantity;
  /** Purchased ÷ expected. */
  ratio: number;
  message: string;
}

export interface PortionCheckOptions {
  /** Purchases this far off the card (either way) are worth a question. Default 0.2. */
  gap?: number;
  /** Kitchen rounding per unit. */
  steps?: Readonly<Record<string, number>>;
  /** Ignore ingredients worth less than this over the period. Default $50. */
  minValue?: number;
}

const DEFAULT_STEPS: Record<string, number> = { oz: 0.25, g: 5, floz: 0.25, ml: 5, lb: 0.05, each: 0.5, tsp: 0.25, tbsp: 0.25, cup: 0.125 };

export function suggestPortions(book: RecipeBook, input: PortionCheckInput, options: PortionCheckOptions = {}): PortionSuggestion[] {
  const gap = options.gap ?? 0.2;
  const minValue = options.minValue ?? 50;
  const steps = { ...DEFAULT_STEPS, ...options.steps };

  // Every place each product appears directly, across dishes that sold and everything they use.
  const appearances = new Map<string, { recipeId: string; quantity: Quantity }[]>();
  const seen = new Set<string>();
  const visit = (recipeId: string) => {
    if (seen.has(recipeId)) return;
    seen.add(recipeId);
    const recipe = book.recipes.get(recipeId);
    if (!recipe) return;
    for (const line of recipe.ingredients) {
      if (line.item.kind === 'recipe') visit(line.item.id);
      else appearances.set(line.item.id, [...(appearances.get(line.item.id) ?? []), { recipeId, quantity: line.quantity }]);
    }
  };
  for (const [recipeId, sold] of input.dishesSold) if (sold > 0) visit(recipeId);

  const out: PortionSuggestion[] = [];
  for (const [productId, places] of appearances) {
    if (places.length !== 1) continue;
    const { recipeId, quantity } = places[0]!;
    const recipe = book.recipes.get(recipeId)!;
    if (recipe.kind !== 'dish') continue; // inside a prep: batch yields muddy it
    const expected = input.expectedUse.get(productId) ?? 0;
    const bought = input.purchased.get(productId) ?? 0;
    if (!(expected > 0) || !(bought > 0)) continue;
    const perUnit = book.unitCost(productId);
    if (perUnit !== undefined && expected * perUnit < minValue) continue;
    const ratio = bought / expected;
    if (Math.abs(ratio - 1) <= gap) continue;
    if (ratio > 1 && input.unlinkedSales && !input.exclusive?.has(productId)) continue;
    const step = steps[quantity.unit] ?? 0;
    const raw = quantity.amount * ratio;
    const amount = step > 0 ? Math.max(step, Math.round(raw / step) * step) : +raw.toPrecision(3);
    const product = book.products.get(productId)!;
    const fmt = (q: Quantity) => `${+q.amount.toFixed(3)} ${q.unit}`;
    out.push({
      productId,
      productName: product.name,
      recipeId,
      recipeName: recipe.name,
      card: quantity,
      suggested: { amount, unit: quantity.unit },
      ratio,
      message: `${recipe.name}: purchases of ${product.name} fit ${fmt({ amount, unit: quantity.unit })} a portion, the card says ${fmt(quantity)}. Use ${fmt({ amount, unit: quantity.unit })}, or weigh a few?`,
    });
  }
  return out.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
}

/** Changes one ingredient's amount in a recipe (a confirmed portion), returning new recipes. */
export function withIngredientAmount<R extends { id: string; ingredients: { item: ItemRef; quantity: Quantity }[] }>(recipes: readonly R[], recipeId: string, item: ItemRef, quantity: Quantity): R[] {
  return recipes.map((r) =>
    r.id !== recipeId ? r : { ...r, ingredients: r.ingredients.map((l) => (l.item.kind === item.kind && l.item.id === item.id ? { ...l, quantity } : l)) },
  );
}
