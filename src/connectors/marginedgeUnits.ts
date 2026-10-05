/**
 * Making sense of MarginEdge's units, which are free text:
 *
 *   "Pound", "Each", "100 Each", "4 Gallons", "Bottle (750 Milliliters)",
 *   "Can (12 Fluid Ounces)", "Keg (1/6BBL) 5.16GAL", "Almonds, Sliced (Pound)", "Bunch"
 *
 * and pack sizes, which come as a unit (EACH, POUND, BOTTLE, KEG_ONE_SIXTH...) plus a name
 * that often holds the container size ("750ML Btl", "Case/6/1KG", "EA/2KG").
 */

import { dimensionOf, normalizeUnit, type ItemConversions, type Quantity } from '../core/units.ts';

/** Containers we treat as units of their own, sized per product when we can tell. */
const CONTAINERS = new Set(['bottle', 'can', 'case', 'keg', 'box', 'bag', 'jar', 'container', 'tub', 'bucket', 'pail', 'carton', 'bunch', 'flat', 'clamshell', 'tray']);

const WORDS: Record<string, string> = {
  pound: 'lb', lb: 'lb', lbs: 'lb',
  ounce: 'oz', oz: 'oz',
  gram: 'g', kilogram: 'kg', kg: 'kg',
  each: 'each', ea: 'each', count: 'each', ct: 'each', piece: 'each', dozen: 'dozen',
  'fluid ounce': 'floz', 'fl oz': 'floz', floz: 'floz',
  milliliter: 'ml', millilitre: 'ml', ml: 'ml',
  liter: 'l', litre: 'l', l: 'l', lt: 'l', ltr: 'l',
  gallon: 'gal', gal: 'gal', quart: 'qt', qt: 'qt', pint: 'pt', pt: 'pt', cup: 'cup',
};

/** One unit word ("Pounds", "Fluid Ounces", "Bottle") → our unit name, or undefined. */
export function unitWord(raw: string): string | undefined {
  let word = raw.trim().toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ');
  if (!word) return undefined;
  if (word in WORDS) return WORDS[word];
  const singular = word.replace(/(es|s)$/, '');
  for (const candidate of [word.replace(/s$/, ''), singular]) {
    if (candidate in WORDS) return WORDS[candidate];
    if (CONTAINERS.has(candidate)) return candidate;
  }
  if (CONTAINERS.has(word)) return word;
  const normalized = normalizeUnit(word);
  return dimensionOf(normalized) ? normalized : undefined;
}

/** "750 Milliliters", "5.16GAL", "Liter" → a quantity, or undefined. */
export function parseAmount(raw: string): Quantity | undefined {
  const text = raw.trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z][a-zA-Z .]*)$/);
  if (match) {
    const unit = unitWord(match[2]!);
    return unit ? { amount: Number(match[1]), unit } : undefined;
  }
  const unit = unitWord(text);
  return unit && dimensionOf(unit) ? { amount: 1, unit } : undefined;
}

export interface ReportUnit {
  /** The unit we track the product in. */
  baseUnit?: string;
  /** How many base units MarginEdge's "latest price" covers: 100 for "100 Each". */
  priceCovers: number;
  conversions: ItemConversions;
}

/** Reads a product's "report by" unit. */
export function parseReportUnit(raw: string | undefined): ReportUnit {
  const none: ReportUnit = { priceCovers: 1, conversions: {} };
  const text = (raw ?? '').trim();
  if (!text || /^other$/i.test(text)) return none;

  // "Bottle (750 Milliliters)", "Keg (1/6BBL) 5.16GAL", "Almonds, Sliced (Pound)", " (9 Each)"
  const wrapped = text.match(/^(.*?)\s*\(([^)]*)\)\s*(.*)$/);
  if (wrapped) {
    const [, outside = '', inside = '', after = ''] = wrapped;
    const container = unitWord(outside);
    const size = parseAmount(inside) ?? parseAmount(after);
    if (container && CONTAINERS.has(container)) {
      return {
        baseUnit: container,
        priceCovers: 1,
        conversions: size ? { customUnits: { [container]: size } } : {},
      };
    }
    // Not a container: the bracket names the unit itself, e.g. "Almonds, Sliced (Pound)" or "(9 Each)".
    if (size) return { baseUnit: size.unit, priceCovers: size.amount, conversions: {} };
    return none;
  }

  // "100 Each", "4 Gallons", "6 Bottles", "200 Milliliters"
  const counted = text.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (counted) {
    const unit = unitWord(counted[2]!);
    return unit ? { baseUnit: unit, priceCovers: Number(counted[1]), conversions: {} } : none;
  }

  const unit = unitWord(text);
  return unit ? { baseUnit: unit, priceCovers: 1, conversions: {} } : none;
}

