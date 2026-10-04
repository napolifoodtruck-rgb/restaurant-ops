/**
 * Imports MarginEdge recipe cards (the "Recipe Card" PDFs it prints one at a time).
 *
 * A card's text, as `pdftotext -layout` extracts it:
 *
 *   Napoli Pizzera and Gelateria             printed 10/04/2026 07:12 PM
 *   Apricot Pizza
 *   Category: Menu items
 *   Recipe Type: Pizza
 *   Yields: 1 Portion
 *   Ingredients                              Method
 *     1 Portion         Pizza Dough          No Method
 *     1.25 Ounce        apricot glaze
 *
 * Ingredient names are MarginEdge product names or the names of other recipes, so
 * cards link up into nested recipes (dough and glaze inside the pizza) once all the
 * cards are loaded.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ingredient, Recipe } from '../core/recipes.ts';
import type { Quantity } from '../core/units.ts';
import { unitWord } from './marginedgeUnits.ts';
import type { ImportedProduct } from './marginedge.ts';

export interface RecipeCard {
  name: string;
  category?: string;
  recipeType?: string;
  yield?: Quantity;
  ingredients: { amount: number; unit: string; name: string }[];
  method?: string;
  /** Lines in the ingredient list that couldn't be read. */
  unreadLines: string[];
}

const NUMBER = String.raw`\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+`;

function parseNumber(text: string): number {
  return text.trim().split(/\s+/).reduce((sum, part) => {
    const [top, bottom] = part.split('/');
    return sum + (bottom ? Number(top) / Number(bottom) : Number(part));
  }, 0);
}

/** "Portion" → each, "Ounce" → oz, "Fluid Ounce" → floz; unknown units ("Slice") kept as written. */
function cardUnit(raw: string): string {
  return unitWord(raw) ?? raw.trim().toLowerCase();
}

function parseQuantity(text: string): Quantity | undefined {
  const match = text.trim().match(new RegExp(`^(${NUMBER})\\s+(.+)$`));
  return match ? { amount: parseNumber(match[1]!), unit: cardUnit(match[2]!) } : undefined;
}

/** Reads one card's text (from `pdftotext -layout`). */
export function parseRecipeCardText(text: string): RecipeCard {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\f/g, '').replace(/\s+$/, ''));
  const isNoise = (line: string) => !line.trim() || /\bprinted \d{1,2}\/\d{1,2}\/\d{4}/.test(line) || /^\s*Page \d+ of \d+\s*$/.test(line);
  const field = (label: string) => lines.find((line) => line.trim().startsWith(`${label}:`))?.split(':').slice(1).join(':').trim() || undefined;

  // The name is the first line after the header, before the fields.
  const firstField = lines.findIndex((line) => /^\s*(Category|Recipe Type|Yields):/.test(line));
  const name = lines.slice(0, Math.max(firstField, 0)).filter((line) => !isNoise(line)).at(-1)?.trim() ?? '';

  const card: RecipeCard = {
    name,
    category: field('Category'),
    recipeType: field('Recipe Type'),
    yield: field('Yields') ? parseQuantity(field('Yields')!) : undefined,
    ingredients: [],
    unreadLines: [],
  };

  const headerIndex = lines.findIndex((line) => /^\s*Ingredients\b/.test(line));
  if (headerIndex === -1) return card;
  const methodColumn = lines[headerIndex]!.search(/\bMethod\b/);
  const methodLines: string[] = [];
  const ingredientPattern = new RegExp(`^\\s*(${NUMBER})\\s+(\\S.*?)\\s{2,}(\\S.*)$`);
  let nameColumn = -1;

  for (const line of lines.slice(headerIndex + 1)) {
    if (isNoise(line) || /^\s*Ingredients\b/.test(line)) continue; // repeated headers on later pages
    // Split at the Method column, unless that would cut through a word (a long ingredient name).
    const cutsWord = methodColumn > 0 && /\S/.test(line[methodColumn - 1] ?? '') && /\S/.test(line[methodColumn] ?? '');
    const split = methodColumn > 0 && !cutsWord;
    const left = split ? line.slice(0, methodColumn).trimEnd() : line;
    const right = split ? line.slice(methodColumn).trim() : '';
    if (right) methodLines.push(right);
    if (!left.trim()) continue;

    const match = left.match(ingredientPattern);
    if (match) {
      card.ingredients.push({ amount: parseNumber(match[1]!), unit: cardUnit(match[2]!), name: match[3]!.trim() });
      nameColumn = left.indexOf(match[3]!);
      continue;
    }
    // A long name wrapped onto the next line, starting under the name column.
    const previous = card.ingredients.at(-1);
    if (previous && nameColumn > 0 && left.search(/\S/) >= nameColumn - 1) {
      previous.name = `${previous.name} ${left.trim()}`;
      continue;
    }
    card.unreadLines.push(left.trim());
  }

  const method = methodLines.join('\n').trim();
  card.method = method && method !== 'No Method' ? method : undefined;
  return card;
}

