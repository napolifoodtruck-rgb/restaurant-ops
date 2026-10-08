/**
 * Recipe cards: how the kitchen book holds a recipe (name, yields, ingredient lines, method), and
 * how a set of cards links up into costed recipes. Ingredient names are ingredient-list names or
 * the names of other recipes, so cards nest once all of them are loaded.
 *
 * Cards come in from the app's own recipe editor, from Claude's kitchen-book file, or from
 * MarginEdge's printed recipe PDFs (connectors/marginedgeRecipes.ts reads those).
 */

import type { Ingredient, Recipe } from './recipes.ts';
import { dimensionOf, tryConvert, type ItemConversions, type Quantity } from './units.ts';
import type { PurchasedProduct } from './purchasing.ts';

export interface CardIngredient {
  amount: number;
  unit: string;
  name: string;
  /** Usable share after trim, e.g. 85 for prosciutto. 100 when the card doesn't say. */
  yieldPercent: number;
  /** MarginEdge's cost for this line, when the card shows one. */
  cardCost?: number;
  /** Food, Prep, Alcohol, add on... */
  type?: string;
  note?: string;
  /** What the line was last matched to (another recipe, or an ingredient), kept so a rename follows. */
  recipeId?: string;
  productId?: string;
}

export interface RecipeCard {
  /** Its permanent id. Cards from a file have none until they're saved. */
  id?: string;
  name: string;
  /** "Menu items" on recipe cards; costing cards have only a type. */
  category?: string;
  /** Pizza, Appetizers, Prep... */
  recipeType?: string;
  /** Everything the recipe makes, as the card lists it: 30100 g, 2 tubs, 120 portions. */
  yields: Quantity[];
  shelfLifeDays?: number;
  menuPrice?: number;
  cardTotal?: number;
  ingredients: CardIngredient[];
  method?: string;
  /** Lines in the ingredient list that couldn't be read. */
  unreadLines: string[];
  layout: 'card' | 'costing';
  /**
   * Rough: still being worked out (R&D). It may have lines not matched to anything yet, or with no
   * amount or unit; managers see it, cooks don't. Absent: ready.
   */
  status?: 'rough';
  /** When it was last saved in the app, and by whom (for "recently changed"). */
  updatedAt?: string;
  updatedBy?: string;
}

export type RecipeImportIssue =
  | { type: 'unknownIngredient'; recipe: string; ingredient: string; suggestions: string[] }
  | { type: 'noYield'; recipe: string }
  | { type: 'unreadLine'; recipe: string; line: string }
  | { type: 'duplicateCard'; recipe: string }
  | { type: 'oddYieldPercent'; recipe: string; ingredient: string; yieldPercent: number };

export const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The id a card had before recipes had ids of their own (made from its name); still used for a card from a file. */
export function recipeId(name: string): string {
  return `me-${normalizeName(name).replace(/ /g, '-')}`;
}

/** A card's id: its own, or (a card from a file, not saved yet) the one made from its name. */
export const cardId = (card: Pick<RecipeCard, 'id' | 'name'>): string => card.id ?? recipeId(card.name);

/** Ingredients that cost nothing and aren't bought. */
export const FREE_PRODUCTS: PurchasedProduct[] = [
  { externalId: 'free-water', name: 'Water', baseUnit: 'ml', conversions: { gramsPerMl: 1 } },
  { externalId: 'free-ice', name: 'Ice', baseUnit: 'g', conversions: { gramsPerMl: 0.92 } },
];

/**
 * How a recipe's yields relate: "30100 Grams or 2 Tubs or 120 Portions" makes grams the
 * main yield, a tub 15050 g, and a portion (each) 250.8 g. The main yield is the first
 * one in weight or volume, so "1 Batch or 30 Ounces" is tracked in ounces.
 */
export function yieldsToConversions(yields: Quantity[]): { primary?: Quantity; conversions: ItemConversions } {
  const measured = yields.find((q) => dimensionOf(q.unit) === 'mass' || dimensionOf(q.unit) === 'volume');
  // "1 Batch or 30 Portions": tracked in portions, a batch is 30.
  const counted = yields.find((q) => dimensionOf(q.unit) === 'count');
  const primary = measured ?? counted ?? yields[0];
  const conversions: ItemConversions = {};
  if (!primary) return { conversions };

  for (const other of yields) {
    if (other === primary || !(other.amount > 0)) continue;
    const otherDimension = dimensionOf(other.unit);
    const primaryDimension = dimensionOf(primary.unit);
    if (!otherDimension) {
      // A kitchen unit: batch, tub, (1/3) pan.
      conversions.customUnits = { ...conversions.customUnits, [other.unit]: { amount: primary.amount / other.amount, unit: primary.unit } };
    } else if (otherDimension === 'count' && primaryDimension === 'mass') {
      const grams = tryConvert(primary, 'g');
      if (grams) conversions.gramsPerEach = grams / other.amount;
    } else if (otherDimension === 'count' && primaryDimension === 'volume') {
      conversions.customUnits = { ...conversions.customUnits, portion: { amount: primary.amount / other.amount, unit: primary.unit } };
    } else if (otherDimension !== primaryDimension && (otherDimension === 'mass' || primaryDimension === 'mass')) {
      const grams = tryConvert(otherDimension === 'mass' ? other : primary, 'g');
      const ml = tryConvert(otherDimension === 'mass' ? primary : other, 'ml');
      if (grams && ml) conversions.gramsPerMl = grams / ml;
    }
  }
  return { primary, conversions };
}

