/**
 * Links POS menu items to recipes.
 *
 * Links are kept by the POS's own id (a Square item variation id), so a rename in the
 * POS never breaks them. Names are only used once, to propose the link:
 *  - a menu item whose name matches exactly one dish recipe is linked on its own;
 *  - anything less certain becomes a one-tap question, best sellers first;
 *  - when the POS name of a linked item changes, the link holds but the system asks
 *    once whether it is still the same dish. Square reuses the id when an item is
 *    renamed, and restaurants reuse items for rotating specials and tap handles, so a
 *    new name can mean a new dish.
 * A confirmed answer also becomes an alias, so the same name elsewhere (another
 * location, a promo variation) links without asking again.
 */

import type { Quantity } from './units.ts';
import type { Recipe, RecipeKind } from './recipes.ts';

/** One sellable thing in the POS, neutral across POS systems. */
export interface PosMenuItem {
  /** The id sales are reported under: a Square item variation id. */
  catalogId: string;
  itemId?: string;
  itemName: string;
  /** Left out, or "Regular", when the item has a single variation. */
  variationName?: string;
  category?: string;
  /** List price in dollars. */
  price?: number;
  /** A $0 staff-meal button: uses food, brings no sales. */
  staffMeal?: boolean;
}

export interface MenuLink {
  catalogId: string;
  /** The POS name the link was confirmed under. */
  posName: string;
  /** Null when confirmed as having no food cost to track (a gift card, a fee), or while awaiting a recipe. */
  recipeId: string | null;
  /** A new dish whose recipe isn't in yet: it counts as missing a recipe, and links once its card arrives. */
  awaitingRecipe?: true;
  /** How much of the recipe one sale uses. Defaults to one yield of the recipe. */
  portion?: Quantity;
  matchedBy: 'name' | 'alias' | 'manager';
}

export interface LinkState {
  links: MenuLink[];
  /** Name key → recipe id, learned from confirmed answers. */
  aliases: Record<string, string | null>;
}

export const emptyLinkState = (): LinkState => ({ links: [], aliases: {} });

export interface Candidate {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  /** 0 to 1. */
  score: number;
}

export interface LinkQuestion {
  /**
   * confirm: one likely recipe. choose: no strong candidate (or several).
   * renamed: a linked item now sells under another name.
   */
  type: 'confirm' | 'choose' | 'renamed';
  item: PosMenuItem;
  posName: string;
  candidates: Candidate[];
  /** The existing link, for a rename. */
  previous?: MenuLink;
  /** Sales over the period looked at, so the question list can be ranked. */
  netSales: number;
  quantity: number;
}

export type LinkStatus =
  | { status: 'linked'; link: MenuLink }
  | { status: 'renamed'; previous: MenuLink }
  | { status: 'unlinked' };

// ---------------------------------------------------------------- names

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'on', 'pizza', 'app', 'appetizer', 'special', 'shift', 'add', 'side', 'regular']);

/** The display name of a POS item: the variation is only shown when there are several. */
export function posName(item: Pick<PosMenuItem, 'itemName' | 'variationName'>): string {
  const variation = item.variationName?.trim();
  return variation && !/^regular$/i.test(variation) ? `${item.itemName.trim()} (${variation})` : item.itemName.trim();
}

function words(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    // Plurals: "meatballs" is "meatball".
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** The key two names are compared by: "Marinara pizza" and "Marinara" share "marinara". */
export function nameKey(name: string): string {
  return words(name).join(' ');
}

function bigrams(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
  return out;
}

/** Spelling similarity of two words (Dice coefficient on letter pairs): "bufala" and "buffalo" score 0.73. */
function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const pool = [...right];
  let common = 0;
  for (const pair of left) {
    const i = pool.indexOf(pair);
    if (i >= 0) {
      common++;
      pool.splice(i, 1);
    }
  }
  return (2 * common) / (left.length + right.length);
}

