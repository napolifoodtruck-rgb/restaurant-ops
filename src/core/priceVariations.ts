/**
 * Same drink, different price. Napoli runs Tuesday cocktails at $10 and Wednesday wine at half
 * price as extra variations on each Square item ("Negroni · Tuesday $10"). Those are the same
 * drink poured the same way, so they're folded into the regular variation: one menu item, one
 * recipe, with the discount days' sales counted in (its average price comes out lower, which is
 * what was really paid).
 *
 * A variation is a discount when its name says so: a weekday, a percentage, "off", "half",
 * "happy hour", or a set price ("$10"). It folds into the item's one other variation; an item
 * with several real variations (sizes) isn't folded, since there'd be no telling which.
 * A manager can keep one apart ("split") or fold one the name doesn't give away ("merge").
 */
import { nameKey, posName, type PosMenuItem } from './menuLinks.ts';

const DISCOUNT = /%|\b(off|half|happy hour|discount|promo)\b|\$\s?\d|\b(monday|tuesday|tues|wednesday|weds|thursday|friday|saturday|sunday)s?\b/i;

export const looksLikeDiscount = (variationName?: string) => Boolean(variationName && DISCOUNT.test(variationName));

export interface PriceOverrides {
  /** Variations kept as their own item, by catalog id. */
  priceSplit?: string[];
  /** Variations folded by hand: this catalog id is the same drink as `into`. */
  priceMerge?: { catalogId: string; into: string }[];
}

export interface FoldTarget { catalogId: string; itemName: string; variationName?: string }

/**
 * Where a sale goes: the regular variation it's the same drink as, or undefined to leave it be.
 * Matched by catalog id, or by item name for variations since deleted from Square.
 */
export function priceFolds(menu: readonly PosMenuItem[], overrides: PriceOverrides = {}, sold: readonly PosMenuItem[] = []) {
  const split = new Set(overrides.priceSplit ?? []);
  const byId = new Map(menu.map((m) => [m.catalogId, m]));
  const groups = new Map<string, PosMenuItem[]>();
  for (const m of menu) {
    const k = m.itemId ?? `name:${nameKey(m.itemName)}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  // Each item's one regular variation, when it has exactly one.
  const baseOfName = new Map<string, PosMenuItem>();
  for (const vs of groups.values()) {
    // Kept-apart discount buttons don't count as the regular one.
    const regular = vs.filter((v) => !looksLikeDiscount(v.variationName));
    if (regular.length === 1) baseOfName.set(nameKey(vs[0]!.itemName), regular[0]!);
  }
  // Items Square's catalog no longer has (or never sent): their regular variation, from what sold.
  const soldGroups = new Map<string, Map<string, PosMenuItem>>();
  for (const m of sold) {
    if (!byId.has(m.catalogId)) byId.set(m.catalogId, m);
    const k = nameKey(m.itemName);
    if (baseOfName.has(k)) continue;
    const g = soldGroups.get(k) ?? new Map<string, PosMenuItem>();
    g.set(m.catalogId, m);
    soldGroups.set(k, g);
  }
  for (const [k, g] of soldGroups) {
    const regular = [...g.values()].filter((v) => !looksLikeDiscount(v.variationName));
    if (regular.length === 1) { baseOfName.set(k, regular[0]!); byId.set(regular[0]!.catalogId, regular[0]!); }
  }
  const target = (m: PosMenuItem): FoldTarget => ({ catalogId: m.catalogId, itemName: m.itemName, ...(m.variationName ? { variationName: m.variationName } : {}) });
  const merges = new Map((overrides.priceMerge ?? []).map((x) => [x.catalogId, x.into]));
  return (sale: { catalogId: string; itemName: string; variationName?: string }): FoldTarget | undefined => {
    const into = merges.get(sale.catalogId);
    if (into && into !== sale.catalogId && byId.get(into)) return target(byId.get(into)!);
    if (split.has(sale.catalogId) || !looksLikeDiscount(sale.variationName)) return undefined;
    const base = baseOfName.get(nameKey(sale.itemName));
    return base && base.catalogId !== sale.catalogId ? target(base) : undefined;
  };
}

export interface FoldedVariation { catalogId: string; variationName: string; name: string; quantity: number; netSales: number; manual?: boolean }

/** Folded sales by the regular variation they went into: what each discount button sold. */
export function foldedTotals(folded: { into: string; catalogId: string; itemName: string; variationName?: string; quantity: number; netSales: number; manual?: boolean }[]) {
  const out = new Map<string, FoldedVariation[]>();
  for (const f of folded) {
    const list = out.get(f.into) ?? [];
    let row = list.find((x) => x.catalogId === f.catalogId && x.variationName === (f.variationName ?? ''));
    if (!row) { row = { catalogId: f.catalogId, variationName: f.variationName ?? '', name: posName(f), quantity: 0, netSales: 0, ...(f.manual ? { manual: true } : {}) }; list.push(row); }
    row.quantity += f.quantity; row.netSales += f.netSales;
    out.set(f.into, list);
  }
  for (const list of out.values()) for (const x of list) { x.quantity = Math.round(x.quantity * 10) / 10; x.netSales = Math.round(x.netSales * 100) / 100; }
  return out;
}
