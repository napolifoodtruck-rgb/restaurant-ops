/**
 * Allergens: tagged once on what's bought (the major 9 and alliums), then worked out for every
 * dish through its recipes, so a pesto inside a pizza counts. An ingredient nobody has checked yet
 * is named, never treated as safe.
 *
 * And the names servers say: a menu card lists a dish's own lines (not what's inside its preps) by
 * the name the team uses at the table ("Fior di Latte" for "Cheese, Mozzarella").
 */

import type { Recipe } from './recipes.ts';

export const ALLERGENS = [
  { key: 'milk', label: 'Dairy' },
  { key: 'egg', label: 'Egg' },
  { key: 'wheat', label: 'Gluten' },
  { key: 'soy', label: 'Soy' },
  { key: 'peanut', label: 'Peanut' },
  { key: 'treenut', label: 'Tree nut' },
  { key: 'sesame', label: 'Sesame' },
  { key: 'fish', label: 'Fish' },
  { key: 'shellfish', label: 'Shellfish' },
  { key: 'allium', label: 'Allium' },
] as const;
export type Allergen = (typeof ALLERGENS)[number]['key'];
export const ALLERGEN_KEYS: readonly string[] = ALLERGENS.map((a) => a.key);
export const allergenLabel = (key: string) => ALLERGENS.find((a) => a.key === key)?.label ?? key;

export interface AllergenInfo {
  /** Each allergen in it, and which ingredients bring it. */
  contains: { key: string; label: string; from: string[] }[];
  /** Ingredients no one has checked yet: the answer isn't complete until they are. */
  unchecked: string[];
  /** Lines that aren't matched to an ingredient or recipe yet. */
  unknown: string[];
}

export interface AllergenSource {
  recipes: ReadonlyMap<string, Recipe>;
  /** An ingredient's allergens: [] checked and none, undefined not checked yet. */
  tagsOf: (productId: string) => readonly string[] | undefined;
  nameOf: (productId: string) => string;
}

/** Free things (water, ice) carry nothing. */
const isFree = (id: string) => id.startsWith('free-');

/**
 * A swap the kitchen offers: one prep for another (the gluten-sensitive crust for the pizza dough),
 * so a dish can be answered both ways.
 */
export interface Swap { from: string; to: string; label: string }

/** Whether a recipe uses another, at any depth. */
export function usesRecipe(recipeId: string, target: string, recipes: ReadonlyMap<string, Recipe>, seen = new Set<string>()): boolean {
  if (seen.has(recipeId)) return false;
  seen.add(recipeId);
  return (recipes.get(recipeId)?.ingredients ?? []).some((l) => l.item.kind === 'recipe' && (l.item.id === target || usesRecipe(l.item.id, target, recipes, seen)));
}

/** What's in a recipe, through everything it uses (with a swap: the replacement's instead). */
export function allergensOf(recipeId: string, src: AllergenSource, swap?: Pick<Swap, 'from' | 'to'>): AllergenInfo {
  const from = new Map<string, Set<string>>();
  const unchecked = new Set<string>(), unknown = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const recipe = src.recipes.get(id);
    if (!recipe) return;
    for (const line of recipe.ingredients) {
      if (line.item.kind === 'recipe') { walk(swap && line.item.id === swap.from ? swap.to : line.item.id); continue; }
      const pid = line.item.id;
      if (isFree(pid)) continue;
      if (pid.startsWith('unmatched:') || pid.startsWith('unfinished:')) { unknown.add(pid.replace(/^(unmatched|unfinished):/, '')); continue; }
      const tags = src.tagsOf(pid);
      const name = src.nameOf(pid);
      if (tags === undefined) { unchecked.add(name); continue; }
      for (const t of tags) from.set(t, (from.get(t) ?? new Set()).add(name));
    }
  };
  walk(recipeId);
  return {
    contains: ALLERGENS.filter((a) => from.has(a.key)).map((a) => ({ key: a.key, label: a.label, from: [...from.get(a.key)!].sort() })),
    unchecked: [...unchecked].sort(),
    unknown: [...unknown].sort(),
  };
}

/** The line a menu card prints: "ALLERGY: Dairy, Gluten, Allium". */
export function allergyLine(info: AllergenInfo): string {
  return info.contains.length ? info.contains.map((c) => c.label).join(', ') : 'None of the major allergens';
}

export interface GuestNames {
  /** The name servers say for an ingredient, and whether it shows on cards at all (salt, oil: no). */
  product: (productId: string) => { name: string; show: boolean };
  recipe: (recipeId: string) => string;
}

/** A dish's lines as a card lists them, in the recipe's order, each once. */
export function cardLines(recipe: Recipe, names: GuestNames): string[] {
  const out: string[] = [];
  for (const line of recipe.ingredients) {
    let name: string | undefined;
    if (line.item.kind === 'recipe') name = names.recipe(line.item.id);
    else if (!isFree(line.item.id) && !line.item.id.startsWith('unfinished:')) {
      const p = names.product(line.item.id);
      if (p.show) name = p.name;
    }
    if (name && !out.some((x) => x.toLowerCase() === name!.toLowerCase())) out.push(name);
  }
  return out;
}

/** "Cheese, Mozzarella" → "Mozzarella Cheese": how a list-style name reads aloud, until a manager names it. */
export function spokenName(name: string): string {
  const m = name.match(/^([^,]+),\s*(.+)$/);
  const raw = m ? `${m[2]} ${m[1]}` : name;
  return raw.replace(/\s+/g, ' ').trim();
}
