/**
 * The recipe engine: the bridge between what the restaurant buys and what it sells.
 *
 * Recipes can use products (bought from vendors) or other recipes, at any depth:
 * garlic → chopped garlic → vodka sauce → rigatoni alla vodka. The engine can
 * break any quantity of any item down to the raw products it consumes, cost it,
 * and turn a day of Square sales into expected usage.
 *
 * It is built to tolerate incomplete data. A missing conversion, a missing price
 * or an unknown ingredient never stops a calculation: the affected branch is
 * skipped and reported as an Issue, which the rest of the system turns into a
 * question for whoever can answer it.
 */

import { ConversionError, convert, tryConvert, type ItemConversions, type MissingFact, type Quantity } from './units.ts';

export type ItemRef = { kind: 'product'; id: string } | { kind: 'recipe'; id: string };

export interface Product {
  id: string;
  name: string;
  /** The unit usage and stock are tracked in for this product, e.g. "lb" or "each". */
  baseUnit: string;
  conversions?: ItemConversions;
  /** Latest price: e.g. $30 per 5 lb. Undefined until an invoice provides one. */
  cost?: { price: number; per: Quantity };
}

export type RecipeKind = 'prep' | 'dish' | 'modifier';

export interface Ingredient {
  item: ItemRef;
  /** Negative amounts are allowed in modifier recipes, e.g. a side swap removing fries. */
  quantity: Quantity;
}

export interface Recipe {
  id: string;
  name: string;
  /** prep: made ahead and stored. dish: one menu item portion. modifier: a change to a dish. */
  kind: RecipeKind;
  /** What one batch makes. Dishes and modifiers yield portions, normally { amount: 1, unit: 'each' }. */
  yield: Quantity;
  ingredients: Ingredient[];
  /** Conversions for the recipe's output, e.g. the density of chopped garlic. */
  conversions?: ItemConversions;
  shelfLifeDays?: number;
}

export type Issue =
  | { type: 'unknownItem'; item: ItemRef; usedIn: string }
  | { type: 'cycle'; path: string[] }
  | { type: 'missingConversion'; item: ItemRef; itemName: string; from: string; to: string; needed: MissingFact }
  | { type: 'missingCost'; productId: string; productName: string };

function issueKey(issue: Issue): string {
  switch (issue.type) {
    case 'unknownItem':
      return `unknown:${issue.item.kind}:${issue.item.id}:${issue.usedIn}`;
    case 'cycle':
      return `cycle:${issue.path.join('>')}`;
    case 'missingConversion':
      return `conversion:${issue.item.kind}:${issue.item.id}:${issue.from}:${issue.to}`;
    case 'missingCost':
      return `cost:${issue.productId}`;
  }
}

/** Collects issues once each, however many times the same gap is hit. */
export class IssueList {
  readonly #byKey = new Map<string, Issue>();

