/**
 * Breakdowns: one thing in, several weighed things out. A whole fish becomes fillets, trim,
 * bones and waste; a pork shoulder becomes steaks, grind and fat; a case of pineapples
 * becomes cubes and rind.
 *
 * Costing follows the butcher's method rather than splitting by weight (which would price
 * bones like fillets): by-products are valued at what they're worth to the kitchen, waste
 * at nothing, and the main cuts carry the rest, in proportion to weight × relative value.
 * Waste is an output of its own, so it shows instead of hiding inside a yield percentage.
 *
 * Every real breakdown can be weighed and logged; actual yields are compared with the
 * standard, so a falling fillet yield shows up as a fact about the fish, the supplier or
 * the knife work.
 */

import { convert, type Quantity } from './units.ts';
import type { ItemRef, Product, RecipeBook } from './recipes.ts';

export type Valuation =
  /** A main cut: carries the cost left after by-products, by weight × relative value (default 1). */
  | { method: 'main'; relativeValue?: number }
  /** A by-product worth a set price to the kitchen: bones at $0/lb, trim at $4/lb. */
  | { method: 'fixed'; price: number; per: Quantity }
  /** Thrown away: costs nothing on its own; its weight is paid for by the main cuts. */
  | { method: 'waste' };

export interface BreakdownOutput {
  name: string;
  /** What it becomes in inventory. None for waste. */
  item?: ItemRef;
  /** Standard share of the input's weight (0.45 = 45%). */
  share: number;
  valuation: Valuation;
}

export interface Breakdown {
  id: string;
  name: string;
  /** A standard batch: 10 lb of whole snapper. */
  input: { item: ItemRef; quantity: Quantity };
  outputs: BreakdownOutput[];
}

export interface OutputCost {
  name: string;
  item?: ItemRef;
  /** Weight out of one standard batch, in the input's unit. */
  quantity: Quantity;
  /** Share of the input's cost this output carries. */
  cost: number;
  /** Cost per one of the input's unit (per lb of fillet). Undefined for waste. */
  perUnit?: number;
}

export interface BreakdownCost {
  inputCost: number;
  /** False when the input has no price yet. */
  complete: boolean;
  outputs: OutputCost[];
  /** Share of the input weight no output accounts for (moisture, trimming loss). */
  unaccounted: number;
  problems: string[];
}

/** Checks a breakdown's shape: shares that add up, at least one main cut. */
export function checkBreakdown(b: Breakdown): string[] {
  const problems: string[] = [];
  const total = b.outputs.reduce((s, o) => s + o.share, 0);
  if (total > 1.0001) problems.push(`Outputs add up to ${(total * 100).toFixed(1)}% of the input.`);
  if (!b.outputs.some((o) => o.valuation.method === 'main')) problems.push('No main cut to carry the cost.');
  for (const o of b.outputs) {
    if (!(o.share > 0)) problems.push(`${o.name} has no share.`);
    if (o.valuation.method === 'waste' && o.item) problems.push(`${o.name} is waste but also goes to inventory.`);
  }
  return problems;
}

/** Splits the cost of one standard batch across its outputs. */
export function costBreakdown(book: RecipeBook, b: Breakdown, inputCost?: number): BreakdownCost {
  const problems = checkBreakdown(b);
  const priced = inputCost === undefined ? book.costOf(b.input.item, b.input.quantity) : undefined;
  const cost = inputCost ?? priced!.total;
  const complete = inputCost !== undefined || priced!.complete;
  const unit = b.input.quantity.unit;
  const amount = b.input.quantity.amount;

  const outputs: OutputCost[] = b.outputs.map((o) => ({ name: o.name, ...(o.item ? { item: o.item } : {}), quantity: { amount: o.share * amount, unit }, cost: 0 }));

  // By-products first, at what they're worth.
  let fixed = 0;
  b.outputs.forEach((o, i) => {
    if (o.valuation.method !== 'fixed') return;
    const perInputUnit = o.valuation.price / convert(o.valuation.per, unit);
    outputs[i]!.cost = perInputUnit * outputs[i]!.quantity.amount;
    fixed += outputs[i]!.cost;
  });
  const remaining = cost - fixed;
  if (remaining < 0) problems.push('By-products are valued at more than the whole input cost.');

  // Main cuts carry the rest by weight × relative value.
  const weights = b.outputs.map((o, i) => (o.valuation.method === 'main' ? outputs[i]!.quantity.amount * (o.valuation.relativeValue ?? 1) : 0));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  b.outputs.forEach((o, i) => {
    if (o.valuation.method === 'main' && totalWeight > 0) outputs[i]!.cost = (remaining * weights[i]!) / totalWeight;
  });

  for (const [i, o] of b.outputs.entries()) {
    const out = outputs[i]!;
    if (o.valuation.method !== 'waste' && out.quantity.amount > 0) out.perUnit = out.cost / out.quantity.amount;
  }
  const unaccounted = Math.max(0, 1 - b.outputs.reduce((s, o) => s + o.share, 0));
  return { inputCost: cost, complete, outputs, unaccounted, problems };
}

