/**
 * Modifiers, and what each one does to a dish or drink: "Raspberry" adds 1.5 oz of raspberry
 * syrup to an Italian soda; "++ Extra Mozzarella" adds half again the pizza's cheese; "Sub GF
 * Crust" swaps the dough. Set once per modifier, since Square shares modifier lists across items:
 * changing one changes it everywhere it's sold (the page says where).
 *
 *   GET  /api/modifiers?recipe=<id>   one item: its variations, and each modifier sold with it
 *   GET  /api/modifiers               every modifier list, and the items each is on
 *   POST /api/modifiers/answer        what modifiers add or take off ({ answers: [...] })
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, loadBook, saveBook } from './model.ts';
import { storedModifierSales } from './squareSync.ts';
import { squareModifierSales } from '../connectors/square.ts';
import { emptyModifierAnswers, findItems, modifierKey, readModifier, resolveModifier, usualPortion, type ModifierAnswers, type ModifierSaleLine } from '../core/modifiers.ts';
import type { Ingredient, ItemRef } from '../core/recipes.ts';

const cents = (v: number) => Math.round(v * 100) / 100;

export async function modifierRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn, today: string): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/modifiers' && path !== '/api/modifiers/answer') return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const model = await getModel(db, who.restaurantId, today);
  const book = model.book;
  const saved = await loadBook(db, who.restaurantId);
  const answers: ModifierAnswers = saved.modifierAnswers ?? emptyModifierAnswers();

  if (method === 'POST' && path === '/api/modifiers/answer') {
    const b = await body(req);
    const list = Array.isArray(b.answers) ? (b.answers as any[]) : [b];
    const next: ModifierAnswers = { ...answers, adds: { ...answers.adds }, removes: { ...answers.removes }, ...(answers.waiting ? { waiting: { ...answers.waiting } } : {}) };
    const itemOf = (x: any): ItemRef => {
      const kind = x?.kind === 'recipe' ? 'recipe' : 'product';
      const id = String(x?.id ?? '');
      if (kind === 'product' ? !book.products.has(id) : !book.recipes.has(id)) throw new HttpError(400, 'Pick the ingredient from the list.');
      return { kind, id };
    };
    for (const a of list) {
      const key = String(a?.key ?? '');
      if (!key.includes('|')) throw new HttpError(400, 'Which modifier?');
      // What one use adds: a list of ingredients, or none ("changes nothing").
      if (a.nothing === true) next.adds[key] = [];
      else if (Array.isArray(a.adds)) {
        next.adds[key] = a.adds.map((x: any): Ingredient => {
          const amount = Number(x?.amount);
          if (!(amount > 0) || typeof x?.unit !== 'string' || !x.unit) throw new HttpError(400, 'Each line needs an amount and a unit.');
          return { item: itemOf(x), quantity: { amount, unit: x.unit } };
        });
      }
      // What it takes off: for one dish, or every dish ("*"); null takes nothing off.
      if (a.removes && typeof a.removes === 'object') {
        const dish = String(a.removes.dish ?? '*');
        next.removes[`${dish}|${key}`] = a.removes.item ? itemOf(a.removes.item) : null;
      }
      if (a.clear === true) { delete next.adds[key]; for (const k of Object.keys(next.removes)) if (k.endsWith(`|${key}`)) delete next.removes[k]; }
      if (next.waiting) delete next.waiting[key];
    }
    await saveBook(db, who.restaurantId, 'modifierAnswers', next, who.staffId);
    return send(res, 200, { ok: true, saved: list.length }), true;
  }

  // Every modifier sold over the model's period, and the dish each one went on.
  // A row without its item's name (older exports) takes it from the item's own sales.
  const nameOfItem = new Map<string, string>();
  for (const l of model.sales) if (l.catalogId && l.name) nameOfItem.set(l.catalogId, l.name);
  const sales = squareModifierSales(await storedModifierSales(db, who.restaurantId, model.from, model.today))
    .map((l) => (l.itemName ? l : { ...l, itemName: nameOfItem.get(l.catalogId) ?? '' }));
  const dishOf = (l: ModifierSaleLine) => model.lookup(l.catalogId, l.itemName, l.date)?.recipeId;
  const onItems = new Map<string, Set<string>>();
  for (const l of sales) {
    const key = modifierKey(l.modifier);
    const id = dishOf(l);
    const name = id ? (book.recipes.get(id)?.name ?? l.itemName) : l.itemName.replace(/\s*\(.*\)$/, '');
    onItems.set(key, (onItems.get(key) ?? new Set()).add(name));
  }
  const describe = (adds: Ingredient[]) => adds.map((i) => ({ kind: i.item.kind, id: i.item.id, name: book.nameOf(i.item), amount: cents(i.quantity.amount * 1000) / 1000, unit: i.quantity.unit }));
  const costOf = (list: Ingredient[]) => list.reduce((a, i) => { const c = book.costOf(i.item, i.quantity); return { total: a.total + c.total, complete: a.complete && c.complete }; }, { total: 0, complete: true });

  // One modifier on one dish: what it does, how it was decided, and what one use costs.
  const view = (key: string, modifier: ModifierSaleLine['modifier'], dishId: string | undefined, uses: number, revenue: number, plates?: number) => {
    const reading = readModifier(modifier);
    const answered = key in answers.adds;
    let status: 'none' | 'set' | 'nothing' | 'assumed' | 'notSet' = 'notSet';
    let adds: Ingredient[] = [], removes: Ingredient[] = [];
    if (reading.action === 'none') status = 'none';
    else if (answered && answers.adds[key]!.length === 0 && reading.action !== 'remove' && reading.action !== 'swap') status = 'nothing';
    else if (dishId) {
      let r = resolveModifier(book, dishId, modifier, answers);
      if ('question' in r && r.question.type === 'portion' && Array.isArray(r.question.proposal)) {
        r = resolveModifier(book, dishId, modifier, { ...answers, adds: { ...answers.adds, [key]: r.question.proposal } });
        if ('resolved' in r) status = 'assumed';
      } else if ('resolved' in r) status = answered || Object.keys(answers.removes).some((k) => k.endsWith(`|${key}`)) ? 'set' : 'assumed';
      if ('resolved' in r) { adds = r.resolved.adds; removes = r.resolved.removes; } else status = 'notSet';
    } else if (answered) { status = 'set'; adds = answers.adds[key]!.filter((x): x is Ingredient => 'quantity' in x); }
    const added = costOf(adds), taken = costOf(removes);
    // A guess for what a plain name ("Raspberry", in "Syrup") adds: the closest product or prep.
    const listWords = (modifier.listName ?? '').replace(/\b(choice|choose|flavou?rs?|options?|add[- ]?ons?|modifiers?|of)\b/gi, ' ').trim();
    const found = status === 'notSet' ? (findItems(book, `${modifier.name} ${listWords}`)[0] ?? findItems(book, modifier.name)[0]) : undefined;
    const portion = found ? usualPortion(book, found) : undefined;
    return {
      key, name: modifier.name, listName: modifier.listName ?? 'Other', action: reading.action, status,
      uses: Math.round(uses), upcharge: uses > 0 ? cents(revenue / uses) : 0, ...(plates ? { share: uses / plates } : {}),
      adds: describe(adds), removes: describe(removes),
      costPerUse: cents(added.total - taken.total), complete: added.complete && taken.complete && status !== 'notSet',
      ...(found ? { suggest: { kind: found.kind, id: found.id, name: book.nameOf(found), ...(portion ? { amount: cents(portion.amount * 1000) / 1000, unit: portion.unit } : {}) } } : {}),
      on: [...(onItems.get(key) ?? [])].sort(),
    };
  };

  const recipe = url.searchParams.get('recipe');
  if (recipe) {
    const dish = book.recipes.get(recipe);
    if (!dish) throw new HttpError(404, 'No recipe by that name.');
    const mine = sales.filter((l) => dishOf(l) === recipe);
    const plates = model.margins.dishes.filter((d) => d.recipeId === recipe).reduce((a, d) => a + d.quantity, 0);
    const byKey = new Map<string, { modifier: ModifierSaleLine['modifier']; uses: number; revenue: number }>();
    for (const l of mine) {
      const k = modifierKey(l.modifier);
      const x = byKey.get(k) ?? { modifier: l.modifier, uses: 0, revenue: 0 };
      x.uses += l.quantity; x.revenue += l.sales;
      byKey.set(k, x);
    }
    const rows = [...byKey].map(([k, x]) => view(k, x.modifier, recipe, x.uses, x.revenue, plates)).sort((a, b) => b.uses - a.uses);
    const lists = new Map<string, typeof rows>();
    for (const r of rows) lists.set(r.listName, [...(lists.get(r.listName) ?? []), r]);
    const sold = model.margins.dishes.filter((d) => d.recipeId === recipe);
    // What modifiers add to a plate on average: each one's cost per use, times how often it was picked.
    const perPlate = rows.reduce((a, r) => a + (r.status === 'notSet' ? 0 : r.costPerUse * r.uses), 0) / Math.max(1, plates);
    return send(res, 200, {
      recipe, name: dish.name, plates: Math.round(plates), modifierCostPerPlate: cents(perPlate),
      variations: sold.map((d) => ({ name: d.name, catalogId: d.catalogId, sold: Math.round(d.quantity), price: cents(d.averagePrice), cost: cents(d.cost.total), plateCost: cents(d.cost.total + perPlate) })),
      lists: [...lists].map(([listName, mods]) => ({ listName, modifiers: mods, on: [...new Set(mods.flatMap((m) => m.on))].sort() })),
    }), true;
  }

  // Every list: each modifier once (on the item it's used on most), with all the items it's on.
  const byKey = new Map<string, { modifier: ModifierSaleLine['modifier']; uses: number; revenue: number; dishes: Map<string, number> }>();
  for (const l of sales) {
    const k = modifierKey(l.modifier);
    const x = byKey.get(k) ?? { modifier: l.modifier, uses: 0, revenue: 0, dishes: new Map() };
    x.uses += l.quantity; x.revenue += l.sales;
    const id = dishOf(l);
    if (id) x.dishes.set(id, (x.dishes.get(id) ?? 0) + l.quantity);
    byKey.set(k, x);
  }
  const rows = [...byKey].map(([k, x]) => view(k, x.modifier, [...x.dishes].sort((a, b) => b[1] - a[1])[0]?.[0], x.uses, x.revenue)).filter((r) => r.action !== 'none').sort((a, b) => b.uses - a.uses);
  const lists = new Map<string, typeof rows>();
  for (const r of rows) lists.set(r.listName, [...(lists.get(r.listName) ?? []), r]);
  return send(res, 200, { lists: [...lists].map(([listName, mods]) => ({ listName, modifiers: mods, on: [...new Set(mods.flatMap((m) => m.on))].sort(), uses: mods.reduce((a, m) => a + m.uses, 0) })).sort((a, b) => b.uses - a.uses) }), true;
}