/** How alike two names are, from 0 to 1, tolerant of spelling and extra words. */
export function nameSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.length === 0 || right.length === 0) return 0;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  let matched = 0;
  for (const word of short) {
    const best = Math.max(...long.map((other) => wordSimilarity(word, other)));
    if (best >= 0.6) matched += best;
  }
  const dice = (2 * matched) / (left.length + right.length);
  // Every word of the shorter name is in the longer one: "Meatballs Pomodoro" and "meatball app".
  // Weak evidence when the longer name adds words of its own ("Olives & Focaccia" isn't
  // the focaccia), so it scores between 0.6 and 0.8 by how much of the longer name it covers.
  const contained = matched / short.length >= 0.999 ? 0.6 + (0.2 * short.length) / long.length : 0;
  return Math.max(dice, contained);
}

// ---------------------------------------------------------------- lookups

/** How a sale of `catalogId` under `name` resolves against the saved links. */
export function linkStatus(state: LinkState, catalogId: string, name: string): LinkStatus {
  const key = nameKey(name);
  let latest: MenuLink | undefined;
  for (const link of state.links) {
    if (link.catalogId !== catalogId) continue;
    if (nameKey(link.posName) === key) return { status: 'linked', link };
    latest = link;
  }
  return latest ? { status: 'renamed', previous: latest } : { status: 'unlinked' };
}

/** The recipe one sale uses, for theoretical usage and margins. Unconfirmed renames don't resolve. */
export function linkLookup(state: LinkState): (catalogId: string, name: string) => { recipeId: string; portion?: Quantity } | undefined {
  return (catalogId, name) => {
    const found = linkStatus(state, catalogId, name);
    if (found.status !== 'linked' || found.link.recipeId === null) return undefined;
    return { recipeId: found.link.recipeId, portion: found.link.portion };
  };
}

// ---------------------------------------------------------------- matching

const PREP_PENALTY = 0.85; // a menu item is rarely a prep recipe sold as is
const CONFIRM_AT = 0.6;
const SHOW_AT = 0.3;