/**
 * Turns cards into recipes. Each ingredient links to another card (a sub-recipe) when one
 * has that name, otherwise to the MarginEdge product with that name. Quantities are scaled
 * up by the yield percentage (1.75 oz of prosciutto at 85% means buying 2.06 oz). Anything
 * unmatched is reported with the closest product names, ready to become a question.
 */
export interface BuildOptions {
  /**
   * Card ingredient name → product id, overriding the match by name: the dough's "Spice, Sea
   * Salt" is fine salt bought outside MarginEdge, not the Maldon flakes that share the name.
   */
  ingredientProducts?: Record<string, string>;
}

export function buildRecipes(cards: RecipeCard[], products: PurchasedProduct[], options: BuildOptions = {}): { recipes: Recipe[]; issues: RecipeImportIssue[] } {
  const told = new Map(Object.entries(options.ingredientProducts ?? {}).map(([name, productId]) => [normalizeName(name), productId]));
  const issues: RecipeImportIssue[] = [];
  const byName = new Map<string, RecipeCard>();
  for (const card of cards) {
    const key = normalizeName(card.name);
    if (byName.has(key)) issues.push({ type: 'duplicateCard', recipe: card.name });
    byName.set(key, card);
  }
  // Water and ice are always free, even if MarginEdge has an unpriced product by that name.
  const freeNames = new Set(FREE_PRODUCTS.map((p) => normalizeName(p.name)));
  const allProducts = [...products.filter((p) => !freeNames.has(normalizeName(p.name))), ...FREE_PRODUCTS];
  const productsByName = new Map(allProducts.map((p) => [normalizeName(p.name), p]));

  const recipes: Recipe[] = [];
  for (const card of byName.values()) {
    for (const line of card.unreadLines) issues.push({ type: 'unreadLine', recipe: card.name, line });
    const { primary, conversions } = yieldsToConversions(card.yields);
    if (!primary) issues.push({ type: 'noYield', recipe: card.name });

    const ingredients: Ingredient[] = [];
    const rough = card.status === 'rough';
    for (const ingredient of card.ingredients) {
      // A rough line with no amount or unit yet: a gap in the cost until it's filled in.
      if (!(ingredient.amount > 0) || !ingredient.unit) {
        ingredients.push({ item: { kind: 'product', id: `unfinished:${normalizeName(ingredient.name)}` }, quantity: { amount: 1, unit: 'each' } });
        continue;
      }
      let share = ingredient.yieldPercent / 100;
      if (!(share > 0) || share > 1) {
        issues.push({ type: 'oddYieldPercent', recipe: card.name, ingredient: ingredient.name, yieldPercent: ingredient.yieldPercent });
        share = 1;
      }
      const quantity = { amount: ingredient.amount / share, unit: ingredient.unit };
      const key = normalizeName(ingredient.name);
      if (told.has(key)) {
        ingredients.push({ item: { kind: 'product', id: told.get(key)! }, quantity });
      } else if (byName.has(key)) {
        ingredients.push({ item: { kind: 'recipe', id: cardId(byName.get(key)!) }, quantity });
      } else if (productsByName.has(key)) {
        ingredients.push({ item: { kind: 'product', id: productsByName.get(key)!.externalId }, quantity });
      } else {
        const candidates = [...byName.values()].map((c) => c.name).filter((n) => n !== card.name).concat(allProducts.map((p) => p.name));
        // A rough recipe's unmatched lines are on purpose (matched when it's finished): not a question.
        if (!rough) issues.push({ type: 'unknownIngredient', recipe: card.name, ingredient: ingredient.name, suggestions: closestNames(ingredient.name, candidates) });
        // Kept in the recipe so the gap stays visible: it reports as an unknown item until matched.
        ingredients.push({ item: { kind: 'product', id: `unmatched:${key}` }, quantity });
      }
    }

    const isPrep = /^prep/i.test(card.recipeType ?? '') || (!!card.category && !/menu/i.test(card.category));
    const isDish = !isPrep;
    recipes.push({
      id: cardId(card),
      name: card.name,
      kind: isDish ? 'dish' : 'prep',
      // Dishes are costed per portion.
      yield: isDish ? { amount: 1, unit: 'each' } : (primary ?? { amount: 1, unit: 'each' }),
      ingredients,
      conversions: isDish ? undefined : conversions,
      shelfLifeDays: card.shelfLifeDays,
    });
  }
  return { recipes, issues };
}

/** Up to three names sharing the most words with the ingredient, for "did you mean". */
function closestNames(name: string, candidates: string[]): string[] {
  const words = new Set(normalizeName(name).split(' ').filter((w) => w.length > 2));
  if (words.size === 0) return [];
  return [...new Set(candidates)]
    .map((candidate) => {
      const theirs = normalizeName(candidate).split(' ').filter((w) => w.length > 2);
      const shared = theirs.filter((w) => words.has(w) || [...words].some((own) => own.startsWith(w) || w.startsWith(own))).length;
      return { candidate, score: shared / Math.max(words.size, theirs.length, 1) };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.candidate);
}

/** Words that don't tell two dishes apart: "Katahdin Pizza" is the Katahdin. */
const FILLER = new Set(['pizza', 'pie', 'the', 'a', 'special', 'new', 'recipe', 'draft']);
const simpleName = (name: string) => normalizeName(name).split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w)).join(' ');
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
/** The same dish by name: the same but for "pizza", or a letter or two off (Khatadin, Katahdin). */
export function sameDishName(a: string, b: string): boolean {
  const x = simpleName(a), y = simpleName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  return short >= 5 && editDistance(x, y) <= (short >= 8 ? 2 : 1);
}
