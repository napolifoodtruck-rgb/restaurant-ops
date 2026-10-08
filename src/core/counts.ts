/**
 * Counting stock the way it's kept: "2 cases + 5 lb", "3 × 1/9 pan", "0.4 of a bottle". Each part is
 * turned into the item's own unit (what it's costed in), through its packs (a case of 6 #10 cans, a
 * 50 lb bag) and its conversions.
 */

import { tryConvert, type ItemConversions, type Quantity } from './units.ts';

/** A pack it comes in, from its invoices: one "case" holds 6 each. */
export interface Pack { unit: string; label: string; per: Quantity }

export interface CountPart { amount: number; unit: string }

/** What the parts come to in the base unit, or undefined when one of them doesn't convert. */
export function countedAmount(parts: readonly CountPart[], base: string, conversions: ItemConversions | undefined, packs: readonly Pack[] = []): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (!(p.amount >= 0)) return undefined;
    if (p.amount === 0) continue;
    const pack = packs.find((k) => k.unit === p.unit);
    const q: Quantity = pack ? { amount: p.amount * pack.per.amount, unit: pack.per.unit } : { amount: p.amount, unit: p.unit };
    const v = tryConvert(q, base, conversions);
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

const PACK_WORDS: Record<string, string> = {
  cs: 'case', case: 'case', cases: 'case', ca: 'case', bx: 'box', box: 'box', bg: 'bag', bag: 'bag', bags: 'bag', sk: 'sack', sack: 'sack',
  pk: 'pack', pack: 'pack', pkg: 'pack', ct: 'pack', btl: 'bottle', bottle: 'bottle', bt: 'bottle', keg: 'keg', kg_keg: 'keg', tub: 'tub', jar: 'jar',
  can: 'can', cn: 'can', bucket: 'bucket', pail: 'pail', jug: 'jug', tray: 'tray', flat: 'flat', bunch: 'bunch', bn: 'bunch', head: 'head', block: 'block', loaf: 'loaf',
};

/**
 * The packs an item comes in, from invoice lines as printed (unit "CS", one holds 6 each), newest
 * first. A line in a plain unit ("LB", one holds 1 lb) isn't a pack.
 */
export function packsFrom(lines: readonly { unit: string | null; perAmount: number; perUnit: string | null }[]): Pack[] {
  const out: Pack[] = [];
  for (const l of lines) {
    const word = PACK_WORDS[(l.unit ?? '').toLowerCase().replace(/[^a-z_]/g, '')];
    if (!word || !l.perUnit || !(l.perAmount > 0) || out.some((p) => p.unit === word)) continue;
    if (word === l.perUnit && l.perAmount === 1) continue;
    out.push({ unit: word, label: `${word} (${+l.perAmount.toFixed(3)} ${l.perUnit})`, per: { amount: l.perAmount, unit: l.perUnit } });
  }
  return out;
}

/** "2 case + 5 lb" as said. */
export function partsText(parts: readonly CountPart[]): string {
  return parts.filter((p) => p.amount > 0).map((p) => `${+p.amount.toFixed(2)} ${p.unit}`).join(' + ') || '0';
}

/** Words for what a shelf holds, matched loosely against an item's name and category ("vegetables" finds Produce). */
const ALIKE: Record<string, RegExp> = {
  vegetable: /produce|vegetable|veg\b|greens|herb|lettuce|arugula|onion|garlic|pepper|tomato|squash|mushroom|basil|shallot|spinach|kale|potato|carrot|celery|corn|brussels|fruit|lemon|lime/i,
  dairy: /dairy|cheese|milk|cream|butter|mozz|ricotta|parm|burrata|yogurt|egg/i,
  meat: /meat|pork|beef|lamb|sausage|salumi|salami|prosciutto|pepperoni|coppa|bresaola|chicken|poultry|bacon|guanciale|chorizo|merguez/i,
  frozen: /frozen|ice cream|gelato/i,
  flour: /flour/i, sugar: /sugar/i, dextrose: /dextrose/i, maltodextrin: /maltodextrin/i, tomato: /tomato/i,
  oil: /\boil\b|olive/i, vinegar: /vinegar|balsamic|saba/i, spice: /spice|pepper flake|chili|oregano|salt|seed|powder|paprika|cumin|fennel|urfa/i,
  puree: /pur[eé]e/i, box: /box|carton|container|cup|lid|bag|napkin|straw|fork|spoon|knife|utensil/i,
  keg: /keg|draft|draught/i, gelato: /gelato|pint/i, dough: /dough/i, wine: /wine/i, beer: /beer|ale|lager|ipa|pilsner|saison/i,
  liquor: /liquor|spirit|vodka|gin|rum|whiskey|whisky|bourbon|tequila|mezcal|amaro|vermouth|aperol|campari|liqueur|brandy|cognac/i,
  cleaning: /clean|sanit|soap|detergent|bleach|degreaser|chemical|glove|towel|trash|liner/i,
};
export function looksLikeItHere(holds: string | null | undefined, name: string, category?: string | null): boolean {
  if (!holds) return false;
  const text = `${name} ${category ?? ''}`;
  return holds.toLowerCase().split(/[,;/&:]|\band\b/).map((w) => w.trim().replace(/s$/, '')).filter((w) => w && !/prep/.test(w)).some((w) => {
    const keys = Object.keys(ALIKE).filter((k) => w.includes(k) || (w.length > 3 && k.includes(w)));
    return keys.length ? keys.some((k) => ALIKE[k]!.test(text)) : w.length > 2 && text.toLowerCase().includes(w);
  });
}

/** Where a prep goes: dough with the dough, frozen prep (meatballs, sausage) in the freezer, the rest with the prepped items. */
export function prepSpot<T extends { holds: string | null; name: string }>(name: string, spots: readonly T[]): T | undefined {
  const holds = (x: T, re: RegExp) => re.test(x.holds ?? '') || re.test(x.name);
  if (/dough/i.test(name)) { const x = spots.find((s) => holds(s, /dough/i)); if (x) return x; }
  if (/meatball|sausage|merguez|frozen/i.test(name)) { const x = spots.find((s) => holds(s, /frozen prep/i)); if (x) return x; }
  return spots.find((s) => holds(s, /prep/i));
}

/** Units in the order they're counted: packs first (bag, case), then the item's own unit, then the rest. */
export function countUnits(base: string, units: readonly string[], packs: readonly Pack[]): string[] {
  const packish = units.filter((u) => Object.values(PACK_WORDS).includes(u));
  return [...new Set([...packs.map((p) => p.unit), ...packish, base, ...units])];
}