  add(issue: Issue): void {
    const key = issueKey(issue);
    if (!this.#byKey.has(key)) this.#byKey.set(key, issue);
  }

  addAll(issues: Iterable<Issue>): void {
    for (const issue of issues) this.add(issue);
  }

  toArray(): Issue[] {
    return [...this.#byKey.values()];
  }

  get size(): number {
    return this.#byKey.size;
  }
}

export interface Usage {
  /** Raw product usage, in each product's baseUnit. */
  products: Map<string, number>;
  /** Recipe usage along the way (prepped items, dishes), in each recipe's yield unit. */
  recipes: Map<string, number>;
  issues: IssueList;
}

export function emptyUsage(): Usage {
  return { products: new Map(), recipes: new Map(), issues: new IssueList() };
}

function addTo(map: Map<string, number>, id: string, amount: number): void {
  map.set(id, (map.get(id) ?? 0) + amount);
}

export function mergeUsage(target: Usage, source: Usage): Usage {
  for (const [id, amount] of source.products) addTo(target.products, id, amount);
  for (const [id, amount] of source.recipes) addTo(target.recipes, id, amount);
  target.issues.addAll(source.issues.toArray());
  return target;
}

export interface ExplodeOptions {
  /**
   * Stop at prepped items instead of descending to raw products. Used for the
   * prep-to-plate check: sales should consume prepped items at the rate the
   * nightly prep count shows.
   */
  stopAtPrep?: boolean;
}

export interface CostLine {
  productId: string;
  productName: string;
  /** Amount in the product's baseUnit. */
  amount: number;
  /** Undefined when the product has no usable price yet. */
  cost?: number;
}

export interface CostResult {
  /** Sum of the lines that could be costed. */
  total: number;
  /** False when any ingredient is missing a price, a conversion or a definition. */
  complete: boolean;
  lines: CostLine[];
  issues: Issue[];
}

export class RecipeBook {
  readonly products: ReadonlyMap<string, Product>;
  readonly recipes: ReadonlyMap<string, Recipe>;

  constructor(products: Iterable<Product>, recipes: Iterable<Recipe>) {
    this.products = new Map([...products].map((p) => [p.id, p]));
    this.recipes = new Map([...recipes].map((r) => [r.id, r]));
  }

  nameOf(item: ItemRef): string {
    const found = item.kind === 'product' ? this.products.get(item.id) : this.recipes.get(item.id);
    return found?.name ?? `unknown ${item.kind} ${item.id}`;
  }

  /** Finds unknown ingredients and recipes that contain themselves, directly or indirectly. */
  validate(): Issue[] {
    const issues = new IssueList();
    const finished = new Set<string>();

    const visit = (recipe: Recipe, path: Recipe[]): void => {
      if (finished.has(recipe.id)) return;
      const loopStart = path.findIndex((r) => r.id === recipe.id);
      if (loopStart !== -1) {
        issues.add({ type: 'cycle', path: [...path.slice(loopStart), recipe].map((r) => r.name) });
        return;
      }
      const nextPath = [...path, recipe];
      for (const ingredient of recipe.ingredients) {
        if (ingredient.item.kind === 'product') {
          if (!this.products.has(ingredient.item.id)) {
            issues.add({ type: 'unknownItem', item: ingredient.item, usedIn: recipe.name });
          }
          continue;
        }
        const child = this.recipes.get(ingredient.item.id);
        if (!child) {
          issues.add({ type: 'unknownItem', item: ingredient.item, usedIn: recipe.name });
          continue;
        }
        visit(child, nextPath);
      }
      finished.add(recipe.id);
    };

    for (const recipe of this.recipes.values()) visit(recipe, []);
    return issues.toArray();
  }

  /** Breaks a quantity of any item down into what it consumes. */
  explode(item: ItemRef, quantity: Quantity, options: ExplodeOptions = {}): Usage {
    const usage = emptyUsage();
    this.#accumulate(item, quantity, [], usage, options, 'the requested item');
    return usage;
  }

  #accumulate(item: ItemRef, quantity: Quantity, stack: string[], usage: Usage, options: ExplodeOptions, usedIn: string): void {
    if (item.kind === 'product') {
      const product = this.products.get(item.id);
      if (!product) {
        usage.issues.add({ type: 'unknownItem', item, usedIn });
        return;
      }
      const amount = this.#convertFor(item, product.name, quantity, product.baseUnit, product.conversions, usage);
      if (amount !== undefined) addTo(usage.products, product.id, amount);
      return;
    }

    const recipe = this.recipes.get(item.id);
    if (!recipe) {
      usage.issues.add({ type: 'unknownItem', item, usedIn });
      return;
    }
    if (stack.includes(recipe.id)) {
      const names = [...stack, recipe.id].map((id) => this.recipes.get(id)?.name ?? id);
      usage.issues.add({ type: 'cycle', path: names.slice(names.indexOf(recipe.name)) });
      return;
    }

    const amount = this.#convertFor(item, recipe.name, quantity, recipe.yield.unit, recipe.conversions, usage);
    if (amount === undefined) return;
    addTo(usage.recipes, recipe.id, amount);

    const isTopLevel = stack.length === 0;
    if (options.stopAtPrep && recipe.kind === 'prep' && !isTopLevel) return;

    const batches = amount / recipe.yield.amount;
    const nextStack = [...stack, recipe.id];
    for (const ingredient of recipe.ingredients) {
      const scaled: Quantity = { amount: ingredient.quantity.amount * batches, unit: ingredient.quantity.unit };
      this.#accumulate(ingredient.item, scaled, nextStack, usage, options, recipe.name);
    }
  }

  #convertFor(item: ItemRef, name: string, quantity: Quantity, toUnit: string, conversions: ItemConversions | undefined, usage: Usage): number | undefined {
    try {
      return convert(quantity, toUnit, conversions);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      usage.issues.add({ type: 'missingConversion', item, itemName: name, from: error.from, to: error.to, needed: error.needed });
      return undefined;
    }
  }

