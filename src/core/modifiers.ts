/**
 * What POS modifiers do to food cost: "++ Extra Mozzarella", "-- No Chorizo",
 * "** Sub Buffalo Mozzarella", "Gluten Sensitive Crust".
 *
 * The modifier's own wording does most of the work:
 *  - "++", "Add", "Extra": adds an ingredient. The portion is proposed from the dishes
 *    that already use it (3 oz of mozzarella, as on the Margherita) and asked once.
 *  - "--", "No": takes the dish's own line for that ingredient off, at the dish's
 *    portion. Asked only when the name doesn't say which line ("No Salami" on a pizza
 *    made with soppressata).
 *  - "Sub": both of the above.
 *  - "OTS", "on the side", cooking and service notes: no change in food.
 *  - anything else ("Gluten Sensitive Crust"): asked once, what it changes.
 * A free add of something the dish already has ("Fresh Basil Cooked on Pizza" on a
 * Margherita) is the dish as written, not an extra.
 *
 * Square reports modifier sales by list and name without ids, so modifiers are keyed by
 * list + name. A renamed modifier is asked about again; that costs one tap.
 */

import { nameKey, nameSimilarity } from './menuLinks.ts';
import { emptyUsage, mergeUsage, type Ingredient, type ItemRef, type RecipeBook, type Usage } from './recipes.ts';
import type { Quantity } from './units.ts';

export type ModifierAction = 'add' | 'remove' | 'swap' | 'none' | 'ask';

export interface PosModifier {
  listName?: string;
  name: string;
  /** Upcharge in dollars, when known. */
  price?: number;
}

export interface ModifierReading {
  action: ModifierAction;
  /** What is added (add, swap) or what is taken off (remove). */
  adds?: string;
  removes?: string;
  /** Worded "extra": more of what the dish already has, usually a part portion. */
  extra?: true;
}

export const modifierKey = (m: Pick<PosModifier, 'listName' | 'name'>): string => `${nameKey(m.listName ?? '')}|${nameKey(m.name)}`;

const SERVICE_LISTS = /cook|spoon|glass|\bice\b|hot or iced|decaf|with pizza|cream (and|&) sugar|soda or water/i;
const SERVICE_NAMES = /\bcooked (and|&) sliced\b|partially cooked|\bspoons?\b|\bglass(es)?\b|^(no )?ice$|\bdecaf\b|^regular$|^hot$|^iced$|with pizza/i;
const ON_THE_SIDE = /\bOTS\b|\bon (the )?side\b/i;

