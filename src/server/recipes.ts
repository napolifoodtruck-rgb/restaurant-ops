/**
 * The recipe book: every card, readable by anyone signed in, for the cook who needs the
 * house dressing while prepping. Browsed by side and category (Bar → Cocktails → Negroni;
 * Kitchen → Apps → House Salad → House Dressing), searched by name, or opened straight from a
 * prep list line, scaled to what the list says to make.
 *
 *   GET /api/recipes                         the book: sides, categories, card names
 *   GET /api/recipes/:name?amount=&unit=     one card, scaled to that amount when it converts
 *
 * Costs are shown to managers only.
 */

import { loadContainers } from './units.ts';
import { recipeWeight, unitWeight } from '../core/containers.ts';
import type { ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, loadBook } from './model.ts';
import { loadAreas } from './areas.ts';
import { coverageOf } from './views.ts';
import { cardView, kindOf, lineState, linkedItems, sameDishAs, yieldConversions } from './cards.ts';
import { tryConvert } from '../core/units.ts';
import { cardId, normalizeName as cardKey } from '../core/recipeCards.ts';

const PREP_SECTION = { kitchen: 'Prepared Items', bar: 'Prepared Items' };

export async function recipeRoutes(db: Db, res: ServerResponse, url: URL, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/recipes')) return false;
  const model = await getModel(db, who.restaurantId, today);
  const areaOf = await loadAreas(db, who.restaurantId);
  const book = await loadBook(db, who.restaurantId);
  const linked = linkedItems(model);
  // Rough recipes (still in R&D) are for managers; cooks see them once they're marked ready.
  const rd = atLeast(who.roleLevel, 'manager');
  const cards = (book.recipeCards ?? []).filter((c) => rd || c.status !== 'rough').map((c) => ({ card: c, view: cardView(model, c, linked, areaOf) }));
  const byName = new Map(cards.map((c) => [cardKey(c.card.name), c]));
  // A prep belongs to the side of what uses it (the bar's simple syrup), else its own kind.
  const sideOf = (c: (typeof cards)[number], seen = new Set<string>()): 'kitchen' | 'bar' => {
    if (c.view.kind === 'dish' || c.view.kind === 'drink' || c.view.linked.length) return c.view.area as 'kitchen' | 'bar';
    if (c.view.kind === 'barPrep') return 'bar';
    seen.add(cardKey(c.card.name));
    const users = c.view.usedBy.map((n) => byName.get(cardKey(n))).filter((u): u is (typeof cards)[number] => !!u && !seen.has(cardKey(u.card.name)));
    return users.some((u) => sideOf(u, seen) === 'bar') && !users.some((u) => sideOf(u, seen) === 'kitchen') ? 'bar' : 'kitchen';
  };
  const categories = [...new Set(model.sales.map((l) => l.category).filter((x): x is string => !!x))];
  // A dish's section is the POS category it sells under most; preps are filed together.
  const sectionOf = (c: (typeof cards)[number]) => {
    if (c.view.kind === 'prep' || c.view.kind === 'barPrep') return PREP_SECTION[sideOf(c)];
    const top = [...c.view.linked].sort((a, b) => b.sold - a.sold)[0];
    const category = top ? model.sales.find((l) => l.catalogId === top.catalogId)?.category : undefined;
    if (category) return category;
    if (c.view.kind === 'drink') return 'Drinks';
    // Not selling now: filed with the POS category its card type names ("Appetizers" with Apps).
    const type = c.card.recipeType && !/^(dish|menu)/i.test(c.card.recipeType) ? c.card.recipeType : undefined;
    return (type && categories.find((x) => x.slice(0, 3).toLowerCase() === type.slice(0, 3).toLowerCase())) ?? type ?? 'Dishes';
  };

  if (path === '/api/recipes') {
    const sides: Record<'kitchen' | 'bar', Map<string, { name: string; id: string; kind: string; sellsAs?: string; image?: string }[]>> = { kitchen: new Map(), bar: new Map() };
    for (const c of cards) {
      const side = sideOf(c), section = sectionOf(c);
      const list = sides[side].get(section) ?? [];
      // Shown by the name it sells under when that differs ("Spinachi" for the "Spinachi Pizza" card).
      const top = c.view.linked.sort((a, b) => b.sold - a.sold)[0];
      const sellsAs = top?.itemName;
      const image = c.view.linked.map((l) => model.imageOf(l.catalogId)).find(Boolean);
      list.push({ name: c.card.name, id: cardId(c.card), kind: c.view.kind, ...(c.card.status === 'rough' ? { rough: true } : {}), ...(sellsAs && cardKey(sellsAs) !== cardKey(c.card.name) ? { sellsAs } : {}), ...(image ? { image } : {}) });
      sides[side].set(section, list);
    }
    // Sections that sell most first, preps last.
    const sales = new Map<string, number>();
    for (const l of model.sales) if (l.category) sales.set(l.category, (sales.get(l.category) ?? 0) + l.netSales);
    const shape = (m: Map<string, { name: string; kind: string }[]>) => [...m].map(([section, list]) => ({ section, cards: list.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => Number(/preps$/i.test(a.section)) - Number(/preps$/i.test(b.section)) || (sales.get(b.section) ?? 0) - (sales.get(a.section) ?? 0) || a.section.localeCompare(b.section));
    // Managers also see how much of each side's sales has a full plate cost behind it.
    const coverage = atLeast(who.roleLevel, 'manager')
      ? { coverage: { kitchen: coverageOf(model, { area: 'kitchen', areaOf }), bar: coverageOf(model, { area: 'bar', areaOf }) } }
      : {};
    return send(res, 200, { kitchen: shape(sides.kitchen), bar: shape(sides.bar), ...coverage }), true;
  }

  const m = path.match(/^\/api\/recipes\/(.+)$/);
  if (m) {
    const name = decodeURIComponent(m[1]!);
    const c = byName.get(cardKey(name));
    if (!c) throw new HttpError(404, (book.recipeCards ?? []).some((x) => cardKey(x.name) === cardKey(name)) ? 'That recipe isn’t ready yet.' : 'No recipe by that name.');
    const kind = kindOf(c.card);
    const prep = kind === 'prep' || kind === 'barPrep';
    const yields = c.card.yields.length ? c.card.yields : [{ amount: 1, unit: 'each' }];
    // Scaled to an amount (what a prep list says to make) when it converts to the card's yield.
    let scale = 1, scaledTo: { amount: number; unit: string } | undefined;
    const amount = Number(url.searchParams.get('amount')), unit = url.searchParams.get('unit');
    // What one batch weighs, from its ingredients (complete only when every ingredient can be weighed).
    const rec = model.recipes.find((r) => r.name.toLowerCase() === c.card.name.toLowerCase());
    const ingredients = rec ? model.book.weightOf({ kind: 'recipe', id: rec.id }, yields[0]!) : undefined;
    const weight = recipeWeight(yields[0]!, yieldConversions(yields), ingredients?.mostly ? ingredients.grams : undefined);
    const batchGrams = weight?.batchGrams;
    if (prep && amount > 0 && unit) {
      const inYield = tryConvert({ amount, unit }, yields[0]!.unit, yieldConversions(yields));
      if (inYield !== undefined && inYield > 0) { scale = inYield / yields[0]!.amount; scaledTo = { amount, unit }; }
      else {
        // Containers the recipe doesn't name ("3 × deep 1/9 pan"): by weight, the prep item's (from the list) or
        // the container's typical size times what the recipe weighs per volume.
        const asked = Number(url.searchParams.get('grams'));
        const per = asked > 0 ? asked / amount : weight ? unitWeight(unit, undefined, weight, await loadContainers(db, who.restaurantId))?.grams : undefined;
        if (per && batchGrams) { scale = (per * amount) / batchGrams; scaledTo = { amount, unit }; }
      }
    }
    const manager = atLeast(who.roleLevel, 'manager');
    return send(res, 200, {
      id: cardId(c.card), name: c.card.name, kind, side: sideOf(c), section: sectionOf(c),
      yields, scale, ...(scaledTo ? { scaledTo } : {}), ...(batchGrams ? { batchGrams: Math.round(batchGrams), weightStated: weight!.stated } : {}), ...(prep && amount > 0 && unit ? { asked: { amount, unit } } : {}),
      ingredients: c.card.ingredients.map((i) => ({ amount: i.amount, unit: i.unit, name: i.name, ...(byName.has(cardKey(i.name)) ? { card: byName.get(cardKey(i.name))!.card.name } : {}), ...(i.yieldPercent && i.yieldPercent !== 100 ? { yieldPercent: i.yieldPercent } : {}), ...(i.note ? { note: i.note } : {}) })),
      ...(c.card.method ? { method: c.card.method } : {}),
      ...(c.card.shelfLifeDays ? { shelfLifeDays: c.card.shelfLifeDays } : {}),
      usedBy: c.view.usedBy.filter((n) => byName.has(cardKey(n))),
      ...(c.card.status === 'rough' ? { rough: true, toFinish: c.card.ingredients.filter((i) => lineState(i, model, book.recipeCards ?? []) !== 'ok').length } : {}),
      sellsAs: [...new Set(c.view.linked.map((l) => l.itemName))],
      ...(c.view.linked.map((l) => model.imageOf(l.catalogId)).find(Boolean) ? { image: c.view.linked.map((l) => model.imageOf(l.catalogId)).find(Boolean) } : {}),
      ...(manager && c.view.cost !== undefined ? { cost: c.view.cost, complete: c.view.complete } : {}),
      ...(manager ? { linked: c.view.linked.map((l) => ({ catalogId: l.catalogId, itemName: l.itemName, ...(l.variationName ? { variationName: l.variationName } : {}), name: l.name, sold: l.sold, netSales: l.netSales, ...(model.folded.get(l.catalogId)?.length ? { includes: model.folded.get(l.catalogId) } : {}) })) } : {}),
      ...(manager ? { sameAs: sameDishAs(c.card, book.recipeCards ?? []) } : {}),
      canEdit: manager,
    }), true;
  }
  return false;
}