  /** Cost of one baseUnit of a product, or undefined if it has no usable price. */
  unitCost(productId: string): number | undefined {
    const product = this.products.get(productId);
    if (!product?.cost) return undefined;
    try {
      const perInBase = convert(product.cost.per, product.baseUnit, product.conversions);
      return perInBase > 0 ? product.cost.price / perInBase : undefined;
    } catch (error) {
      if (error instanceof ConversionError) return undefined;
      throw error;
    }
  }

  /** Costs any quantity of any item from current product prices. */
  costOf(item: ItemRef, quantity: Quantity): CostResult {
    const usage = this.explode(item, quantity);
    const issues = new IssueList();
    issues.addAll(usage.issues.toArray());

    let total = 0;
    const lines: CostLine[] = [];
    for (const [productId, amount] of usage.products) {
      const product = this.products.get(productId)!;
      const perUnit = this.unitCost(productId);
      if (perUnit === undefined) {
        issues.add({ type: 'missingCost', productId, productName: product.name });
        lines.push({ productId, productName: product.name, amount });
        continue;
      }
      const cost = perUnit * amount;
      total += cost;
      lines.push({ productId, productName: product.name, amount, cost });
    }
    lines.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    return { total, complete: issues.size === 0, lines, issues: issues.toArray() };
  }

  /**
   * What a quantity of an item weighs, from its ingredients down to the products (grams). Not
   * complete when a product can't be weighed (an "each" with no weight per piece, a volume with no
   * density). Cooked-down recipes come out heavy: water lost in cooking isn't counted.
   */
  weightOf(item: ItemRef, quantity: Quantity): { grams: number; complete: boolean; mostly: boolean } {
    const usage = this.explode(item, quantity);
    let grams = 0, complete = usage.issues.size === 0, known = 0;
    for (const [productId, amount] of usage.products) {
      const product = this.products.get(productId)!;
      const g = tryConvert({ amount, unit: product.baseUnit }, 'g', product.conversions);
      if (g === undefined) { complete = false; continue; }
      grams += g; known++;
    }
    // Mostly: all but a pinch can be weighed (a bunch of basil, two eggs), close enough for "about".
    const mostly = complete || (usage.issues.size === 0 && usage.products.size > 0 && known / usage.products.size >= 0.75);
    return { grams, complete, mostly };
  }

  /** Cost of one portion of a dish (one yield of the recipe). */
  portionCost(recipeId: string): CostResult {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) {
      const item: ItemRef = { kind: 'recipe', id: recipeId };
      return { total: 0, complete: false, lines: [], issues: [{ type: 'unknownItem', item, usedIn: 'the requested item' }] };
    }
    return this.costOf({ kind: 'recipe', id: recipeId }, recipe.yield);
  }

  /** Food cost as a fraction of menu price (0.28 = 28%). */
  foodCostShare(recipeId: string, menuPrice: number): { share: number; cost: CostResult } {
    const cost = this.portionCost(recipeId);
    return { share: menuPrice > 0 ? cost.total / menuPrice : Number.NaN, cost };
  }
}
