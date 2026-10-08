/**
 * What the screens show, shaped from the model: plain JSON, rounded for display.
 */

import type { Model } from './model.ts';
import type { AreaOf } from './areas.ts';

/** Which side of the menu a screen shows: kitchen, bar, or both together (Today, for someone who does both). */
export interface AreaView { area: 'kitchen' | 'bar' | 'all'; areaOf: AreaOf }
const ALL: AreaView = { area: 'all', areaOf: () => 'kitchen' };
export const inArea = (v: AreaView, category: string | undefined) => {
  const a = category ? v.areaOf(category) : 'kitchen';
  return v.area === 'all' ? a !== 'none' : a === v.area;
};
import { onMenu, quietThreshold } from '../core/menu.ts';
import { posName } from '../core/menuLinks.ts';
import { menuMargins } from '../core/margins.ts';

/** Which sales Performance looks at: all of them, full price only, or specials only. */
export type PriceView = 'all' | 'full' | 'special';

const pricedMemo = new WeakMap<Model, Map<PriceView, Pick<Model, 'sales' | 'margins'>>>();
/**
 * The model's sales and margins for full-price or specials sales alone. Modifier costs are the
 * period's totals, so each button's share goes with its share of the plates.
 */
export function priced(model: Model, price: PriceView): Pick<Model, 'sales' | 'margins'> {
  if (price === 'all') return model;
  const hit = pricedMemo.get(model)?.get(price);
  if (hit) return hit;
  const sales = model.sales.filter((l) => (price === 'special') === Boolean(l.special));
  const plates = (lines: readonly Model['sales'][number][]) => {
    const out = new Map<string, number>();
    for (const l of lines) {
      const id = model.lookup(l.catalogId, l.name, l.date)?.recipeId;
      if (id) out.set(`${l.catalogId}|${id}`, (out.get(`${l.catalogId}|${id}`) ?? 0) + l.quantity);
    }
    return out;
  };
  const all = plates(model.sales), mine = plates(sales);
  const modifierCosts = new Map([...model.modifiers.byItem].map(([k, v]) => [k, (all.get(k) ?? 0) > 0 ? (v * (mine.get(k) ?? 0)) / all.get(k)! : 0]));
  const margins = menuMargins(model.book, model.lookup, sales, { modifierCosts });
  const result = { sales, margins: { ...margins, unlinked: margins.unlinked.filter((u) => model.margins.unlinked.some((x) => x.name === u.name)) } };
  const m = pricedMemo.get(model) ?? new Map();
  m.set(price, result);
  pricedMemo.set(model, m);
  return result;
}

const money = (v: number) => Math.round(v * 100) / 100;
const share = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);

const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * What keeps plate costs from being complete, one question per product (a single answer fixes
 * every dish that uses it), most plates affected first.
 */
export function gapsOf(model: Model, dishes: Model['margins']['dishes']) {
  const gaps = new Map<string, { key: string; kind: string; productId: string; product: string; needed?: string; from?: string; to?: string; dishes: string[]; plates: number }>();
  for (const d of dishes) {
    for (const issue of d.cost.issues) {
      let g;
      if (issue.type === 'missingCost') g = { key: `price:${issue.productId}`, kind: 'price', productId: issue.productId, product: issue.productName };
      else if (issue.type === 'missingConversion' && issue.item.kind === 'product') g = { key: `conv:${issue.item.id}:${issue.needed}${issue.needed === 'unknownUnit' ? `:${issue.to}` : ''}`, kind: 'conversion', productId: issue.item.id, product: issue.itemName, needed: issue.needed, from: issue.from, to: issue.to };
      else continue;
      const seen = gaps.get(g.key) ?? { ...g, dishes: [], plates: 0 };
      if (!seen.dishes.includes(d.name)) seen.dishes.push(d.name);
      seen.plates += d.quantity;
      gaps.set(g.key, seen);
    }
  }
  return [...gaps.values()].sort((a, b) => b.plates - a.plates).map((g) => ({ ...g, plates: Math.round(g.plates) }));
}

/**
 * How much of a side's sales has a full plate cost behind it: dishes whose card prices out
 * completely, dishes whose card is missing a price or conversion, and items with no card.
 */