const PACK_UNITS: Record<string, { unit: string; size?: Quantity }> = {
  EACH: { unit: 'each' },
  POUND: { unit: 'lb' },
  OUNCE: { unit: 'oz' },
  KILOGRAM: { unit: 'kg' },
  GRAM: { unit: 'g' },
  GALLON: { unit: 'gal' },
  QUART: { unit: 'qt' },
  PINT: { unit: 'pt' },
  LITER: { unit: 'l' },
  MILLILITER: { unit: 'ml' },
  FLUID_OUNCE: { unit: 'floz' },
  BOTTLE: { unit: 'bottle' },
  CAN: { unit: 'can' },
  BOX: { unit: 'box' },
  CASE: { unit: 'case' },
  BAG: { unit: 'bag' },
  BUNCH: { unit: 'bunch' },
  KEG_ONE_SIXTH: { unit: 'keg', size: { amount: 5.16, unit: 'gal' } },
  KEG_ONE_QUARTER: { unit: 'keg', size: { amount: 7.75, unit: 'gal' } },
  KEG_ONE_HALF: { unit: 'keg', size: { amount: 15.5, unit: 'gal' } },
};

/** The size written at the end of a pack name: "Case/6/750ML Btl" → 750 ml, "EA/2KG" → 2 kg. */
export function sizeInPackName(name: string | undefined, containerUnit: string): Quantity | undefined {
  if (!name) return undefined;
  const last = name.split('/').at(-1)!.trim();
  const match = last.match(/(?<![\d/.])(\d+(?:\.\d+)?)\s*(ML|LTR|LT|L|FL ?OZ|OZ|LBS?|#|KG|GM|G|GAL|QT|PT)(?![a-z])/i);
  if (!match) return undefined;
  let unit = match[2]!.toUpperCase().replace(/\s/g, '');
  // Ounces on a bottle or can are fluid ounces.
  if (unit === 'OZ' && (containerUnit === 'bottle' || containerUnit === 'can')) unit = 'FLOZ';
  const mapped = unit === '#' ? 'lb' : unit === 'GM' ? 'g' : unitWord(unit);
  return mapped ? { amount: Number(match[1]), unit: mapped } : undefined;
}

const OUTER: Record<string, string> = { case: 'case', cs: 'case', ea: 'each', each: 'each', pack: 'pack', pk: 'pack', bag: 'bag', box: 'box', bx: 'box', tub: 'tub', jar: 'jar' };

/**
 * The structure of a pack name: "Case/6/1KG" is one case of 6 items of 1 kg each;
 * "EA/2LB" is one item of 2 lb; "Case/13.2LB" is one case of 13.2 lb.
 */
export function packNameStructure(name: string | undefined): { outer?: string; count: number; itemSize?: Quantity } {
  const segments = (name ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return { count: 1 };
  const outer = OUTER[segments[0]!.toLowerCase()];
  const count = segments.length >= 3 && /^\d+(\.\d+)?$/.test(segments[1]!) ? Number(segments[1]) : 1;
  return { outer, count, itemSize: sizeInPackName(segments.at(-1), 'each') };
}

export interface PackReading {
  /** Ways to express what one purchased unit holds, most specific first. */
  candidates: Quantity[];
  /** Facts the pack teaches about the product (bottle = 750 ml, each = 2 kg). */
  teaches: ItemConversions;
  unknownUnit?: string;
}

/** What one purchased pack holds, e.g. { unit: BOTTLE, quantity: 6, name: "Case/6/750ML Btl" }. */
export function readPack(pack: { unit?: string; quantity?: number; packagingName?: string }): PackReading {
  const quantity = pack.quantity && pack.quantity > 0 ? pack.quantity : 1;
  const known = PACK_UNITS[(pack.unit ?? '').toUpperCase()];
  if (!known) return { candidates: [], teaches: {}, unknownUnit: pack.unit };

  const candidates: Quantity[] = [];
  const teaches: ItemConversions = {};
  const structure = packNameStructure(pack.packagingName);

  if (dimensionOf(known.unit) && known.unit !== 'each') {
    candidates.push({ amount: quantity, unit: known.unit });
  } else {
    // A count of containers (or "each"): the name may say how big each one is.
    const size = known.size ?? sizeInPackName(pack.packagingName, known.unit);
    if (size) {
      candidates.push({ amount: quantity * size.amount, unit: size.unit });
      if (known.unit !== 'each') teaches.customUnits = { [known.unit]: size };
    }
    candidates.push({ amount: quantity, unit: known.unit });
  }

  // The pack as a whole ("1 case") and as a count of items ("6 each"), for products tracked that way.
  if (structure.outer && structure.outer !== 'each') candidates.push({ amount: 1, unit: structure.outer });
  if (structure.outer) candidates.push({ amount: structure.count, unit: 'each' });
  // "EA/2KG", "Case/6/1KG": one item weighs the inner size.
  if (structure.itemSize && dimensionOf(structure.itemSize.unit) === 'mass') teaches.gramsPerEach = toGrams(structure.itemSize);
  // "Case/10LB" measured in pounds: a case holds 10 lb.
  if (structure.outer && structure.outer !== 'each' && candidates[0] && dimensionOf(candidates[0].unit) && candidates[0].unit !== 'each') {
    teaches.customUnits = { ...teaches.customUnits, [structure.outer]: candidates[0] };
  }

  return { candidates: dedupe(candidates), teaches };
}

function dedupe(quantities: Quantity[]): Quantity[] {
  const seen = new Set<string>();
  return quantities.filter((q) => {
    const key = `${q.amount}|${q.unit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sizes in an item's own name, for vendors without pack data: "Limes 40LB", "Beet 24Ct". */
export function sizeInItemName(name: string | undefined): Quantity | undefined {
  if (!name) return undefined;
  const matches = [...name.matchAll(/(?<![\d/.])(\d+(?:\.\d+)?)\s*(lbs?|#|kg|oz|ct|count|ea)(?![a-z])/gi)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const raw = match[2]!.toLowerCase();
  const unit = raw === '#' ? 'lb' : unitWord(raw);
  return unit ? { amount: Number(match[1]), unit } : undefined;
}

function toGrams(quantity: Quantity): number {
  const factors: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
  return quantity.amount * (factors[quantity.unit] ?? Number.NaN);
}

/** One item weighs this much (from a size like "4lb"), as a conversion fact. */
export function gramsPerEachFrom(size: Quantity): number | undefined {
  const grams = toGrams(size);
  return Number.isFinite(grams) && grams > 0 ? grams : undefined;
}

/**
 * Typical densities (g per ml) for ingredients bought by weight but measured by volume, or the
 * reverse. Used only when nothing better is known; a chef's answer replaces them.
 */
const DENSITIES: [RegExp, number][] = [
  [/\bwater\b/i, 1.0],
  [/\bhoney\b/i, 1.42],
  [/\b(syrup|molasses|agave)\b/i, 1.33],
  [/\bvinegar\b/i, 1.01],
  [/\boil\b/i, 0.92],
  [/\b(heavy )?cream\b/i, 0.99],
  [/\bmilk\b/i, 1.03],
  [/\bjuice\b/i, 1.04],
  [/\b(wine|pinot|grigio|vermouth)\b/i, 0.99],
  [/\b(stock|broth)\b/i, 1.0],
];

export function typicalDensity(name: string): number | undefined {
  return DENSITIES.find(([pattern]) => pattern.test(name))?.[1];
}

/** Merges facts without overwriting ones already known. */
export function mergeConversions(target: ItemConversions, extra: ItemConversions): ItemConversions {
  const merged: ItemConversions = { ...target, customUnits: { ...(target.customUnits ?? {}) } };
  if (merged.gramsPerEach === undefined && extra.gramsPerEach && Number.isFinite(extra.gramsPerEach)) merged.gramsPerEach = extra.gramsPerEach;
  if (merged.gramsPerMl === undefined && extra.gramsPerMl) merged.gramsPerMl = extra.gramsPerMl;
  for (const [name, size] of Object.entries(extra.customUnits ?? {})) {
    if (!(name in merged.customUnits!)) merged.customUnits![name] = size;
  }
  if (Object.keys(merged.customUnits!).length === 0) delete merged.customUnits;
  return merged;
}
