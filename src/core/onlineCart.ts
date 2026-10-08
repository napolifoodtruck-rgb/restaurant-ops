/**
 * The customer's side of the online menu, and their cart. Only published items show, with the
 * options shown online; an option that's always on (partially cooked) is listed as a note and
 * put on every order for them. A cart is checked against the menu as it is now, never trusted:
 * prices come from Square's catalog, and an item sold out or taken offline since it was added
 * says so by name.
 *
 * Money is in cents here, as Square counts it.
 */

import type { OnlineMenuItem } from './onlineMenu.ts';

export interface PublicOption { id: string; name: string; price: number }
export interface PublicOptionList { id: string; name: string; single: boolean; min: number; max?: number; options: PublicOption[] }
export interface PublicItem {
  itemId: string;
  name: string;
  category: string;
  description?: string;
  image?: string;
  variations: { id: string; name: string; price: number }[];
  isPizza: boolean;
  soldOut: boolean;
  /** Always on, not a choice: "Partially cooked". */
  notes: string[];
  optionLists: PublicOptionList[];
}

const cents = (dollars: number) => Math.round(dollars * 100);

/** What customers see: published items, their prices, and the options they get to choose. */
export function publicMenu(menu: readonly OnlineMenuItem[]): PublicItem[] {
  return menu.filter((x) => x.published && x.variations.some((v) => v.price !== undefined)).map((x) => {
    const sizes = x.variations.filter((v) => v.price !== undefined);
    // Sizes sold out in Square drop off; with all of them out, the item shows sold out.
    const inStock = sizes.filter((v) => !v.soldOut);
    const notes = x.modifierLists.flatMap((l) => l.modifiers.filter((m) => m.mode === 'always').map((m) => m.name));
    const choices = x.modifierLists
      // A list with something always on is decided already (partially cooked); its other choices aren't offered.
      .filter((l) => !l.modifiers.some((m) => m.mode === 'always'))
      // Options marked unavailable in Square drop off; a list left with too few to choose makes the item sold out.
      .map((l) => ({ id: l.id, name: l.name, single: l.single || l.max === 1, min: l.min ?? 0, ...(l.max !== undefined ? { max: l.max } : {}), options: l.modifiers.filter((m) => m.mode === 'shown' && !m.soldOut).map((m) => ({ id: m.id, name: m.name, price: cents(m.price) })) }));
    const optionsOut = choices.some((l) => l.min > l.options.length);
    const optionLists = choices.filter((l) => l.options.length);
    return {
      itemId: x.itemId,
      name: x.name,
      category: x.category,
      ...(x.description ? { description: x.description } : {}),
      ...(x.image ? { image: x.image } : {}),
      variations: (inStock.length ? inStock : sizes).map((v) => ({ id: v.id, name: v.name, price: cents(v.price!) })),
      isPizza: x.countsAsPizza,
      soldOut: x.soldOutToday || !inStock.length || optionsOut,
      notes,
      optionLists,
    };
  });
}

export interface CartLineIn { variationId: string; quantity: number; optionIds?: string[] }

export interface CartLine {
  itemId: string;
  variationId: string;
  name: string;
  variationName: string;
  quantity: number;
  /** Chosen options and always-on ones, in menu order. */
  modifiers: { id: string; name: string; price: number }[];
  unitPrice: number;
  total: number;
  isPizza: boolean;
}

export interface Cart { lines: CartLine[]; pizzas: number; subtotal: number }

export class CartError extends Error {}

export const MAX_LINES = 30;
export const MAX_QUANTITY = 20;

