/**
 * Drafting recipe cards for the bar from what already exists: the POS buttons and the products
 * on invoices. Most drinks follow a handful of shapes, so a manager reviews a group at a time
 * instead of writing a hundred cards:
 *
 *   wine by the glass   a pour from the bottle it's poured from        6 fl oz of the wine
 *   wine by the bottle  the bottle                                     1 bottle
 *   draft beer          a pour from the keg on tap                     16 fl oz of the keg
 *   cans and bottles    a direct sale: one of what was bought          1 can
 *   coffee              a dose of beans, and milk for milk drinks      18 g espresso beans
 *   cocktails, house    their own card (spec, syrups, garnish)         written by the bar
 *   sodas and mocktails
 *
 * The product each one comes from is matched by name; a manager can change any of it.
 */

import { nameSimilarity } from './menuLinks.ts';

export interface BarItem {
  catalogId: string;
  itemName: string;
  variationName?: string;
  category: string;
  netSales: number;
  quantity: number;
}

export interface BarProduct {
  id: string;
  name: string;
  /** How it's bought: bottle, keg, can, lb, each... */
  unit: string;
  /** FOOD, WINE, BEER, LIQUOR, NA_BEVERAGES, OTHER. */
  type?: string;
  /** Last invoice date: of two vintages that match alike, the one bought last. */
  lastBought?: string;
}

export type DrinkShape = 'wineGlass' | 'wineBottle' | 'draft' | 'direct' | 'coffee' | 'ownCard';

export interface DrinkDraft {
  shape: DrinkShape;
  /** The card's name: the POS item's. */
  name: string;
  category: string;
  /** The POS buttons it covers: the item's price variations (Wednesday half off is the same pour). */
  items: { catalogId: string; itemName: string; variationName?: string }[];
  netSales: number;
  quantity: number;
  /** The product it comes from, best match first; empty when nothing matched. */
  matches: { id: string; name: string; score: number }[];
  /** True when the match needs a look: a weak one, or two products matching about as well. */
  check: boolean;
  ingredients: { amount: number; unit: string; name: string }[];
}

export interface DraftOptions {
  /** Wine by the glass, fl oz. */
  winePour?: number;
  /** Draft beer, fl oz. */
  draftPour?: number;
  /** Espresso dose, g (doubled for drinks named double). */
  espressoDose?: number;
  /** Product names for coffee and milk, when they can't be found by name. */
}

/** Variations that are a different drink, not a different price: add a spirit, substitute, share. */
const OWN_VARIATION = /\badd\b|\bsub\b|\*\*|shared|double|flight/i;

const WINE_NOISE = /\b(gls|btl|glass|bottle|doc|docg|igp|dop|classico|superiore|riserva|\d{4})\b/gi;
const BEER_NOISE = /\b(keg|bbl|can|cans|bottle|\d+(\.\d+)?\s*oz|\d+(\.\d+)?%|abv|brewing|brewery|co)\b|\(.*?\)|1\/[46]\s*bbl/gi;