export function coverageOf(model: Model, view: AreaView) {
  let complete = 0, gaps = 0, noCard = 0;
  const dishes = model.margins.dishes.filter((d) => inArea(view, d.category));
  for (const d of dishes) if (d.cost.complete) complete += d.netSales; else gaps += d.netSales;
  const missing = model.margins.unlinked.filter((u) => u.catalogId && u.netSales > 0 && inArea(view, u.category));
  for (const u of missing) noCard += u.netSales;
  return {
    complete: money(complete), gaps: money(gaps), noCard: money(noCard),
    gapCount: gapsOf(model, dishes).length,
    noCardCount: new Set(missing.map((u) => posItemOf(model)(u.catalogId, u.name).itemName)).size,
  };
}

/** Margins by category, biggest money first. Only categories with at least one dish that has a recipe. */
export function marginsView(whole: Model, view: AreaView = ALL, price: PriceView = 'all') {
  // Days on the menu and open days come from every sale; money and plates from the ones asked for.
  const model = { ...whole, ...priced(whole, price) };
  const stillOn = addDays(model.today, -7);
  // When each recipe was on the menu, from the days it sold (by version, so a summer and a
  // fall dish on one button each get their own days), and which days the restaurant was open.
  const openDays = new Set<string>();
  const sold = new Map<string, { first: string; last: string }>();
  for (const l of whole.sales) {
    if (!l.date || !(l.quantity > 0)) continue;
    openDays.add(l.date);
    const link = model.lookup(l.catalogId, l.name, l.date);
    if (!link) continue;
    const s = sold.get(link.recipeId);
    sold.set(link.recipeId, s ? { first: s.first < l.date ? s.first : l.date, last: s.last > l.date ? s.last : l.date } : { first: l.date, last: l.date });
  }
  const open = [...openDays].sort();

  // Weekly buckets ending on the period's last day, so the latest week is a full one.
  const weeks: { from: string; to: string }[] = [];
  for (let end = model.today; end >= model.from; end = addDays(end, -7)) weeks.unshift({ from: addDays(end, -6) < model.from ? model.from : addDays(end, -6), to: end });
  const weekOf = (day: string) => weeks.findIndex((w) => day >= w.from && day <= w.to);
  const weekly = new Map<string, number[]>();
  const weeklySales = new Map<string, number[]>();
  for (const l of model.sales) {
    if (!l.date || !(l.quantity > 0)) continue;
    const link = model.lookup(l.catalogId, l.name, l.date);
    if (!link) continue;
    const w = weekOf(l.date);
    if (w < 0) continue;
    const arr = weekly.get(link.recipeId) ?? weeks.map(() => 0);
    arr[w]! += l.quantity;
    weekly.set(link.recipeId, arr);
    const money = weeklySales.get(link.recipeId) ?? weeks.map(() => 0);
    money[w]! += l.netSales;
    weeklySales.set(link.recipeId, money);
  }
  /** Money left after food, week by week: that week's sales less its plates at the period's plate cost. */
  const weeklyLeftOf = (recipeId: string, plateCost: number) => {
    const q = weekly.get(recipeId), m = weeklySales.get(recipeId);
    return q && m ? q.map((n, i) => Math.round(m[i]! - n * plateCost)) : weeks.map(() => 0);
  };
  /**
   * Plates per open day, week by week (null for weeks the dish wasn't on the menu, or was on
   * fewer than 2 open days), and the trend: the fitted line's change across those weeks as a
   * share of the dish's average. Needs at least 3 weeks on the menu.
   */
  const trendOf = (recipeId: string) => {
    const s = sold.get(recipeId);
    const q = weekly.get(recipeId);
    if (!s || !q) return undefined;
    const end = s.last >= stillOn ? model.today : s.last;
    const series = weeks.map((w, i) => {
      const days = open.filter((d) => d >= w.from && d <= w.to && d >= s.first && d <= end).length;
      return days >= 2 ? Math.round((q[i]! / days) * 10) / 10 : null;
    });
    const points = series.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
    let change: number | undefined;
    if (points.length >= 3) {
      const n = points.length;
      const mx = points.reduce((a, p) => a + p[0], 0) / n;
      const my = points.reduce((a, p) => a + p[1], 0) / n;
      const slope = points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (points.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1);
      if (my > 0) change = Math.round(((slope * (points[n - 1]![0] - points[0]![0])) / my) * 100) / 100;
    }
    return { series, ...(change !== undefined ? { change } : {}), partial: series.some((v) => v === null) };
  };
  const lastSold = new Map([...sold].map(([id, s]) => [id, s.last]));
  const onNowIds = new Set(onMenu(model.entries, model.today).map((e) => e.recipeId));
  /** Open days a dish was on the menu: first sale to last, or to the period's end if it's still on. */
  const daysOn = (recipeId: string): number | undefined => {
    const s = sold.get(recipeId);
    if (!s) return undefined;
    const end = s.last >= stillOn ? model.today : s.last;
    return open.filter((d) => d >= s.first && d <= end).length || undefined;
  };
  const byCategory = new Map<string, Model['margins']['dishes']>();
  for (const d of model.margins.dishes) if (inArea(view, d.category)) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);
  // In the all view: what full price and specials did apart, by category and by dish.
  const split = price === 'all' && whole.sales.some((l) => l.special) ? { full: priced(whole, 'full').margins.dishes, special: priced(whole, 'special').margins.dishes } : undefined;
  const sideOf = (list: Model['margins']['dishes'], d: Model['margins']['dishes'][number]) => list.find((x) => x.recipeId === d.recipeId && x.catalogId === d.catalogId) ?? list.find((x) => x.recipeId === d.recipeId);
  const pricePart = (list: Model['margins']['dishes'][number][]) => {
    const net = list.reduce((s, d) => s + d.netSales, 0), food = list.reduce((s, d) => s + d.plateCost * d.quantity, 0);
    return { netSales: money(net), foodCostShare: share(net > 0 ? food / net : undefined) };
  };
  const categories = [...byCategory].map(([name, dishes]) => {
    const netSales = dishes.reduce((s, d) => s + d.netSales, 0);
    const food = dishes.reduce((s, d) => s + d.plateCost * d.quantity, 0);
    const byPrice = split ? (() => {
      const full = dishes.map((d) => sideOf(split.full, d)).filter((x): x is NonNullable<typeof x> => Boolean(x));
      const special = dishes.map((d) => sideOf(split.special, d)).filter((x): x is NonNullable<typeof x> => Boolean(x));
      return special.length ? { full: pricePart(full), special: pricePart(special), specialShare: share(netSales > 0 ? special.reduce((s, d) => s + d.netSales, 0) / netSales : 0) } : undefined;
    })() : undefined;
    const missing = model.margins.unlinked.filter((u) => u.category === name && u.netSales > 0);
    return {
      name,
      netSales: money(netSales),
      leftOver: money(netSales - food),
      foodCostShare: share(netSales > 0 ? food / netSales : 0),
      gaps: gapsOf(model, dishes),
      ...(byPrice ? { byPrice } : {}),
      dishes: dishes.map((d) => ({
        recipeId: d.recipeId,
        name: d.name,
        sold: Math.round(d.quantity),
        averagePrice: money(d.averagePrice),
        listPrice: d.listPrice,
        plateCost: money(d.plateCost),
        leftPerPlate: money(d.contribution),
        leftTotal: money(d.totalContribution),
        foodCostShare: share(d.foodCostShare),
        profitShare: share(d.profitShare),
        role: d.role,
        estimated: !d.cost.complete,
        // For dishes on only part of the period: what it brings in per open day it was there.
        ...(() => {
          const n = daysOn(d.recipeId);
          return n ? { daysOn: n, firstSold: sold.get(d.recipeId)!.first, leftPerDay: money(d.totalContribution / n), soldPerDay: Math.round((d.quantity / n) * 10) / 10 } : {};
        })(),
        ...(trendOf(d.recipeId) ? { trend: trendOf(d.recipeId) } : {}),
        weeklyLeft: weeklyLeftOf(d.recipeId, d.plateCost),
        // The plate, ingredient by ingredient (raw products, after preps are broken down).
        lines: d.cost.lines
          .map((l) => ({ productId: l.productId, name: l.productName, amount: Math.round(l.amount * 1000) / 1000, unit: model.book.products.get(l.productId)?.baseUnit ?? '', ...(l.cost !== undefined ? { cost: Math.round(l.cost * 1000) / 1000 } : {}) }))
          .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
        // Came off the menu during the period: its money is real, but it's not a dish to work on.
        // Off only when the menu says so (a manager confirmed it, or a planned dish replaced it).
        ...(!onNowIds.has(d.recipeId) && lastSold.get(d.recipeId) ? { offSince: lastSold.get(d.recipeId) } : {}),
        // Full price and specials apart, when it sold on a specials button too.
        ...(() => {
          const sp = split && sideOf(split.special, d);
          if (!sp) return {};
          const fp = sideOf(split.full, d);
          const part = (x: typeof sp) => ({ sold: Math.round(x.quantity * 10) / 10, averagePrice: money(x.averagePrice), plateCost: money(x.plateCost), foodCostShare: share(x.foodCostShare) });
          return { byPrice: { ...(fp ? { full: part(fp) } : {}), special: part(sp) } };
        })(),
      })),
      // Food cost share week by week, over the dishes with cards.
      weeklyFoodCost: weeks.map((_, i) => {
        let sales = 0, food = 0;
        for (const d of dishes) {
          sales += weeklySales.get(d.recipeId)?.[i] ?? 0;
          food += (weekly.get(d.recipeId)?.[i] ?? 0) * d.plateCost;
        }
        return sales > 0 ? share(food / sales)! : null;
      }),
      // Selling but no recipe card yet: their money isn't counted above.
      noCard: missing.slice(0, 12).map((u) => ({ name: u.name, sold: Math.round(u.quantity), netSales: money(u.netSales) })),
      noCardSales: money(missing.reduce((s, u) => s + u.netSales, 0)),
    };
  }).sort((a, b) => b.leftOver - a.leftOver);
  // Totals over this side's dishes.
  const mine = [...byCategory.values()].flat();
  const t = { netSales: mine.reduce((s, d) => s + d.netSales, 0), food: mine.reduce((s, d) => s + d.plateCost * d.quantity, 0) };

  // Categories on this side with sales but no costed items yet (the bar, until drinks are linked
  // to what they pour from): what sold, how often, for how much.
  const salesOnly = new Map<string, Map<string, { name: string; sold: number; netSales: number; first: string; last: string }>>();
  for (const l of model.sales) {
    if (!l.category || byCategory.has(l.category) || !inArea(view, l.category) || !l.date) continue;
    if (model.lookup(l.catalogId, l.name, l.date)) continue;
    const items = salesOnly.get(l.category) ?? new Map();
    const it = items.get(l.name) ?? { name: l.name, sold: 0, netSales: 0, first: l.date, last: l.date };
    it.sold += l.quantity; it.netSales += l.netSales;
    if (l.date < it.first) it.first = l.date;
    if (l.date > it.last) it.last = l.date;
    items.set(l.name, it);
    salesOnly.set(l.category, items);
  }
  const salesCategories = [...salesOnly].map(([name, items]) => {
    const list = [...items.values()].filter((i) => i.sold > 0 || i.netSales > 0).map((i) => {
      const end = i.last >= stillOn ? model.today : i.last;
      const days = open.filter((d) => d >= i.first && d <= end).length || 1;
      return { name: i.name, sold: Math.round(i.sold * 10) / 10, netSales: money(i.netSales), averagePrice: i.sold > 0 ? money(i.netSales / i.sold) : 0, daysOn: days, soldPerDay: Math.round((i.sold / days) * 10) / 10, salesPerDay: money(i.netSales / days), ...(i.last < stillOn ? { offSince: i.last } : {}) };
    }).sort((a, b) => b.netSales - a.netSales);
    return { name, netSales: money(list.reduce((s, i) => s + i.netSales, 0)), items: list };
  }).filter((c) => c.items.length).sort((a, b) => b.netSales - a.netSales);

  return {
    area: view.area,
    price,
    hasSpecials: whole.sales.some((l) => l.special && inArea(view, l.category)),
    coverage: coverageOf(model, view),
    // Every plate-cost gap on this side, one question per product.
    gaps: gapsOf(model, model.margins.dishes.filter((d) => inArea(view, d.category))),
    from: model.from,
    to: model.today,
    dataFrom: model.dataFrom,
    openDays: openDays.size,
    weeks: weeks.map((w) => w.from),
    missing: model.missing,
    totals: { netSales: money(t.netSales), foodCostShare: share(t.netSales > 0 ? t.food / t.netSales : undefined), leftOver: money(t.netSales - t.food), coverage: share(model.margins.coverage) },
    categories,
    salesOnly: salesCategories,
  };
}

