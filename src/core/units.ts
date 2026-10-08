/**
 * Units and conversions in the language of a kitchen.
 *
 * Every standard unit belongs to one dimension (mass, volume or count) and has a
 * factor to that dimension's base unit (grams, millilitres, each). Converting
 * between dimensions needs facts about the specific item: how much a millilitre
 * of it weighs, or how much one piece weighs. Kitchen containers ("sixth pan",
 * "case") are custom units defined per item, because a sixth pan of aioli and a
 * case of onions mean nothing on their own.
 *
 * When a conversion is impossible, a ConversionError says exactly which fact is
 * missing, so the system can turn it into a single question for the chef.
 */

export type Dimension = 'mass' | 'volume' | 'count';

export interface Quantity {
  amount: number;
  unit: string;
}

/** Facts about one product or recipe output that allow conversions across dimensions. */
export interface ItemConversions {
  /** Density: grams per millilitre (water is 1). Bridges volume and mass. */
  gramsPerMl?: number;
  /** Weight of one piece (one onion, one portioned steak). Bridges count and mass. */
  gramsPerEach?: number;
  /** Item-specific units, e.g. "sixth pan" = 2 qt, "case" = 50 lb. */
  customUnits?: Record<string, Quantity>;
}

interface StandardUnit {
  dimension: Dimension;
  /** Multiply by this to get grams, millilitres or each. */
  toBase: number;
}

const STANDARD_UNITS: Record<string, StandardUnit> = {
  // mass, base: gram
  g: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  oz: { dimension: 'mass', toBase: 28.349523125 },
  lb: { dimension: 'mass', toBase: 453.59237 },
  // volume, base: millilitre (US customary)
  ml: { dimension: 'volume', toBase: 1 },
  l: { dimension: 'volume', toBase: 1000 },
  tsp: { dimension: 'volume', toBase: 4.92892159375 },
  tbsp: { dimension: 'volume', toBase: 14.78676478125 },
  floz: { dimension: 'volume', toBase: 29.5735295625 },
  cup: { dimension: 'volume', toBase: 236.5882365 },
  pt: { dimension: 'volume', toBase: 473.176473 },
  qt: { dimension: 'volume', toBase: 946.352946 },
  gal: { dimension: 'volume', toBase: 3785.411784 },
  // count, base: each
  each: { dimension: 'count', toBase: 1 },
  dozen: { dimension: 'count', toBase: 12 },
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gr: 'g',
  kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb', '#': 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
  cups: 'cup', c: 'cup',
  pint: 'pt', pints: 'pt',
  quart: 'qt', quarts: 'qt', qts: 'qt',
  gallon: 'gal', gallons: 'gal',
  ea: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each', portion: 'each', portions: 'each',
  dz: 'dozen', doz: 'dozen',
};

/** Lowercases, trims and resolves common spellings ("Quarts", "lbs", "#") to one name. */
export function normalizeUnit(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[key] ?? key;
}

export function isStandardUnit(unit: string): boolean {
  return normalizeUnit(unit) in STANDARD_UNITS;
}

export function dimensionOf(unit: string): Dimension | undefined {
  return STANDARD_UNITS[normalizeUnit(unit)]?.dimension;
}

export type MissingFact = 'gramsPerMl' | 'gramsPerEach' | 'unknownUnit' | 'customUnitLoop';

export class ConversionError extends Error {
  readonly needed: MissingFact;
  readonly from: string;
  readonly to: string;

  constructor(needed: MissingFact, from: string, to: string, message: string) {
    super(message);
    this.name = 'ConversionError';
    this.needed = needed;
    this.from = from;
    this.to = to;
  }
}

function customUnitsOf(conversions?: ItemConversions): Map<string, Quantity> {
  const map = new Map<string, Quantity>();
  for (const [name, definition] of Object.entries(conversions?.customUnits ?? {})) {
    map.set(normalizeUnit(name), definition);
  }
  return map;
}

/** Rewrites a quantity in a custom unit into standard units, following chains like case → bag → lb. */
function toStandard(quantity: Quantity, custom: Map<string, Quantity>, original: string, target: string): Quantity {
  let amount = quantity.amount;
  let unit = normalizeUnit(quantity.unit);
  const seen = new Set<string>();
  while (!(unit in STANDARD_UNITS)) {
    const definition = custom.get(unit);
    if (!definition) {
      throw new ConversionError('unknownUnit', original, target, `"${unit}" is not a known unit for this item.`);
    }
    if (seen.has(unit)) {
      throw new ConversionError('customUnitLoop', original, target, `Custom unit "${unit}" is defined in terms of itself.`);
    }
    seen.add(unit);
    amount *= definition.amount;
    unit = normalizeUnit(definition.unit);
  }
  return { amount, unit };
}

/** Converts an amount in a standard unit to the base unit of another dimension. */
function bridge(baseAmount: number, from: Dimension, to: Dimension, conversions: ItemConversions | undefined, fromUnit: string, toUnit: string): number {
  if (from === to) return baseAmount;

  // Go through grams: every bridge is defined against mass.
  let grams: number;
  if (from === 'mass') {
    grams = baseAmount;
  } else if (from === 'volume') {
    grams = baseAmount * requireFact(conversions, 'gramsPerMl', fromUnit, toUnit);
  } else {
    grams = baseAmount * requireFact(conversions, 'gramsPerEach', fromUnit, toUnit);
  }

  if (to === 'mass') return grams;
  if (to === 'volume') return grams / requireFact(conversions, 'gramsPerMl', fromUnit, toUnit);
  return grams / requireFact(conversions, 'gramsPerEach', fromUnit, toUnit);
}

function requireFact(conversions: ItemConversions | undefined, fact: 'gramsPerMl' | 'gramsPerEach', from: string, to: string): number {
  const value = conversions?.[fact];
  if (value === undefined || !(value > 0)) {
    const what = fact === 'gramsPerMl' ? 'how much a given volume of it weighs' : 'how much one piece weighs';
    throw new ConversionError(fact, from, to, `Converting ${from} to ${to} needs to know ${what}.`);
  }
  return value;
}

/**
 * Converts a quantity to another unit for a specific item.
 * Throws ConversionError naming the missing fact when the conversion isn't possible.
 */
export function convert(quantity: Quantity, toUnit: string, conversions?: ItemConversions): number {
  const custom = customUnitsOf(conversions);
  const fromName = normalizeUnit(quantity.unit);
  const toName = normalizeUnit(toUnit);
  if (fromName === toName) return quantity.amount;

  const source = toStandard(quantity, custom, fromName, toName);
  // Express one target unit in standard terms, then divide.
  const targetPerUnit = toStandard({ amount: 1, unit: toName }, custom, fromName, toName);

  const sourceUnit = STANDARD_UNITS[source.unit]!;
  const targetUnit = STANDARD_UNITS[targetPerUnit.unit]!;

  const sourceBase = source.amount * sourceUnit.toBase;
  const inTargetBase = bridge(sourceBase, sourceUnit.dimension, targetUnit.dimension, conversions, fromName, toName);
  return inTargetBase / (targetPerUnit.amount * targetUnit.toBase);
}

/** Like convert, but returns undefined instead of throwing. */
export function tryConvert(quantity: Quantity, toUnit: string, conversions?: ItemConversions): number | undefined {
  try {
    return convert(quantity, toUnit, conversions);
  } catch (error) {
    if (error instanceof ConversionError) return undefined;
    throw error;
  }
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
