/**
 * Containers and weights. Weight is the base: a container's volume only tells what it holds of a
 * liquid, so what counts for a prep item is what a full one of that item weighs. The containers list
 * keeps names straight (a "1/9 pan" vs a "deep 1/9 pan"); their volumes are typical sizes, to check.
 */
import { convert, normalizeUnit, tryConvert, dimensionOf, type ItemConversions } from './units.ts';

export interface Container { id?: string; name: string; aliases: string[]; volumeMl?: number; note?: string }

const qt = 946.352946, floz = 29.5735295625;
/** Typical capacities (hotel pans by depth, deli containers, Cambros): to be checked against yours. */
export const DEFAULT_CONTAINERS: Container[] = [
  { name: '1/9 pan', aliases: ['ninth pan', '1/9', '9th pan', 'shallow 1/9 pan', '1/9 pan 2.5in'], volumeMl: Math.round(0.9 * qt), note: '2½" deep' },
  { name: 'deep 1/9 pan', aliases: ['deep ninth pan', 'deep 1/9', '1/9 pan 4in'], volumeMl: Math.round(1.3 * qt), note: '4" deep' },
  { name: '1/6 pan', aliases: ['sixth pan', '1/6', '6th pan', 'shallow 1/6 pan', '1/6 pan 2.5in'], volumeMl: Math.round(1.6 * qt), note: '2½" deep' },
  { name: 'deep 1/6 pan', aliases: ['deep sixth pan', 'deep 1/6', '1/6 pan 4in'], volumeMl: Math.round(2.4 * qt), note: '4" deep' },
  { name: '1/6 pan 6in', aliases: ['extra deep 1/6 pan', '6in 1/6 pan'], volumeMl: Math.round(3.4 * qt), note: '6" deep' },
  { name: '1/4 pan', aliases: ['fourth pan', '1/4', 'quarter pan'], volumeMl: Math.round(2.3 * qt), note: '2½" deep' },
  { name: 'deep 1/4 pan', aliases: ['deep fourth pan', 'deep 1/4'], volumeMl: Math.round(3.7 * qt), note: '4" deep' },
  { name: '1/3 pan', aliases: ['third pan', '1/3', '3rd pan'], volumeMl: Math.round(3.3 * qt), note: '2½" deep' },
  { name: 'deep 1/3 pan', aliases: ['deep third pan', 'deep 1/3'], volumeMl: Math.round(4.5 * qt), note: '4" deep' },
  { name: '1/2 pan', aliases: ['half pan', '1/2', 'hotel half'], volumeMl: Math.round(4.1 * qt), note: '2½" deep' },
  { name: 'deep 1/2 pan', aliases: ['deep half pan', 'deep 1/2'], volumeMl: Math.round(6.6 * qt), note: '4" deep' },
  { name: 'full pan', aliases: ['hotel pan', '1/1 pan'], volumeMl: Math.round(8.3 * qt), note: '2½" deep' },
  { name: 'deli 8 oz', aliases: ['8 oz deli', 'half pint deli', '8oz deli'], volumeMl: Math.round(8 * floz) },
  { name: 'deli pint', aliases: ['pint deli', '16 oz deli', 'deli 16 oz'], volumeMl: Math.round(16 * floz) },
  { name: 'deli quart', aliases: ['quart deli', '32 oz deli', 'deli 32 oz'], volumeMl: Math.round(32 * floz) },
  { name: 'cambro 2 qt', aliases: ['2 qt cambro'], volumeMl: Math.round(2 * qt) },
  { name: 'cambro 4 qt', aliases: ['4 qt cambro'], volumeMl: Math.round(4 * qt) },
  { name: 'cambro 6 qt', aliases: ['6 qt cambro'], volumeMl: Math.round(6 * qt) },
  { name: 'cambro 8 qt', aliases: ['8 qt cambro'], volumeMl: Math.round(8 * qt) },
  { name: 'cambro 12 qt', aliases: ['12 qt cambro'], volumeMl: Math.round(12 * qt) },
  { name: 'cambro 22 qt', aliases: ['22 qt cambro'], volumeMl: Math.round(22 * qt) },
  { name: 'squeeze bottle', aliases: ['squeeze', 'bottle', 'squeeze bottle 16 oz'], volumeMl: Math.round(16 * floz), note: '16 oz' },
];