/** Checks a cart against the menu as it is now and prices it. Throws CartError with a customer-facing reason. */
export function priceCart(menu: readonly OnlineMenuItem[], lines: readonly CartLineIn[]): Cart {
  if (!lines.length) throw new CartError('Your cart is empty.');
  if (lines.length > MAX_LINES) throw new CartError('That’s a big order: please call us.');
  const out: CartLine[] = [];
  for (const line of lines) {
    const item = menu.find((x) => x.variations.some((v) => v.id === line.variationId));
    const variation = item?.variations.find((v) => v.id === line.variationId);
    if (!item || !variation || !item.published || variation.price === undefined) throw new CartError('Something in your cart isn’t on the online menu any more.');
    if (item.soldOutToday || variation.soldOut) throw new CartError(`Sorry, ${item.name}${variation.soldOut && !item.soldOutInSquare ? ` (${variation.name})` : ''} is sold out tonight.`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) throw new CartError(`Pick 1 to ${MAX_QUANTITY} of ${item.name}.`);
    const chosen = new Set(line.optionIds ?? []);
    const modifiers: CartLine['modifiers'] = [];
    for (const list of item.modifierLists) {
      const always = list.modifiers.filter((m) => m.mode === 'always');
      const picked = list.modifiers.filter((m) => chosen.has(m.id));
      for (const m of picked) chosen.delete(m.id);
      if (always.length) {
        if (picked.some((m) => m.mode !== 'always')) throw new CartError(`${item.name}: ${list.name} is set for online orders.`);
        modifiers.push(...always.map((m) => ({ id: m.id, name: m.name, price: cents(m.price) })));
        continue;
      }
      if (picked.some((m) => m.mode !== 'shown')) throw new CartError(`${item.name}: that option isn’t available online.`);
      const gone = picked.find((m) => m.soldOut);
      if (gone) throw new CartError(`Sorry, ${gone.name} is sold out tonight. Change ${item.name} to carry on.`);
      const max = list.single ? 1 : list.max;
      if (max !== undefined && picked.length > max) throw new CartError(`${item.name}: pick at most ${max} for ${list.name}.`);
      if ((list.min ?? 0) > picked.length) throw new CartError(`${item.name}: pick ${list.min} for ${list.name}.`);
      modifiers.push(...picked.map((m) => ({ id: m.id, name: m.name, price: cents(m.price) })));
    }
    if (chosen.size) throw new CartError(`${item.name}: that option isn’t available for it.`);
    const unitPrice = cents(variation.price) + modifiers.reduce((s, m) => s + m.price, 0);
    out.push({ itemId: item.itemId, variationId: variation.id, name: item.name, variationName: variation.name, quantity: line.quantity, modifiers, unitPrice, total: unitPrice * line.quantity, isPizza: item.countsAsPizza });
  }
  return { lines: out, pizzas: out.filter((l) => l.isPizza).reduce((s, l) => s + l.quantity, 0), subtotal: out.reduce((s, l) => s + l.total, 0) };
}

/** A tip someone picked: a whole number of cents, up to the order itself. */
export function tipProblem(tip: unknown, subtotal: number): string | undefined {
  return Number.isInteger(tip) && (tip as number) >= 0 && (tip as number) <= Math.max(subtotal, 0) ? undefined : 'That tip doesn’t look right.';
}

/**
 * Whether the cart can still be had, by Square's word right before payment: nothing in it switched
 * off on the POS (sizes and chosen options), and enough left of anything Square keeps a count of.
 * `counts` is what Square has in stock at the location, by size; a size with no count isn't held back. A customer-facing reason, or
 * nothing when it's all there.
 */
export function stockProblem(menu: readonly OnlineMenuItem[], lines: readonly (Pick<CartLine, 'variationId' | 'quantity' | 'name' | 'variationName'> & { modifiers?: CartLine['modifiers'] })[], counts: ReadonlyMap<string, number>): string | undefined {
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.variationId, (wanted.get(l.variationId) ?? 0) + l.quantity);
  for (const l of lines) {
    const variation = menu.flatMap((x) => x.variations).find((v) => v.id === l.variationId);
    const what = l.variationName && l.variationName !== 'Regular' ? `${l.name} (${l.variationName})` : l.name;
    const left = variation?.counted ? counts.get(l.variationId) : undefined;
    if (!variation || variation.soldOut || (left !== undefined && left < 1)) return `Sorry, ${what} just sold out.`;
    if (left !== undefined && left < wanted.get(l.variationId)!) return `Sorry, we only have ${Math.floor(left)} ${what} left. Change your order to carry on.`;
    // An option marked unavailable since it was picked (an always-on one is how it's made, so it stays).
    const options = menu.find((x) => x.variations.includes(variation))?.modifierLists.flatMap((ml) => ml.modifiers) ?? [];
    const gone = (l.modifiers ?? []).map((m) => options.find((o) => o.id === m.id)).find((o) => o?.soldOut && o.mode !== 'always');
    if (gone) return `Sorry, ${gone.name} just sold out. Change ${what} to carry on.`;
  }
  return undefined;
}