/**
 * Prices the products a breakdown produces, so dishes using them cost through: a fillet
 * product gets the fillet's share of the fish, not a price from an invoice.
 */
export function withBreakdownPrices(products: readonly Product[], book: RecipeBook, breakdowns: readonly Breakdown[]): Product[] {
  const derived = new Map<string, Product['cost']>();
  for (const b of breakdowns) {
    const costed = costBreakdown(book, b);
    if (!costed.complete) continue;
    for (const out of costed.outputs) {
      if (out.item?.kind === 'product' && out.perUnit !== undefined) {
        derived.set(out.item.id, { price: out.perUnit, per: { amount: 1, unit: b.input.quantity.unit } });
      }
    }
  }
  return products.map((p) => (derived.has(p.id) ? { ...p, cost: derived.get(p.id) } : p));
}

/**
 * How much input to break down for a demand of outputs. Main cuts drive it: by-products
 * come along with them (bones for stock come free with fillets), so their demand doesn't
 * buy more fish; whatever the by-products fall short by is reported instead.
 */
export function inputNeeded(b: Breakdown, demand: ReadonlyMap<string, Quantity>): { input: Quantity; byProducts: { name: string; produced: Quantity; needed?: Quantity; short?: Quantity }[] } {
  const unit = b.input.quantity.unit;
  let input = 0;
  for (const o of b.outputs) {
    const want = demand.get(o.name);
    if (!want || o.valuation.method !== 'main') continue;
    input = Math.max(input, convert(want, unit) / o.share);
  }
  const byProducts = b.outputs
    .filter((o) => o.valuation.method === 'fixed')
    .map((o) => {
      const produced = { amount: input * o.share, unit };
      const want = demand.get(o.name);
      if (!want) return { name: o.name, produced };
      const short = convert(want, unit) - produced.amount;
      return { name: o.name, produced, needed: { amount: convert(want, unit), unit }, ...(short > 1e-9 ? { short: { amount: short, unit } } : {}) };
    });
  return { input: { amount: input, unit }, byProducts };
}

export interface LoggedBreakdown {
  input: Quantity;
  /** Output name → weight. Outputs not weighed are left out. */
  outputs: Readonly<Record<string, Quantity>>;
  performedBy?: string;
  date?: string;
}

export interface YieldLine {
  name: string;
  standard: number;
  /** Over the logged breakdowns that weighed this output. */
  actual?: number;
  /** Actual ÷ standard − 1: −0.16 means 16% under the standard yield. */
  deviation?: number;
  /** A main cut more than `tolerance` under its standard. */
  low: boolean;
}

/**
 * Actual yields from logged breakdowns against the standard, and what the main cut really
 * cost at those yields.
 */
export function yieldReport(book: RecipeBook, b: Breakdown, logs: readonly LoggedBreakdown[], options: { tolerance?: number } = {}): { lines: YieldLine[]; actualMainCost?: OutputCost[] } {
  const tolerance = options.tolerance ?? 0.1;
  const unit = b.input.quantity.unit;
  const lines: YieldLine[] = b.outputs.map((o) => {
    let input = 0;
    let out = 0;
    for (const log of logs) {
      const weighed = log.outputs[o.name];
      if (!weighed) continue;
      input += convert(log.input, unit);
      out += convert(weighed, unit);
    }
    if (input === 0) return { name: o.name, standard: o.share, low: false };
    const actual = out / input;
    const deviation = actual / o.share - 1;
    return { name: o.name, standard: o.share, actual, deviation, low: o.valuation.method === 'main' && deviation < -tolerance };
  });
  // Recost with the actual shares where they were weighed.
  const actualShares: Breakdown = { ...b, outputs: b.outputs.map((o, i) => ({ ...o, share: lines[i]!.actual ?? o.share })) };
  const costed = costBreakdown(book, actualShares);
  return { lines, ...(costed.complete ? { actualMainCost: costed.outputs.filter((_, i) => b.outputs[i]!.valuation.method === 'main') } : {}) };
}