function clean(name: string, noise: RegExp): string {
  return name.replace(/\bipa\b/gi, 'india pale ale').replace(/coca[- ]cola/gi, 'coke').replace(/pellegrino water/gi, 'pellegrino').replace(noise, ' ').replace(/[-–:,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Names alike enough, also when one runs words together ("Belli Folli" and "Bellifolli"). */
function score(a: string, b: string): number {
  const plain = nameSimilarity(a, b);
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ');
  const left = squash(a), right = squash(b);
  // Join each pair of neighbouring words on the left and see if the right has it as one.
  let joined = 0;
  for (let i = 0; i < left.length - 1; i++) if (right.includes(left[i]! + left[i + 1]!)) joined++;
  for (let i = 0; i < right.length - 1; i++) if (left.includes(right[i]! + right[i + 1]!)) joined++;
  return joined ? Math.max(plain, nameSimilarity(left.join(''), right.join('')), Math.min(1, plain + 0.25 * joined)) : plain;
}

function matchesFor(name: string, products: readonly BarProduct[], noise: RegExp): DrinkDraft['matches'] {
  const key = clean(name, noise);
  if (!key) return [];
  return products
    .map((p) => ({ id: p.id, name: p.name, score: Math.round(score(key, clean(p.name, noise)) * 100) / 100 }))
    .filter((m) => m.score >= 0.5)
    .sort((x, y) => y.score - x.score || (products.find((p) => p.id === y.id)?.lastBought ?? '').localeCompare(products.find((p) => p.id === x.id)?.lastBought ?? ''))
    .slice(0, 4);
}

function shapeOf(item: BarItem): DrinkShape {
  const n = item.itemName;
  const c = item.category.toLowerCase();
  if (/wine/.test(c) || /\b(gls|btl)\b/i.test(n)) {
    if (/pairing|corkage|flight/i.test(n)) return 'ownCard';
    return /\bgls\b|glass|\(\d\s?oz pour\)/i.test(n) ? 'wineGlass' : 'wineBottle';
  }
  if (/beer/.test(c)) {
    if (/flight/i.test(n)) return 'ownCard';
    return /\bcan\b|bottle|\d+\s?oz/i.test(n) ? 'direct' : 'draft';
  }
  if (/espresso|americano|cappuc+in|latte|macchiato|cortado|cold brew|\bcoffee\b|mocha/i.test(n) && !/corretto|martini|affogato/i.test(n)) return 'coffee';
  return 'ownCard';
}

/**
 * Drafts for the bar items that have no card yet. Price variations of an item share its draft;
 * variations that are a different drink get their own.
 */
export function draftDrinkCards(items: readonly BarItem[], products: readonly BarProduct[], options: DraftOptions = {}): DrinkDraft[] {
  const winePour = options.winePour ?? 6;
  const draftPour = options.draftPour ?? 16;
  const dose = options.espressoDose ?? 18;
  const wines = products.filter((p) => p.type === 'WINE' || (p.unit === 'bottle' && /wine|prosecco|chianti|barbera/i.test(p.name)));
  const kegs = products.filter((p) => p.unit === 'keg' && !/deposit/i.test(p.name));
  // Bought as served: by the can or bottle, not by the gallon or pound.
  const packaged = products.filter((p) => (p.type === 'BEER' || p.type === 'NA_BEVERAGES') && ['can', 'bottle', 'each'].includes(p.unit) && !/deposit|juice/i.test(p.name));
  const beans = products.find((p) => /coffee/i.test(p.name) && /whole bean/i.test(p.name) && !/decaf/i.test(p.name)) ?? products.find((p) => /coffee/i.test(p.name) && !/decaf|instant/i.test(p.name));
  const milk = products.find((p) => /milk, whole|whole milk/i.test(p.name)) ?? products.find((p) => /^milk\b/i.test(p.name) && !/almond|oat|soy|powder/i.test(p.name));

  // Group an item's price variations together.
  const groups = new Map<string, BarItem[]>();
  for (const it of items) {
    const own = it.variationName && OWN_VARIATION.test(it.variationName);
    const key = own ? `${it.itemName}|${it.variationName}` : it.itemName;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }

  const out: DrinkDraft[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const own = key.includes('|');
    const name = own ? `${first.itemName} (${first.variationName})` : first.itemName;
    let shape = own ? 'ownCard' as DrinkShape : shapeOf(first);
    let matches: DrinkDraft['matches'] = [];
    let ingredients: DrinkDraft['ingredients'] = [];
    if (shape === 'wineGlass' || shape === 'wineBottle') {
      matches = matchesFor(first.itemName, wines, WINE_NOISE);
      const pour = first.itemName.match(/\((\d+(?:\.\d+)?)\s?oz pour\)/i);
      if (matches[0]) ingredients = shape === 'wineGlass' ? [{ amount: pour ? Number(pour[1]) : winePour, unit: 'floz', name: matches[0].name }] : [{ amount: 1, unit: 'bottle', name: matches[0].name }];
    } else if (shape === 'draft') {
      matches = matchesFor(first.itemName, kegs, BEER_NOISE);
      if (matches[0]) ingredients = [{ amount: draftPour, unit: 'floz', name: matches[0].name }];
    } else if (shape === 'coffee') {
      if (beans) ingredients.push({ amount: /double|doppio/i.test(first.itemName) ? dose * 2 : dose, unit: 'g', name: beans.name });
      const milkOz = /latte/i.test(first.itemName) ? 8 : /cappuc/i.test(first.itemName) ? 5 : /macchiato|cortado/i.test(first.itemName) ? 2 : 0;
      if (milkOz && milk) ingredients.push({ amount: milkOz, unit: 'floz', name: milk.name });
      matches = beans ? [{ id: beans.id, name: beans.name, score: 1 }] : [];
    } else if (shape === 'ownCard' && !own && /non-?alcoholic|drink|beer/i.test(first.category)) {
      // A soda or NA beer bought as it's served is a direct sale.
      const m = matchesFor(first.itemName, packaged, BEER_NOISE);
      if (m[0] && m[0].score >= 0.65) { shape = 'direct'; matches = m; }
    }
    if (shape === 'direct' && !matches.length) matches = matchesFor(first.itemName, packaged, BEER_NOISE);
    if (shape === 'direct' && matches[0]) {
      const p = products.find((x) => x.id === matches[0]!.id)!;
      ingredients = [{ amount: 1, unit: p.unit, name: p.name }];
    }
    out.push({
      shape, name, category: first.category,
      items: group.map((g) => ({ catalogId: g.catalogId, itemName: g.itemName, ...(g.variationName ? { variationName: g.variationName } : {}) })),
      netSales: Math.round(group.reduce((s, g) => s + g.netSales, 0) * 100) / 100,
      quantity: group.reduce((s, g) => s + g.quantity, 0),
      matches, ingredients,
      check: shape !== 'ownCard' && shape !== 'coffee' && (!matches[0] || matches[0].score < 0.8 || (matches[1] !== undefined && matches[1].score >= matches[0].score - 0.05)),
    });
  }
  return out.sort((a, b) => b.netSales - a.netSales);
}