function candidatesFor(item: PosMenuItem, recipes: readonly Recipe[]): Candidate[] {
  // Compare the full name, the item name and the variation name, and keep the best.
  const names = [posName(item), item.itemName, item.variationName].filter((n): n is string => !!n && !/^regular$/i.test(n));
  const out: Candidate[] = [];
  for (const recipe of recipes) {
    const raw = Math.max(...names.map((n) => nameSimilarity(n, recipe.name)));
    const score = recipe.kind === 'prep' ? raw * PREP_PENALTY : raw;
    if (score >= SHOW_AT) out.push({ recipeId: recipe.id, name: recipe.name, kind: recipe.kind, score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 3);
}

export interface SoldItem extends PosMenuItem {
  quantity?: number;
  netSales?: number;
}

export interface MatchResult {
  /** Links made without asking: exact names and known aliases. */
  newLinks: MenuLink[];
  /** One question per item still unsure, highest sales first. */
  questions: LinkQuestion[];
}

/**
 * Proposes links for menu items. Items already linked under the same name are skipped.
 * Pass the items as they sold (one entry per id and name), so renames are caught.
 */
export function matchMenu(items: readonly SoldItem[], recipes: readonly Recipe[], state: LinkState): MatchResult {
  const working: LinkState = { links: [...state.links], aliases: state.aliases };
  const newLinks: MenuLink[] = [];
  const questions: LinkQuestion[] = [];
  const later: SoldItem[] = [];

  // Pass 1: link what is certain. Doing this first means a renamed item's old name is
  // linked before its new name is looked at, whatever order the sales come in.
  for (const item of items) {
    const name = posName(item);
    const status = linkStatus(working, item.catalogId, name);
    const awaiting = status.status === 'linked' && status.link.awaitingRecipe;
    if (status.status !== 'unlinked' && !awaiting) {
      later.push(item);
      continue;
    }
    const key = nameKey(name);
    let link: MenuLink | undefined;
    if (awaiting) {
      // Waiting on its card: link as soon as a dish with the same name exists, otherwise stay quiet.
      const exact = recipes.filter((r) => r.kind !== 'prep' && nameKey(r.name) === key && key !== '');
      if (exact.length === 1) link = { catalogId: item.catalogId, posName: name, recipeId: exact[0]!.id, matchedBy: 'name' };
      if (!link) continue;
    } else if (key in working.aliases) {
      link = { catalogId: item.catalogId, posName: name, recipeId: working.aliases[key] ?? null, matchedBy: 'alias' };
    } else {
      // Exact on the full name only: two sizes of one item share an item name but not a portion.
      const exact = recipes.filter((r) => r.kind !== 'prep' && nameKey(r.name) === key && key !== '');
      if (exact.length === 1) link = { catalogId: item.catalogId, posName: name, recipeId: exact[0]!.id, matchedBy: 'name' };
    }
    if (link) {
      newLinks.push(link);
      working.links = replaceLink(working.links, link);
    } else {
      later.push(item);
    }
  }

  // Pass 2: questions.
  for (const item of later) {
    const name = posName(item);
    const status = linkStatus(working, item.catalogId, name);
    if (status.status === 'linked') continue;
    const candidates = candidatesFor(item, recipes);
    const base = { item, posName: name, candidates, netSales: item.netSales ?? 0, quantity: item.quantity ?? 0 };
    if (status.status === 'renamed') {
      questions.push({ ...base, type: 'renamed', previous: status.previous });
    } else {
      const top = candidates[0];
      const clear = top && top.score >= CONFIRM_AT && (candidates[1]?.score ?? 0) < top.score;
      questions.push({ ...base, type: clear ? 'confirm' : 'choose' });
    }
  }

  questions.sort((a, b) => b.netSales - a.netSales || a.posName.localeCompare(b.posName));
  return { newLinks, questions };
}

/** Adds links made by matching. */
function replaceLink(links: readonly MenuLink[], link: MenuLink): MenuLink[] {
  const key = nameKey(link.posName);
  return [...links.filter((l) => !(l.catalogId === link.catalogId && nameKey(l.posName) === key)), link];
}

/** Adds links made by matching, replacing any under the same id and name. */
export function applyLinks(state: LinkState, links: readonly MenuLink[]): LinkState {
  return { links: links.reduce(replaceLink, [...state.links]), aliases: state.aliases };
}

/**
 * Records that an item (usually a renamed one) is a new dish whose recipe isn't in yet.
 * It stops asking, shows as missing a recipe, and links once a card with its name arrives.
 */
export function markNewDish(state: LinkState, item: PosMenuItem): LinkState {
  const link: MenuLink = { catalogId: item.catalogId, posName: posName(item), recipeId: null, awaitingRecipe: true, matchedBy: 'manager' };
  return { links: replaceLink(state.links, link), aliases: state.aliases };
}

/**
 * Records a manager's answer: this item, under this name, is this recipe (or has no
 * food cost when recipeId is null). The name becomes an alias for next time.
 */
export function confirmLink(state: LinkState, item: PosMenuItem, recipeId: string | null, portion?: Quantity): LinkState {
  const name = posName(item);
  const key = nameKey(name);
  const link: MenuLink = { catalogId: item.catalogId, posName: name, recipeId, matchedBy: 'manager', ...(portion ? { portion } : {}) };
  return { links: replaceLink(state.links, link), aliases: key ? { ...state.aliases, [key]: recipeId } : state.aliases };
}

/** The question in the words a chef would use. */
export function describeQuestion(q: LinkQuestion): string {
  const top = q.candidates[0];
  const others = q.candidates.slice(1).map((c) => c.name);
  const prepNote = (c: Candidate) => (c.kind === 'prep' ? ' (the prep recipe)' : '');
  switch (q.type) {
    case 'renamed':
      return `"${q.previous?.posName}" now sells as "${q.posName}". Same recipe?`;
    case 'confirm':
      if (top!.kind === 'prep') return `"${q.posName}" only matches the ${top!.name} prep recipe. Is it sold as is, or does it need its own card?`;
      return `Is "${q.posName}" the ${top!.name} recipe?${others.length ? ` (or ${others.join(', ')})` : ''}`;
    case 'choose':
      return q.candidates.length
        ? `Which recipe is "${q.posName}"? Closest: ${q.candidates.map((c) => c.name + prepNote(c)).join(', ')}, or no recipe yet.`
        : `No recipe for "${q.posName}" yet.`;
  }
}