const key = (s: string) => s.trim().toLowerCase().replace(/[()]/g, ' ').replace(/["”]/g, 'in').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
/** The container a unit names ("1/9 Pan", "ninth pan", "Deep 1/9"), if any. */
export function findContainer(unit: string | undefined, containers: Container[]): Container | undefined {
  if (!unit) return undefined;
  const k = key(unit);
  return containers.find((c) => key(c.name) === k || c.aliases.some((a) => key(a) === k));
}

/** The fixed conversions, shown on the Units page: they never change. */
export const FIXED_CONVERSIONS = {
  volume: [['1 tbsp', '3 tsp'], ['1 fl oz', '2 tbsp'], ['1 cup', '8 fl oz'], ['1 pt', '2 cups · 16 fl oz'], ['1 qt', '2 pt · 32 fl oz'], ['1 gal', '4 qt · 128 fl oz'], ['1 l', '1,000 ml · 33.8 fl oz'], ['1 fl oz', '29.57 ml']],
  weight: [['1 lb', '16 oz'], ['1 oz', '28.35 g'], ['1 kg', '1,000 g · 2.2 lb'], ['1 lb', '453.6 g']],
} as const;

export type WeightSource = 'weighed' | 'unit' | 'recipe';

/**
 * What a recipe's output weighs, to weigh its containers by: the batch's weight when the recipe states
 * one ("makes 4,000 g or one 1/3 pan"), else what its ingredients weigh; and its conversions, with a
 * density worked out from that weight when it makes a volume (a syrup's sugar and water over the quarts).
 */
export interface RecipeWeight { batchGrams: number; stated: boolean; conversions: ItemConversions }

/** Every way a recipe names its batch: its yield and the units its conversions state in terms of it ("1 batch = 3,950 g"). */
function yieldsOf(yieldQty: { amount: number; unit: string }, conversions: ItemConversions | undefined): { amount: number; unit: string }[] {
  const out = [yieldQty];
  const first = normalizeUnit(yieldQty.unit);
  for (const [u, q] of Object.entries(conversions?.customUnits ?? {})) {
    // 1 u = q of the yield's unit, so the batch is yield.amount / q.amount of u.
    if (q.amount > 0 && normalizeUnit(q.unit) === first) out.push({ amount: yieldQty.amount / q.amount, unit: u });
  }
  return out;
}

export function recipeWeight(yieldQty: { amount: number; unit: string }, conversions: ItemConversions | undefined, ingredientGrams: number | undefined): RecipeWeight | undefined {
  const yields = yieldsOf(yieldQty, conversions);
  const dim = (u: string) => dimensionOf(normalizeUnit(u));
  // A weight the recipe states, under any of its names, before what the ingredients add up to.
  let statedGrams = tryConvert(yieldQty, 'g', conversions);
  if (!(statedGrams && statedGrams > 0)) { const m = yields.find((y) => dim(y.unit) === 'mass'); statedGrams = m ? convert({ amount: m.amount, unit: normalizeUnit(m.unit) }, 'g') : undefined; }
  let batchGrams = statedGrams && statedGrams > 0 ? statedGrams : ingredientGrams;
  const vol = yields.find((y) => dim(y.unit) === 'volume');
  const volMl = vol ? convert({ amount: vol.amount, unit: normalizeUnit(vol.unit) }, 'ml') : undefined;
  // What goes in isn't always what comes out (whey off ricotta, a sauce cooked down, an ingredient that can't be
  // weighed yet): when that puts a volume yield outside what food weighs (0.6 to 1.4 g per ml), call it water weight.
  if (!(statedGrams && statedGrams > 0) && volMl && volMl > 0 && (!batchGrams || batchGrams / volMl < 0.6 || batchGrams / volMl > 1.4)) batchGrams = volMl;
  if (!batchGrams || !(batchGrams > 0)) return undefined;
  // Everything in grams: each of its own units ("(1/3) pan", "batch", "portion"), a density from a volume yield, a piece weight from a count.
  const customUnits: Record<string, { amount: number; unit: string }> = {};
  for (const y of yields) if (!dim(y.unit) && y.amount > 0) customUnits[y.unit] = { amount: batchGrams / y.amount, unit: 'g' };
  if (!Object.keys(customUnits).some((u) => key(u) === 'batch')) customUnits.batch = { amount: batchGrams, unit: 'g' };
  const each = yields.find((y) => dim(y.unit) === 'count');
  const gramsPerMl = conversions?.gramsPerMl ?? (volMl ? batchGrams / volMl : undefined);
  const gramsPerEach = conversions?.gramsPerEach ?? (each ? batchGrams / convert({ amount: each.amount, unit: normalizeUnit(each.unit) }, 'each') : undefined);
  return { batchGrams, stated: Boolean(statedGrams && statedGrams > 0), conversions: { customUnits, ...(gramsPerMl ? { gramsPerMl } : {}), ...(gramsPerEach ? { gramsPerEach } : {}) } };
}

/**
 * What one unit of a prep item weighs, in grams, and where that comes from: weighed by someone (best);
 * the unit itself is a weight (lb, oz, g); or the item's recipe: its own yields ("one 1/3 pan = 4,000 g"),
 * or a standard volume or the container's typical size times what the recipe weighs per volume.
 */
export function unitWeight(unit: string | undefined, weighed: number | undefined, recipe: RecipeWeight | undefined, containers: Container[]): { grams: number; source: WeightSource } | undefined {
  if (weighed && weighed > 0) return { grams: weighed, source: 'weighed' };
  if (!unit) return undefined;
  const u = normalizeUnit(unit);
  if (dimensionOf(u) === 'mass') return { grams: convert({ amount: 1, unit: u }, 'g'), source: 'unit' };
  if (!recipe) return undefined;
  // The recipe's own units, under any name the container goes by ("(1/3) pan" in the recipe, "third pan" on the list).
  const c = findContainer(unit, containers);
  const names = [unit, ...(c ? [c.name, ...c.aliases] : [])];
  const custom = Object.keys(recipe.conversions.customUnits ?? {});
  for (const n of names) {
    const asNamed = custom.find((x) => key(x) === key(n)) ?? n;
    const g = tryConvert({ amount: 1, unit: asNamed }, 'g', recipe.conversions);
    if (g && g > 0) return { grams: g, source: 'recipe' };
  }
  // A density from the recipe's own container ("one 1/3 pan = 4,000 g" over a 1/3 pan's typical size), when it states no volume.
  let density = recipe.conversions.gramsPerMl;
  if (!density) for (const u of custom) {
    const rc = findContainer(u, containers), g = tryConvert({ amount: 1, unit: u }, 'g', recipe.conversions);
    if (rc?.volumeMl && g && g > 0) { density = g / rc.volumeMl; break; }
  }
  const ml = c?.volumeMl;
  return density && ml ? { grams: ml * density, source: 'recipe' } : undefined;
}

/** Grams for display: pounds from a pound up (one decimal), grams below. */
export function weightText(grams: number): string {
  if (!(grams > 0)) return '';
  const lb = grams / 453.59237;
  return lb >= 1 ? `${lb >= 10 ? Math.round(lb) : Math.round(lb * 10) / 10} lb` : `${Math.round(grams)} g`;
}
