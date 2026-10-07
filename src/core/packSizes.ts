/**
 * What a bottle, can or keg holds, when an invoice says only "each": a wine bottle is 750 ml unless
 * its name says otherwise (375 ml, 1.5 L, magnum), liquor 750 ml or what its name says (1 L, 1.75 L),
 * kegs by their barrel size, cans and bottles of beer by the ounces in their name. Assumed sizes,
 * marked as such, so a glass of wine can be poured in fl oz from a bottle bought as "each". Anything a
 * manager answered or MarginEdge knew comes first: this only fills a gap.
 */
import { tryConvert, type ItemConversions } from './units.ts';

export interface PackSize { ml: number; why: string }

const FLOZ = 29.5735295625, GAL = 3785.411784;

/** The size stated in a name: "750ml", "1.5 L", "12 oz", "1/6 bbl", "magnum". */
export function sizeInName(name: string): PackSize | undefined {
  const n = name.toLowerCase();
  const bbl = n.match(/\b1\s*\/\s*([246])\s*(?:bbl|barrel|keg)/);
  if (bbl) return { ml: (31 / Number(bbl[1])) * GAL, why: `1/${bbl[1]} barrel keg` };
  if (/\b(half|1\/2)\s*(bbl|barrel|keg)\b/.test(n)) return { ml: 15.5 * GAL, why: '1/2 barrel keg' };
  if (/\bsixtel\b/.test(n)) return { ml: 5.16 * GAL, why: 'sixtel keg' };
  if (/\bmagnum\b/.test(n)) return { ml: 1500, why: 'magnum' };
  const m = n.match(/(\d+(?:\.\d+)?)\s*(ml|l|lt|ltr|liter|litre|oz|fl\s*oz)\b/);
  if (!m) return undefined;
  const v = Number(m[1]), u = m[2]!.replace(/\s+/g, '');
  const ml = u === 'ml' ? v : u === 'oz' || u === 'floz' ? v * FLOZ : v * 1000;
  // A size in a product name that's really a case count or a weight (24 oz of cheese) isn't a pour.
  return ml >= 50 && ml <= 60_000 ? { ml, why: `${m[1]} ${u === 'floz' ? 'fl oz' : u} in its name` } : undefined;
}

/** The size to assume for a drink bought by the each, bottle or keg, from its type and name. */
export function packSize(name: string, type: string | undefined, unit: string): PackSize | undefined {
  const t = (type ?? '').toUpperCase();
  const drink = ['WINE', 'LIQUOR', 'BEER', 'NA_BEVERAGES'].includes(t) || /\b(wine|vino|prosecco|champagne|vodka|gin|rum|tequila|mezcal|whiske?y|bourbon|amaro|vermouth|aperol|campari|liqueur)\b/i.test(name);
  if (!drink) return undefined;
  if (!['each', 'ea', 'bottle', 'btl', 'keg', 'can'].includes(unit.toLowerCase())) return undefined;
  const stated = sizeInName(name);
  if (stated) return stated;
  if (unit.toLowerCase() === 'keg') return { ml: 15.5 * GAL, why: 'a keg, assumed a 1/2 barrel' };
  if (t === 'WINE' || /\b(wine|vino|prosecco|champagne)\b/i.test(name)) return { ml: 750, why: 'a wine bottle, assumed 750 ml' };
  if (t === 'LIQUOR' || /\b(vodka|gin|rum|tequila|mezcal|whiske?y|bourbon|amaro|vermouth|aperol|campari|liqueur)\b/i.test(name)) return { ml: 750, why: 'a liquor bottle, assumed 750 ml' };
  return undefined;
}

/** A product's conversions with its pack size added, when it can't already be poured by volume. */
export function withPackSize(conversions: ItemConversions | undefined, baseUnit: string, size: PackSize | undefined): ItemConversions | undefined {
  if (!size || tryConvert({ amount: 1, unit: 'floz' }, baseUnit, conversions) !== undefined) return conversions;
  const unit = baseUnit.toLowerCase();
  // "each" is a standard count: bridged through weight at the density of water (it cancels out pouring).
  if (unit === 'each' || unit === 'ea') return { ...(conversions ?? {}), gramsPerMl: conversions?.gramsPerMl ?? 1, gramsPerEach: size.ml * (conversions?.gramsPerMl ?? 1) };
  return { ...(conversions ?? {}), customUnits: { ...(conversions?.customUnits ?? {}), [baseUnit]: { amount: size.ml, unit: 'ml' } } };
}