function clean(text: string): string {
  return text
    .replace(/^[\s+*\-–]+/, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(OTS|on (the )?side|cooked on pizza)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reads what a modifier does from its wording. */
export function readModifier(m: PosModifier): ModifierReading {
  const name = m.name.trim();
  if (SERVICE_LISTS.test(m.listName ?? '') || SERVICE_NAMES.test(name)) return { action: 'none' };

  // "-No Focaccia; Sub Gluten Free", "** Sub Buffalo Mozzarella", "++ Sub GF Crust".
  const sub = /\bsub(stitute)?\b\s*(.*)$/i.exec(name);
  if (sub) {
    const before = name.slice(0, sub.index);
    const removed = /\bno\b\s*([^;,]*)/i.exec(before)?.[1];
    return { action: 'swap', adds: clean(sub[2] ?? ''), ...(removed ? { removes: clean(removed) } : {}) };
  }

  const stripped = name.replace(/^[\s+*\-–]+/, '');
  if (/^\s*\+\+/.test(name) || /^(add|extra)\b/i.test(stripped)) {
    const extra = /\bextra\b/i.test(name);
    return { action: 'add', adds: clean(stripped.replace(/^(add|extra)\b/i, '')), ...(extra ? { extra: true as const } : {}) };
  }
  if (/^no\b/i.test(stripped) || /^\s*[-–]/.test(name)) {
    return { action: 'remove', removes: clean(stripped.replace(/^no\b/i, '')) };
  }

  if (ON_THE_SIDE.test(name)) return { action: 'none' };
  return { action: 'ask' };
}

// ---------------------------------------------------------------- answers and questions

export interface ModifierAnswers {
  /** Modifier key → what one use adds (an add-on, a swap's new half, a choice). Empty: changes nothing. */
  adds: Record<string, (Ingredient | ShareOfDish)[]>;
  /**
   * `${dish recipe id}|${modifier key}` → the dish's ingredient it takes off. Null: takes nothing off.
   * `*|${modifier key}` answers for every dish ("the gluten-free crust replaces the dough").
   */
  removes: Record<string, ItemRef | null>;
  /** Modifier key → why it can't be costed yet ("lamb meatballs: Katahdin card not in yet"). Not asked again. */
  waiting?: Record<string, string>;
}

/**
 * A part of the dish's own portion: extra mozzarella is half again what the dish has, so
 * 1.5 oz on a 3 oz Margherita and 1 oz on a 2 oz Greca. On a dish without the item it is
 * that share of the item's usual portion.
 */
export interface ShareOfDish {
  item: ItemRef;
  share: number;
}

const isShare = (a: Ingredient | ShareOfDish): a is ShareOfDish => 'share' in a;

/** The default for "extra": half again the dish's portion. */
export const EXTRA_SHARE = 0.5;

export const emptyModifierAnswers = (): ModifierAnswers => ({ adds: {}, removes: {} });

export interface ModifierQuestion {
  /** portion: how much an add-on is. which: which of the dish's ingredients it replaces or removes. what: what it changes at all. */
  type: 'portion' | 'which' | 'what';
  modifier: PosModifier;
  key: string;
  /** For "which": the dish it is about. */
  dishRecipeId?: string;
  dishName?: string;
  /** Best guess, for a one-tap yes. */
  proposal?: (Ingredient | ShareOfDish)[] | ItemRef;
  /** The dish's ingredients, for "which". */
  choices?: ItemRef[];
  uses: number;
}

/** One modifier used on one dish, summed over a period. */
export interface ModifierSaleLine {
  catalogId: string;
  itemName: string;
  modifier: PosModifier;
  quantity: number;
  /** What the modifier itself brought in. */
  sales: number;
}

export interface ResolvedModifier {
  adds: Ingredient[];
  removes: Ingredient[];
}

// Words that describe how an ingredient is bought or cut, not what it is: "Fresh Garlic"
// is garlic, not basil (Basil, Fresh).
const DESCRIPTORS = /\b(fresh|sliced|peeled|chopped|whole|baby|dried|shaved|aged|roasted|dop|extra|virgin|crumbles?|imported|local)\b/gi;
const ingredientSimilarity = (text: string, itemName: string): number => {
  const strip = (t: string) => t.replace(DESCRIPTORS, ' ').trim() || t;
  const score = nameSimilarity(strip(text), strip(itemName));
  // Invoice names lead with what the thing is ("Olives, Nicoise"; "Oil, Olive"): a match on
  // that first word breaks ties, so "Olives" means olives and not olive oil.
  const head = nameKey(itemName.split(',')[0] ?? '').split(' ')[0];
  return head && nameKey(text).split(' ').includes(head) ? Math.min(1, score + 0.05) : score;
};

/** The dish's own line for a named ingredient ("Chorizo" → Sausage, Chorizo 0.79 oz), if the name says. */
function findLine(book: RecipeBook, dishRecipeId: string, text: string, minScore = 0.6): Ingredient | undefined {
  const dish = book.recipes.get(dishRecipeId);
  if (!dish || !text) return undefined;
  let best: { line: Ingredient; score: number } | undefined;
  for (const line of dish.ingredients) {
    const score = ingredientSimilarity(text, book.nameOf(line.item));
    if (score >= minScore && (!best || score > best.score)) best = { line, score };
  }
  return best?.line;
}

/** Products and recipes whose names fit, best first. */
function findItems(book: RecipeBook, text: string): ItemRef[] {
  const scored: { item: ItemRef; score: number }[] = [];
  for (const p of book.products.values()) {
    const score = ingredientSimilarity(text, p.name);
    if (score >= 0.5) scored.push({ item: { kind: 'product', id: p.id }, score });
  }
  for (const r of book.recipes.values()) {
    if (r.kind !== 'prep') continue;
    const score = ingredientSimilarity(text, r.name);
    if (score >= 0.5) scored.push({ item: { kind: 'recipe', id: r.id }, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}

/** The most common portion of an item across dishes: what an add-on of it most likely is. */
export function usualPortion(book: RecipeBook, item: ItemRef): Quantity | undefined {
  const counts = new Map<string, { quantity: Quantity; n: number }>();
  for (const recipe of book.recipes.values()) {
    if (recipe.kind === 'prep') continue;
    for (const line of recipe.ingredients) {
      if (line.item.kind !== item.kind || line.item.id !== item.id) continue;
      const key = `${+line.quantity.amount.toFixed(3)} ${line.quantity.unit}`;
      const c = counts.get(key) ?? { quantity: line.quantity, n: 0 };
      c.n++;
      counts.set(key, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || b.quantity.amount - a.quantity.amount)[0]?.quantity;
}

function proposeAdd(book: RecipeBook, text: string, extra: boolean): (Ingredient | ShareOfDish)[] | undefined {
  for (const item of findItems(book, text)) {
    if (extra) return [{ item, share: EXTRA_SHARE }];
    const quantity = usualPortion(book, item);
    if (quantity) return [{ item, quantity }];
  }
  return undefined;
}

/** Turns answers into amounts for one dish. Undefined when a share has nothing to be a share of. */
function amountsFor(book: RecipeBook, dishRecipeId: string, adds: readonly (Ingredient | ShareOfDish)[]): Ingredient[] | undefined {
  const dish = book.recipes.get(dishRecipeId);
  const out: Ingredient[] = [];
  for (const add of adds) {
    if (!isShare(add)) {
      out.push(add);
      continue;
    }
    const own = dish?.ingredients.find((l) => l.item.kind === add.item.kind && l.item.id === add.item.id)?.quantity;
    const base = own ?? usualPortion(book, add.item);
    if (!base) return undefined;
    out.push({ item: add.item, quantity: { amount: base.amount * add.share, unit: base.unit } });
  }
  return out;
}

/**
 * What one use of a modifier on a dish adds and takes off, or the question that has to
 * be answered first.
 */
export function resolveModifier(
  book: RecipeBook,
  dishRecipeId: string,
  modifier: PosModifier,
  answers: ModifierAnswers,
): { resolved: ResolvedModifier } | { question: Omit<ModifierQuestion, 'uses'> } {
  const key = modifierKey(modifier);
  const reading = readModifier(modifier);
  const dish = book.recipes.get(dishRecipeId);
  const base = { modifier, key };
  if (reading.action === 'none') return { resolved: { adds: [], removes: [] } };

  // The added half.
  let adds: Ingredient[] = [];
  if (reading.action === 'add' || reading.action === 'swap' || reading.action === 'ask') {
    const answered = answers.adds[key];
    const amounts = answered && amountsFor(book, dishRecipeId, answered);
    if (amounts) {
      adds = amounts;
    } else if (reading.action === 'add' && !modifier.price && reading.adds && findLine(book, dishRecipeId, reading.adds)) {
      // Free, and the dish already has it: the dish as written.
      return { resolved: { adds: [], removes: [] } };
    } else {
      const type = reading.action === 'ask' ? 'what' : 'portion';
      const proposal = reading.adds ? proposeAdd(book, reading.adds, !!reading.extra) : undefined;
      return { question: { ...base, type, ...(proposal ? { proposal } : {}) } };
    }
  }

  // The removed half.
  const removes: Ingredient[] = [];
  const dishKey = `${dishRecipeId}|${key}`;
  const answeredKey = dishKey in answers.removes ? dishKey : `*|${key}` in answers.removes ? `*|${key}` : undefined;
  if (answeredKey !== undefined) {
    const item = answers.removes[answeredKey];
    const line = item && dish?.ingredients.find((l) => l.item.kind === item.kind && l.item.id === item.id);
    if (line) removes.push(line);
  } else if (reading.action === 'remove' || reading.action === 'swap') {
    // A swap names what goes on; what comes off is usually the closest thing on the dish.
    const line = findLine(book, dishRecipeId, reading.removes ?? '') ?? (reading.action === 'swap' ? findLine(book, dishRecipeId, reading.adds ?? '', 0.5) : undefined);
    if (!line) {
      return {
        question: { ...base, type: 'which', dishRecipeId, ...(dish ? { dishName: dish.name, choices: dish.ingredients.map((l) => l.item) } : {}) },
      };
    }
    removes.push(line);
  }
  return { resolved: { adds, removes } };
}

// ---------------------------------------------------------------- totals

export interface ModifierSummary {
  key: string;
  modifier: PosModifier;
  uses: number;
  sales: number;
  /** Food cost of all uses (removals count against it). */
  cost: number;
  /** False when some use couldn't be costed (unanswered question or missing price). */
  complete: boolean;
}

export interface ModifierCosts {
  /**
   * `${POS catalog id}|${dish recipe id}` → extra food cost from modifiers over the period
   * (negative when removals save more). Keyed by dish too, since a reused POS id can be two dishes.
   */
  byItem: Map<string, number>;
  /** Usage to add to theoretical usage. */
  usage: Usage;
  modifiers: ModifierSummary[];
  /** Most used first. */
  questions: ModifierQuestion[];
}

/**
 * Costs modifiers across a period's sales. `dishFor` gives the recipe of the item the
 * modifier was used on (from menu links).
 */
export function modifierCosts(
  book: RecipeBook,
  sales: readonly ModifierSaleLine[],
  dishFor: (catalogId: string, itemName: string) => string | undefined,
  answers: ModifierAnswers,
): ModifierCosts {
  const byItem = new Map<string, number>();
  const usage = emptyUsage();
  const summaries = new Map<string, ModifierSummary>();
  const questions = new Map<string, ModifierQuestion>();

  for (const line of sales) {
    const key = modifierKey(line.modifier);
    const summary = summaries.get(key) ?? { key, modifier: line.modifier, uses: 0, sales: 0, cost: 0, complete: true };
    summary.uses += line.quantity;
    summary.sales += line.sales;
    summaries.set(key, summary);

    const dishId = dishFor(line.catalogId, line.itemName);
    if (!dishId) {
      // The dish has no recipe yet; that is asked about elsewhere.
      if (readModifier(line.modifier).action !== 'none') summary.complete = false;
      continue;
    }
    if (answers.waiting && key in answers.waiting) {
      summary.complete = false;
      continue;
    }
    const result = resolveModifier(book, dishId, line.modifier, answers);
    if ('question' in result) {
      summary.complete = false;
      const q = result.question;
      const qKey = q.type === 'which' ? `${q.dishRecipeId}|${key}` : key;
      const existing = questions.get(qKey);
      if (existing) existing.uses += line.quantity;
      else questions.set(qKey, { ...q, uses: line.quantity });
      continue;
    }

    let cost = 0;
    for (const [sign, list] of [[1, result.resolved.adds], [-1, result.resolved.removes]] as const) {
      for (const ingredient of list) {
        const qty: Quantity = { amount: sign * ingredient.quantity.amount * line.quantity, unit: ingredient.quantity.unit };
        const c = book.costOf(ingredient.item, qty);
        if (!c.complete) summary.complete = false;
        cost += c.total;
        mergeUsage(usage, book.explode(ingredient.item, qty));
      }
    }
    summary.cost += cost;
    const itemKey = `${line.catalogId}|${dishId}`;
    byItem.set(itemKey, (byItem.get(itemKey) ?? 0) + cost);
  }

  return {
    byItem,
    usage,
    modifiers: [...summaries.values()].sort((a, b) => b.uses - a.uses),
    questions: [...questions.values()].sort((a, b) => b.uses - a.uses),
  };
}