/** Extracts a card's text from its PDF (needs poppler's pdftotext installed). */
export async function readRecipeCardPdf(path: string): Promise<RecipeCard> {
  const { stdout } = await promisify(execFile)('pdftotext', ['-layout', path, '-']);
  return parseRecipeCardText(stdout);
}

// ---------------------------------------------------------------- linking cards into recipes

export type RecipeImportIssue =
  | { type: 'unknownIngredient'; recipe: string; ingredient: string; suggestions: string[] }
  | { type: 'noYield'; recipe: string }
  | { type: 'unreadLine'; recipe: string; line: string }
  | { type: 'duplicateCard'; recipe: string };

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function recipeId(name: string): string {
  return `me-${normalize(name).replace(/ /g, '-')}`;
}

/**
 * Turns cards into recipes. Each ingredient links to another card (a sub-recipe) when one
 * has that name, otherwise to the MarginEdge product with that name. Anything unmatched is
 * reported with the closest product names, ready to become a question.
 */
export function buildRecipes(cards: RecipeCard[], products: ImportedProduct[]): { recipes: Recipe[]; issues: RecipeImportIssue[] } {
  const issues: RecipeImportIssue[] = [];
  const byName = new Map<string, RecipeCard>();
  for (const card of cards) {
    const key = normalize(card.name);
    if (byName.has(key)) issues.push({ type: 'duplicateCard', recipe: card.name });
    byName.set(key, card);
  }
  const productsByName = new Map(products.map((p) => [normalize(p.name), p]));

  const recipes: Recipe[] = [];
  for (const card of byName.values()) {
    for (const line of card.unreadLines) issues.push({ type: 'unreadLine', recipe: card.name, line });
    if (!card.yield) issues.push({ type: 'noYield', recipe: card.name });

    const ingredients: Ingredient[] = [];
    for (const ingredient of card.ingredients) {
      const key = normalize(ingredient.name);
      const quantity = { amount: ingredient.amount, unit: ingredient.unit };
      if (byName.has(key)) {
        ingredients.push({ item: { kind: 'recipe', id: recipeId(ingredient.name) }, quantity });
      } else if (productsByName.has(key)) {
        ingredients.push({ item: { kind: 'product', id: productsByName.get(key)!.externalId }, quantity });
      } else {
        issues.push({ type: 'unknownIngredient', recipe: card.name, ingredient: ingredient.name, suggestions: closestNames(ingredient.name, [...productsByName.values()].map((p) => p.name)) });
        // Keep it in the recipe so the gap is visible: it will report as an unknown item until matched.
        ingredients.push({ item: { kind: 'product', id: `unmatched:${key}` }, quantity });
      }
    }

    const isDish = /menu/i.test(card.category ?? '');
    recipes.push({
      id: recipeId(card.name),
      name: card.name,
      kind: isDish ? 'dish' : 'prep',
      yield: card.yield ?? { amount: 1, unit: 'each' },
      ingredients,
    });
  }
  return { recipes, issues };
}

/** Up to three product names sharing the most words with the ingredient, for "did you mean". */
function closestNames(name: string, candidates: string[]): string[] {
  const words = new Set(normalize(name).split(' ').filter((w) => w.length > 2));
  if (words.size === 0) return [];
  return candidates
    .map((candidate) => {
      const theirs = normalize(candidate).split(' ').filter((w) => w.length > 2);
      const shared = theirs.filter((w) => words.has(w) || [...words].some((own) => own.startsWith(w) || w.startsWith(own))).length;
      return { candidate, score: shared / Math.max(words.size, theirs.length, 1) };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.candidate);
}
