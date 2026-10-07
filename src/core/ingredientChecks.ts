/**
 * Recipe checks from what you buy: two ways a recipe can be quietly wrong.
 *
 * Not bought lately: the menu uses a product every week (sales run down through the recipes),
 * but no invoice has brought it in for far longer than one pack should last. Usually the recipe
 * names a product you've stopped buying: a new dairy, or the same cream under a new name. A
 * product bought recently with a similar name is offered as the likely replacement.
 *
 *   flagged when, since the last invoice (or since the first invoice we have, if never),
 *   at least 4 weeks have passed and the menu has used
 *     · 3 packs' worth or more (a pack: what one purchased unit holds), or
 *     · with no pack known, at least $40 worth.
 *
 * A big bag of chili flakes used a pinch at a time can last half a year: that's not flagged.
 * A quart of cream the menu goes through by the case every week is.
 *
 * Bought but in no recipe: something on invoice after invoice that no recipe uses. A recipe is
 * probably missing it (fryer oil, a garnish), or it isn't for the menu at all (staff meal).
 *
 * Amounts are in each product's base unit. Pure: the server gathers the inputs.
 */

export type ProductKind = 'food' | 'bar' | 'other';

export interface CheckProduct {
  id: string;
  name: string;
  baseUnit: string;
  kind: ProductKind;
  /** Price per base unit, when known. */
  unitPrice?: number;
  /** Mass, volume or count: a replacement must be measured the same way. */
  dimension?: string;
}

/** One invoice line. */
export interface Bought {
  productId: string;
  date: string;
  invoiceId: string;
  /** Base units in one purchased unit (a case, a bag). */
  packBase: number;
  /** Purchased units on the line. */
  packs: number;
  dollars: number;
  vendor?: string;
}

/** What the menu uses of a product each week, and which dishes use it most. */
export interface WeeklyUse {
  productId: string;
  perWeek: number;
  dishes: string[];
}

export interface NotBought {
  productId: string;
  name: string;
  unit: string;
  perWeek: number;
  dollarsPerWeek?: number;
  dishes: string[];
  /** The last invoice that brought it in; none since the first invoice we have. */
  last?: { date: string; vendor?: string; packBase: number };
  /** Weeks since then (or since the first invoice we have). */
  weeks: number;
  /** Bought recently, with a similar name: probably what the recipes should say now. */
  likely?: { productId: string; name: string; vendor?: string; times: number; lastDate: string; /** No recipe uses it: bought, but nowhere on the menu. */ inNoRecipe?: boolean };
}