/** The POS item behind a sales name ("Add A Side (Arugula)" → item and variation), for answers. */
export function posItemOf(model: Model) {
  return (catalogId: string, name: string) => {
    const m = name.match(/^(.*) \((.*)\)$/);
    const known = model.menuItems.find((x) => x.catalogId === catalogId);
    if (known && posName(known) === name) return { catalogId, itemName: known.itemName, ...(known.variationName ? { variationName: known.variationName } : {}) };
    return m ? { catalogId, itemName: m[1]!, variationName: m[2]! } : { catalogId, itemName: name };
  };
}

/** The menu as sales show it today, what came off, and what needs a manager. */
export function menuView(model: Model, view: AreaView = ALL) {
  const posItem = posItemOf(model);
  const today = model.today;
  const recent = addDays(today, -7);
  const categoryOf = new Map<string, string>();
  for (const l of model.sales) if (l.category) categoryOf.set(l.catalogId, l.category);
  const recipeCategory = new Map<string, string>();
  for (const d of model.margins.dishes) recipeCategory.set(d.recipeId, d.category);
  // Show dishes by the name they sell under on the POS, not the recipe card's name.
  const posNameOf = new Map<string, { name: string; quantity: number; catalogId: string }>();
  for (const sp of model.spans) {
    const link = model.lookup(sp.catalogId, sp.name, sp.last);
    if (!link) continue;
    const seen = posNameOf.get(link.recipeId);
    if (!seen || sp.quantity > seen.quantity) posNameOf.set(link.recipeId, { name: sp.name, quantity: sp.quantity, catalogId: sp.catalogId });
  }
  const shownName = (e: { name: string; recipeId?: string }) => (e.recipeId && posNameOf.get(e.recipeId)?.name) || e.name;
  // "Add a side (…)" buttons are add-ons, listed apart from the dishes.
  const sectionFor = (name: string, section: string) => (/^add\b/i.test(name) ? `${section} add-ons` : section);

  // Square's photo of the dish, when it has one.
  const imageFor = (e: { recipeId?: string }) => { const c = e.recipeId ? posNameOf.get(e.recipeId)?.catalogId : undefined; const url = c ? model.imageOf(c) : undefined; return url ? { image: url } : {}; };
  // The Square item behind a line (sales are by variation), for selling it online from the Menu screen.
  const itemIdOf = new Map(model.menuItems.filter((m) => m.itemId).map((m) => [m.catalogId, m.itemId!]));
  const squareItemFor = (catalogId?: string) => { const id = catalogId ? itemIdOf.get(catalogId) : undefined; return id ? { squareItemId: id } : {}; };
  // Discount buttons folded into this one: shown on its line, each able to be kept apart.
  const includesFor = (catalogId?: string) => { const f = catalogId ? model.folded.get(catalogId) : undefined; return f?.length ? { includes: f, catalogId } : {}; };
  const lastSoldOf = new Map<string, string>();
  for (const sp of model.spans) { const id = model.lookup(sp.catalogId, sp.name, sp.last)?.recipeId; if (id && (lastSoldOf.get(id) ?? '') < sp.last) lastSoldOf.set(id, sp.last); }
  const currentAll = onMenu(model.entries, today).map((e) => ({
    ...(e.recipeId && lastSoldOf.get(e.recipeId) ? { lastSold: lastSoldOf.get(e.recipeId) } : {}),
    ...imageFor(e),
    ...includesFor(e.recipeId ? posNameOf.get(e.recipeId)?.catalogId : undefined),
    ...squareItemFor(e.recipeId ? posNameOf.get(e.recipeId)?.catalogId : undefined),
    name: shownName(e),
    section: sectionFor(shownName(e), (e.recipeId && recipeCategory.get(e.recipeId)) || 'Other'),
    since: e.startsOn,
    hasCard: true,
    ...(e.recipeId && model.rough?.has(e.recipeId) ? { rough: true } : {}),
    ...(e.recipeId ? { menuKey: e.recipeId } : {}),
    ...(e.quietSince ? { quiet: { since: e.quietSince, after: e.quietAfter } } : {}),
  }));
  const baseOf = (section: string) => section.replace(/ add-ons$/, '');
  const current: ({ name: string; section: string; since: string; hasCard: boolean } & Record<string, unknown>)[] = currentAll.filter((x) => inArea(view, baseOf(x.section)));
  const cameOff: ({ name: string; section: string; from: string; to: string; hasCard: boolean } & Record<string, unknown>)[] = model.entries.filter((e) => e.endsOn && !onMenu(model.entries, today).some((o) => o.recipeId === e.recipeId))
    .map((e) => ({ ...imageFor(e), name: shownName(e), section: sectionFor(shownName(e), (e.recipeId && recipeCategory.get(e.recipeId)) || 'Other'), from: e.startsOn, to: e.endsOn!, hasCard: true, ...(e.recipeId ? { menuKey: e.recipeId } : {}) }))
    .filter((x) => inArea(view, baseOf(x.section)));

  // Selling with no card: on the menu by name until a card is linked. Recipe-card questions are
  // for kitchen categories that already have cards (drinks get costed another way).
  const foodSections = new Set([...recipeCategory.values()].filter((c) => view.areaOf(c) === 'kitchen'));
  // These come off the same way as dishes: only when a manager says so; quiet ones are asked about.
  const posDays = new Map<string, string[]>();
  for (const l of model.sales) if (l.date && l.quantity > 0) posDays.set(`${l.catalogId}|${l.name}`, [...(posDays.get(`${l.catalogId}|${l.name}`) ?? []), l.date]);
  const statusOf = new Map(model.menuStatus.map((a) => [a.recipeId, a]));
  for (const s of model.spans) {
    if (model.lookup(s.catalogId, s.name, s.last)) continue;
    const section = categoryOf.get(s.catalogId) ?? 'Other';
    if (!inArea(view, section) || s.quantity <= 0) continue;
    const menuKey = `pos:${s.catalogId}`;
    const item = { name: s.name, section: sectionFor(s.name, section), hasCard: false, pos: posItem(s.catalogId, s.name), menuKey, ...includesFor(s.catalogId), ...squareItemFor(s.catalogId), ...(model.imageOf(s.catalogId) ? { image: model.imageOf(s.catalogId)! } : {}) };
    const a = statusOf.get(menuKey);
    if (a?.status === 'off' && s.last <= a.date) { cameOff.push({ ...item, from: s.first, to: a.date >= s.first ? a.date : s.last }); continue; }
    const after = quietThreshold(posDays.get(`${s.catalogId}|${s.name}`) ?? []);
    const from = (a?.status === 'stillOn' || a?.status === 'on') && a.date > s.last ? a.date : s.last;
    const quiet = daysFrom(from, today) > after;
    current.push({ ...item, since: s.first, lastSold: s.last, ...(quiet ? { quiet: { since: s.last, after } } : {}) });
  }

  // Dishes and drinks with a recipe that aren't on now: to put back on the menu if one came off by mistake.
  const onNow = new Set(onMenu(model.entries, today).map((e) => e.recipeId));
  const categoryOfRecipe = new Map<string, string>();
  for (const m of model.menuItems) {
    const id = model.lookup(m.catalogId, posName(m), today)?.recipeId;
    if (id && m.category && !categoryOfRecipe.has(id)) categoryOfRecipe.set(id, m.category);
  }
  const addable = model.recipes.filter((r) => r.kind === 'dish' && !onNow.has(r.id))
    .map((r) => ({ menuKey: r.id, name: r.name, section: recipeCategory.get(r.id) ?? categoryOfRecipe.get(r.id) ?? 'Not sold yet' }))
    .filter((x) => x.section === 'Not sold yet' || inArea(view, x.section))
    .sort((a, b) => a.name.localeCompare(b.name));

  // For each line: plates a day while it's been on (open days since its first sale in the period),
  // its food cost (the period's plates against what they brought in), and its section's, to compare.
  const openDays = [...new Set(model.sales.filter((l) => l.date && l.quantity > 0).map((l) => l.date!))].sort();
  const openSince = (day: string) => Math.max(1, openDays.filter((d) => d >= day).length);
  const firstSoldOf = new Map<string, string>();
  for (const sp of model.spans) { const id = model.lookup(sp.catalogId, sp.name, sp.last)?.recipeId; if (id && (!firstSoldOf.has(id) || sp.first < firstSoldOf.get(id)!)) firstSoldOf.set(id, sp.first); }
  const dishOf = new Map(model.margins.dishes.map((d) => [d.recipeId, d]));
  const posQty = new Map<string, number>();
  for (const l of model.sales) if (l.quantity > 0) posQty.set(`${l.catalogId}|${l.name}`, (posQty.get(`${l.catalogId}|${l.name}`) ?? 0) + l.quantity);
  const costBySection = new Map<string, { cost: number; sales: number }>();
  for (const x of current) {
    const d = typeof x.menuKey === 'string' ? dishOf.get(x.menuKey) : undefined;
    if (d) {
      const first = firstSoldOf.get(d.recipeId) ?? x.since;
      Object.assign(x, { perDay: Math.round((d.quantity / openSince(first)) * 10) / 10, ...(d.cost.total > 0 && d.averagePrice > 0 ? { foodCost: d.foodCostShare, ...(d.cost.complete ? {} : { costEstimated: true }) } : {}) });
      if (d.cost.total > 0) { const c = costBySection.get(x.section) ?? { cost: 0, sales: 0 }; c.cost += d.plateCost * d.quantity; c.sales += d.netSales; costBySection.set(x.section, c); }
    } else if (x.pos) {
      const pos = x.pos as { catalogId: string };
      const q = [...posQty].filter(([k]) => k.startsWith(`${pos.catalogId}|`)).reduce((a, [, v]) => a + v, 0);
      if (q > 0) Object.assign(x, { perDay: Math.round((q / openSince(x.since)) * 10) / 10 });
    }
  }
  for (const x of current) { const c = costBySection.get(x.section); if (c && c.sales > 0) Object.assign(x, { sectionFoodCost: c.cost / c.sales }); }

  // Sections in order of the money they bring in, add-ons after their section.
  const sectionSales = new Map<string, number>();
  for (const l of model.sales) if (l.category) sectionSales.set(l.category, (sectionSales.get(l.category) ?? 0) + l.netSales);
  const rank = (section: string) => {
    const base = section.replace(/ add-ons$/, '');
    return -(sectionSales.get(base) ?? 0) + (section.endsWith(' add-ons') ? 0.5 : 0);
  };
  const order = (a: { section: string; name: string }, b: { section: string; name: string }) => rank(a.section) - rank(b.section) || a.section.localeCompare(b.section) || a.name.localeCompare(b.name);
  return {
    today,
    from: model.from,
    missing: model.missing,
    current: current.sort(order),
    cameOff: cameOff.sort((a, b) => b.to.localeCompare(a.to)),
    // Drinks get recipes too (a pour, a spec), so both sides flag what's selling without one.
    cards: true,
    addable,
    quietCount: current.filter((x) => x.quiet).length,
    coverage: coverageOf(model, view),
    checks: model.checks.filter((c) => inArea(view, (c.catalogId && categoryOf.get(c.catalogId)) || (c.recipeId && recipeCategory.get(c.recipeId)) || undefined)).map((c) => {
      const span = c.catalogId ? model.spans.filter((sp) => sp.catalogId === c.catalogId).sort((a, b) => b.last.localeCompare(a.last))[0] : undefined;
      const item = span ? posItem(span.catalogId, span.name) : undefined;
      return { kind: c.kind, title: c.title, dedupeKey: c.dedupeKey, netSales: money(c.netSales), suggestedDate: c.suggestedDate, ...(item ? { item } : {}) };
    }),
    linkQuestions: model.linkQuestions
      .filter((q) => view.area !== 'bar' && foodSections.has(q.item.category ?? ''))
      .slice(0, 10)
      .map((q) => {
        const span = model.spans.filter((sp) => sp.catalogId === q.item.catalogId && sp.name === q.posName)[0];
        return {
          type: q.type,
          name: q.posName,
          netSales: money(q.netSales),
          candidates: q.candidates.slice(0, 3).map((c) => c.name),
          candidateKinds: q.candidates.slice(0, 3).map((c) => c.kind),
          item: { catalogId: q.item.catalogId, itemName: q.item.itemName, ...(q.item.variationName ? { variationName: q.item.variationName } : {}) },
          ...(span ? { first: span.first, last: span.last } : {}),
        };
      }),
    recipes: model.recipes.filter((r) => r.kind === 'dish').map((r) => r.name).sort((a, b) => a.localeCompare(b)),
  };
}
