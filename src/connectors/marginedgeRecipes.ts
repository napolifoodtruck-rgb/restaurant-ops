/**
 * Imports MarginEdge recipe cards (the PDFs it prints one recipe at a time). Two layouts:
 *
 * Recipe card:
 *   Apricot Pizza
 *   Category: Menu items
 *   Yields: 1 Portion
 *   Ingredients                              Method
 *     1 Portion         Pizza Dough          No Method
 *
 * Recipe costing (more detail: yield %, MarginEdge's own costs, menu price, shelf life):
 *   Pizza Dough
 *   Type: Prep
 *   Yields: 30100 Grams or 2 Tubs or 120 Portions
 *   Shelf Life: 7 Days
 *   Item                Type       Yield     Quantity    Unit          Cost
 *   Flour, All Purpose  Food       100%      18000       Gram          $36.05
 *   Oil, Olive Extra Vir- Food     100%      0.5         Fluid Ounce   $0.11
 *   gin
 *   Ingredient Total: $46.18
 *   Global Menu Price: $20.00
 *
 * Some of these PDFs have fonts with incomplete character maps, so their text extracts
 * with letters and digits missing. Those are read with OCR instead (pdftoppm + tesseract).
 *
 * Ingredient names are MarginEdge product names or the names of other recipes, so
 * cards link up into nested recipes once all of them are loaded.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Ingredient, Recipe } from '../core/recipes.ts';
import { dimensionOf, tryConvert, type ItemConversions, type Quantity } from '../core/units.ts';
import { unitWord } from './marginedgeUnits.ts';
import type { ImportedProduct } from './marginedge.ts';

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
}

export interface RecipeCard {
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
}

const NUMBER = String.raw`\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+`;

function parseNumber(text: string): number {
  return text.trim().split(/\s+/).reduce((sum, part) => {
    const [top, bottom] = part.split('/');
    return sum + (bottom ? Number(top) / Number(bottom) : Number(part));
  }, 0);
}

/** "Portion" → each, "Ounces" → oz, "Fluid Ounce" → floz; others ("Batch", "(1/3) Pan") kept as written. */
function cardUnit(raw: string): string {
  return unitWord(raw) ?? raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseQuantity(text: string): Quantity | undefined {
  const match = text.trim().match(new RegExp(`^(${NUMBER})\\s+(.+)$`));
  return match ? { amount: parseNumber(match[1]!), unit: cardUnit(match[2]!) } : undefined;
}

const money = (text: string | undefined) => (text ? Number(text.replace(/[$,\s]/g, '')) : undefined);

/** OCR leaves stray marks around names: "Oregano, Fresh =", "Brussel Sprouts, |", "Fontina’". */
function cleanName(name: string): string {
  return name.replace(/[=|—_’`]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s.,;:]+$/, '').trim();
}

/** Joins a wrapped name: "Oil, Olive Extra Vir-" + "gin" → "Oil, Olive Extra Virgin". */
function joinWrapped(start: string, more: string): string {
  return start.endsWith('-') ? `${start.slice(0, -1)}${more.trim()}` : `${start} ${more.trim()}`;
}

const isNoise = (line: string) =>
  !line.trim() || /\bprinted \d{1,2}\/\d{1,2}\/\d{4}/.test(line) || /^\s*Pa\s?g?e\s+\d+\s+o\s?f?\s+\d+\s*$/i.test(line);
/** OCR picks up stray marks near the logo ("e", "e e") above the name. */
const isStrayMark = (line: string) => /^\s*\S{1,2}(\s+\S{1,2})*\s*$/.test(line);

/** Reads one card's text, in either layout. */
export function parseRecipeCardText(text: string): RecipeCard {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\f/g, '').replace(/\s+$/, ''));
  const fieldLine = (label: string) => lines.find((line) => new RegExp(`^\\s*${label}:`, 'i').test(line));
  const field = (label: string) => fieldLine(label)?.split(':').slice(1).join(':').trim() || undefined;

  // The name: every non-noise line between the header and the first field (names can wrap).
  const firstField = lines.findIndex((line) => /^\s*(Category|Recipe Type|Type|Yields):/i.test(line));
  const header = lines.findIndex((line) => /\bprinted \d{1,2}\/\d{1,2}\/\d{4}/.test(line));
  const name = lines
    .slice(header + 1, Math.max(firstField, 0))
    .filter((line) => !isNoise(line) && !isStrayMark(line))
    .map((line) => line.trim())
    .join(' ');

  const yields = (field('Yields') ?? '')
    .split(/\s+or\s+/i)
    .map(parseQuantity)
    .filter((q): q is Quantity => q !== undefined);
  const shelfLife = field('Shelf Life')?.match(/(\d+(?:\.\d+)?)\s*(day|week)/i);

  const card: RecipeCard = {
    name: cleanName(name),
    category: field('Category'),
    recipeType: field('Recipe Type') ?? field('Type'),
    yields,
    shelfLifeDays: shelfLife ? Number(shelfLife[1]) * (/week/i.test(shelfLife[2]!) ? 7 : 1) : undefined,
    menuPrice: money(field('Global Menu Price')),
    cardTotal: money(field('Ingredient Total')),
    ingredients: [],
    unreadLines: [],
    layout: lines.some((line) => /^\s*Item\s+Type\s+Yield\s+Quantity/i.test(line)) ? 'costing' : 'card',
  };

  if (card.layout === 'costing') parseCostingRows(lines, card);
  else parseCardRows(lines, card);
  return card;
}

/** Recipe-card layout: "  1.25 Ounce        apricot glaze", with the method in a right-hand column. */
function parseCardRows(lines: string[], card: RecipeCard): void {
  const headerIndex = lines.findIndex((line) => /^\s*Ingredients\b/.test(line));
  if (headerIndex === -1) return;
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
      card.ingredients.push({ amount: parseNumber(match[1]!), unit: cardUnit(match[2]!), name: cleanName(match[3]!), yieldPercent: 100 });
      nameColumn = left.indexOf(match[3]!);
      continue;
    }
    // A long name wrapped onto the next line, starting under the name column.
    const previous = card.ingredients.at(-1);
    if (previous && nameColumn > 0 && left.search(/\S/) >= nameColumn - 1) {
      previous.name = cleanName(joinWrapped(previous.name, left));
      continue;
    }
    card.unreadLines.push(left.trim());
  }

  const method = methodLines.join('\n').trim();
  card.method = method && method !== 'No Method' ? method : undefined;
}

const TYPES = String.raw`Food|Prep|Alcohol|Beverage|Beer|Wine|Liquor|Packaging|Supplies|Other|add\s+on`;

/** Recipe-costing layout: name, type, yield %, quantity, unit, cost; names wrap onto following lines. */
function parseCostingRows(lines: string[], card: RecipeCard): void {
  const start = lines.findIndex((line) => /^\s*Item\s+Type\s+Yield\s+Quantity/i.test(line));
  const row = new RegExp(`^\\s*(.*?)\\s*(${TYPES})\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s+(${NUMBER})\\s+(.+?)(?:\\s+\\$\\s*([\\d,]+(?:\\.\\d+)?))?\\s*$`, 'i');
  const methodLines: string[] = [];
  let inMethod = false;

  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (isNoise(line) || /^Item\s+Type\s+Yield/i.test(text)) continue;
    if (/^(Ingredient Total|Global Menu Price|Plate Cost):/i.test(text)) continue;
    if (/^Method$/i.test(text)) { inMethod = true; continue; }
    if (/^No Method$/i.test(text)) continue;
    if (inMethod) { methodLines.push(text); continue; }

    const match = text.match(row);
    if (match) {
      card.ingredients.push({
        name: cleanName(match[1]!),
        type: match[2]!.replace(/\s+/g, ' '),
        yieldPercent: Number(match[3]),
        amount: parseNumber(match[4]!),
        unit: cardUnit(match[5]!),
        cardCost: money(match[6]),
      });
      continue;
    }
    const previous = card.ingredients.at(-1);
    if (previous && /^Notes?:/i.test(text)) { previous.note = text.replace(/^Notes?:\s*/i, ''); continue; }
    if (previous) { previous.name = cleanName(joinWrapped(previous.name, text)); continue; }
    card.unreadLines.push(text);
  }

  card.method = methodLines.join('\n').trim() || undefined;
}

// ---------------------------------------------------------------- reading PDFs

const run = promisify(execFile);

/** Text whose fonts lost characters: "ost" for "Cost", "Pa e 1 o 1". */
function looksGarbled(text: string): boolean {
  if (/^\s*Item\s+Type\s+Yield/im.test(text) && !/\bCost\b/.test(text)) return true;
  if (/\bPa\s?g?e\s+\d+\s+o\s?f?\s+\d+/i.test(text) && !/\bPage \d+ of \d+/.test(text)) return true;
  return false;
}

async function ocrText(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'card-'));
  try {
    await run('pdftoppm', ['-r', '300', '-gray', '-png', path, join(dir, 'page')]);
    const pages = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const texts: string[] = [];
    for (const page of pages) {
      const { stdout } = await run('tesseract', [join(dir, page), '-', '--psm', '6', '-c', 'preserve_interword_spaces=1']);
      texts.push(stdout);
    }
    return texts.join('\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Reads a card's PDF. Uses the PDF's own text when it's intact, and OCR when characters
 * are missing (needs poppler's pdftotext/pdftoppm and tesseract installed).
 */
export async function readRecipeCardPdf(path: string): Promise<RecipeCard> {
  const { stdout } = await run('pdftotext', ['-layout', path, '-']);
  const fromText = parseRecipeCardText(stdout);
  if (!looksGarbled(stdout) && fromText.unreadLines.length === 0 && fromText.name) return fromText;
  const fromOcr = parseRecipeCardText(await ocrText(path));
  return fromOcr.unreadLines.length <= fromText.unreadLines.length ? fromOcr : fromText;
}

// ---------------------------------------------------------------- linking cards into recipes

export type RecipeImportIssue =
  | { type: 'unknownIngredient'; recipe: string; ingredient: string; suggestions: string[] }
  | { type: 'noYield'; recipe: string }
  | { type: 'unreadLine'; recipe: string; line: string }
  | { type: 'duplicateCard'; recipe: string }
  | { type: 'oddYieldPercent'; recipe: string; ingredient: string; yieldPercent: number };

export const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function recipeId(name: string): string {
  return `me-${normalizeName(name).replace(/ /g, '-')}`;
}

/** Ingredients that cost nothing and aren't bought. */
export const FREE_PRODUCTS: ImportedProduct[] = [
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
  const primary = measured ?? yields[0];
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
export function buildRecipes(cards: RecipeCard[], products: ImportedProduct[]): { recipes: Recipe[]; issues: RecipeImportIssue[] } {
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
    for (const ingredient of card.ingredients) {
      let share = ingredient.yieldPercent / 100;
      if (!(share > 0) || share > 1) {
        issues.push({ type: 'oddYieldPercent', recipe: card.name, ingredient: ingredient.name, yieldPercent: ingredient.yieldPercent });
        share = 1;
      }
      const quantity = { amount: ingredient.amount / share, unit: ingredient.unit };
      const key = normalizeName(ingredient.name);
      if (byName.has(key)) {
        ingredients.push({ item: { kind: 'recipe', id: recipeId(ingredient.name) }, quantity });
      } else if (productsByName.has(key)) {
        ingredients.push({ item: { kind: 'product', id: productsByName.get(key)!.externalId }, quantity });
      } else {
        const candidates = [...byName.values()].map((c) => c.name).filter((n) => n !== card.name).concat(allProducts.map((p) => p.name));
        issues.push({ type: 'unknownIngredient', recipe: card.name, ingredient: ingredient.name, suggestions: closestNames(ingredient.name, candidates) });
        // Kept in the recipe so the gap stays visible: it reports as an unknown item until matched.
        ingredients.push({ item: { kind: 'product', id: `unmatched:${key}` }, quantity });
      }
    }

    const isPrep = /^prep/i.test(card.recipeType ?? '') || (!!card.category && !/menu/i.test(card.category));
    const isDish = !isPrep;
    recipes.push({
      id: recipeId(card.name),
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