export interface NotInRecipes {
  productId: string;
  name: string;
  kind: ProductKind;
  /** Invoices it was on in the window, and what they came to. */
  times: number;
  dollars: number;
  lastDate: string;
  vendor?: string;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => (Date.parse(`${b.slice(0, 10)}T12:00:00Z`) - Date.parse(`${a.slice(0, 10)}T12:00:00Z`)) / DAY;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const WORDS_TO_SKIP = new Set(['fresh', 'deposit', 'and', 'the', 'for', 'with', 'case', 'each', 'pack', 'bag', 'box', 'btl', 'bottle', 'can', 'jar', 'tub', 'lb', 'lbs', 'oz', 'gal', 'qt', 'ml', 'ltr']);
/** "Cream, Heavy 40% 1/2 Gal" → ["cream", "heavy"]: the words that say what it is. */
export function nameWords(name: string): string[] {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((w) => w.length > 2 && !WORDS_TO_SKIP.has(w));
}
/** Share of words the two names have in common (a word counts if one starts the other: "tomato"/"tomatoes"). */
export function nameLikeness(a: string, b: string): number {
  const x = [...new Set(nameWords(a))], y = [...new Set(nameWords(b))];
  if (!x.length || !y.length) return 0;
  const same = (p: string, q: string) => p === q || (Math.min(p.length, q.length) >= 4 && (p.startsWith(q) || q.startsWith(p)));
  const shared = x.filter((w) => y.some((v) => same(w, v))).length;
  return shared / Math.max(x.length, y.length);
}

export interface CheckInput {
  products: CheckProduct[];
  bought: Bought[];
  uses: WeeklyUse[];
  /** Products some recipe uses, on the menu or not. */
  inRecipes: Set<string>;
  /** The recipes naming each product: a replacement isn't one the same recipes already use. */
  recipesOf?: Map<string, string[]>;
  today: string;
  /** The first invoice date we have: "never bought" means not since then. */
  invoicesFrom?: string;
}

export function notBoughtLately(input: CheckInput): NotBought[] {
  const { products, bought, uses, today } = input;
  const byId = new Map(products.map((p) => [p.id, p]));
  const lastOf = new Map<string, Bought>();
  for (const b of bought) {
    if (b.date.slice(0, 10) > today) continue;
    const cur = lastOf.get(b.productId);
    if (!cur || b.date > cur.date) lastOf.set(b.productId, b);
  }
  // What's been bought lately, by product: the pool a replacement comes from.
  const recent = new Map<string, { dates: Set<string>; lastDate: string; vendor?: string }>();
  for (const b of bought) {
    const day = b.date.slice(0, 10);
    if (day > today || daysBetween(day, today) > 60) continue;
    const r = recent.get(b.productId) ?? { dates: new Set<string>(), lastDate: day };
    r.dates.add(day);
    if (day >= r.lastDate) { r.lastDate = day; if (b.vendor) r.vendor = b.vendor; }
    recent.set(b.productId, r);
  }
  const out: NotBought[] = [];
  for (const u of uses) {
    const p = byId.get(u.productId);
    if (!p || !(u.perWeek > 0) || p.kind === 'other') continue;
    const last = lastOf.get(u.productId);
    const since = last?.date.slice(0, 10) ?? input.invoicesFrom;
    if (!since) continue;
    const weeks = daysBetween(since, today) / 7;
    if (weeks < 4) continue;
    const usedSince = u.perWeek * weeks;
    const flagged = last && last.packBase > 0 ? usedSince >= 3 * last.packBase : p.unitPrice !== undefined && usedSince * p.unitPrice >= 40;
    if (!flagged) continue;
    // A likely replacement: bought in the last 60 days (twice, or once in the last 30), same kind,
    // measured the same way, and either a name sharing most of its words, or one sharing a word
    // that no recipe uses at all (used but not bought, beside bought but not used: the classic swap).
    const pool = [...recent.entries()]
      .filter(([id, r]) => id !== p.id && (r.dates.size >= 2 || daysBetween(r.lastDate, today) <= 30))
      .map(([id, r]) => ({ id, r, q: byId.get(id) }))
      .filter((c) => c.q && c.q.kind === p.kind && (!p.dimension || !c.q.dimension || c.q.dimension === p.dimension))
      // Already beside it in the same recipe (shiitake next to portabella): not what replaced it.
      .filter((c) => !(input.recipesOf?.get(p.id) ?? []).some((r) => (input.recipesOf?.get(c.id) ?? []).includes(r)))
      .map((c) => ({ ...c, score: nameLikeness(p.name, c.q!.name), unused: !input.inRecipes.has(c.id) }));
    const best = (xs: typeof pool) => xs.sort((a, b) => b.score - a.score || b.r.dates.size - a.r.dates.size)[0];
    const likely = best(pool.filter((c) => c.score >= 0.5)) ?? best(pool.filter((c) => c.unused && c.score > 0 && c.r.dates.size >= 3));
    out.push({
      productId: p.id, name: p.name, unit: p.baseUnit, perWeek: u.perWeek,
      ...(p.unitPrice !== undefined ? { dollarsPerWeek: u.perWeek * p.unitPrice } : {}),
      dishes: u.dishes,
      ...(last ? { last: { date: last.date.slice(0, 10), ...(last.vendor ? { vendor: last.vendor } : {}), packBase: last.packBase } } : {}),
      weeks: Math.floor(weeks),
      ...(likely ? { likely: { productId: likely.id, name: likely.q!.name, ...(likely.r.vendor ? { vendor: likely.r.vendor } : {}), times: likely.r.dates.size, lastDate: likely.r.lastDate, ...(likely.unused ? { inNoRecipe: true } : {}) } } : {}),
    });
  }
  return out.sort((a, b) => (b.dollarsPerWeek ?? 0) - (a.dollarsPerWeek ?? 0));
}

/** Bought on 3 or more invoices in the last 60 days, food or bar, and in no recipe at all. */
export function boughtNotInRecipes(input: CheckInput, days = 60): NotInRecipes[] {
  const byId = new Map(input.products.map((p) => [p.id, p]));
  const from = addDays(input.today, -days);
  const agg = new Map<string, { invoices: Set<string>; dollars: number; lastDate: string; vendor?: string }>();
  for (const b of input.bought) {
    const day = b.date.slice(0, 10);
    if (day <= from || day > input.today) continue;
    const a = agg.get(b.productId) ?? { invoices: new Set<string>(), dollars: 0, lastDate: day };
    a.invoices.add(b.invoiceId);
    a.dollars += b.dollars;
    if (day >= a.lastDate) { a.lastDate = day; if (b.vendor) a.vendor = b.vendor; }
    agg.set(b.productId, a);
  }
  const out: NotInRecipes[] = [];
  for (const [id, a] of agg) {
    const p = byId.get(id);
    if (!p || p.kind === 'other' || input.inRecipes.has(id) || a.invoices.size < 3 || !(a.dollars > 0)) continue;
    out.push({ productId: id, name: p.name, kind: p.kind, times: a.invoices.size, dollars: Math.round(a.dollars), lastDate: a.lastDate, ...(a.vendor ? { vendor: a.vendor } : {}) });
  }
  return out.sort((a, b) => b.dollars - a.dollars);
}

/**
 * A vendor gone quiet: invoiced regularly, then nothing for far longer than their usual gap. The
 * deliveries may still be coming with their invoices never reaching the books (Homeland's cream,
 * delivered twice a week, with no invoice since May), so food cost reads low until it's found.
 *
 *   regular: 5 or more invoice days in the 6 months before the last one
 *   flagged: no invoice for 3 times the usual gap (the median), and at least 3 weeks
 */
export interface VendorInvoice { vendorId: string; vendor: string; date: string; kind: ProductKind }
export interface QuietVendor { vendorId: string; vendor: string; kind: ProductKind; lastDate: string; usualGap: number; days: number; invoices: number }

export function quietVendors(invoices: VendorInvoice[], today: string): QuietVendor[] {
  const byVendor = new Map<string, { vendor: string; days: Set<string>; kinds: Map<ProductKind, number> }>();
  for (const i of invoices) {
    const day = i.date.slice(0, 10);
    if (!day || day > today) continue;
    const v = byVendor.get(i.vendorId) ?? { vendor: i.vendor, days: new Set<string>(), kinds: new Map<ProductKind, number>() };
    v.days.add(day);
    v.kinds.set(i.kind, (v.kinds.get(i.kind) ?? 0) + 1);
    byVendor.set(i.vendorId, v);
  }
  const out: QuietVendor[] = [];
  for (const [vendorId, v] of byVendor) {
    const days = [...v.days].sort();
    const last = days.at(-1)!;
    const recent = days.filter((d) => daysBetween(d, last) <= 182);
    if (recent.length < 5) continue;
    const gaps = recent.slice(1).map((d, k) => daysBetween(recent[k]!, d)).sort((a, b) => a - b);
    const usualGap = gaps[Math.floor(gaps.length / 2)]!;
    const since = daysBetween(last, today);
    if (since < Math.max(21, 3 * usualGap)) continue;
    const kind = [...v.kinds].sort((a, b) => b[1] - a[1])[0]![0];
    out.push({ vendorId, vendor: v.vendor, kind, lastDate: last, usualGap: Math.round(usualGap), days: Math.floor(since), invoices: recent.length });
  }
  return out.sort((a, b) => b.invoices / Math.max(1, b.usualGap) - a.invoices / Math.max(1, a.usualGap));
}
