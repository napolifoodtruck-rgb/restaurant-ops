/**
 * What the screens show, shaped from the model: plain JSON, rounded for display.
 */

import type { Model } from './model.ts';
import { onMenu } from '../core/menu.ts';
import { posName } from '../core/menuLinks.ts';

const money = (v: number) => Math.round(v * 100) / 100;
const share = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Margins by category, biggest money first. Only categories with at least one dish that has a recipe. */
export function marginsView(model: Model) {
  const stillOn = addDays(model.today, -7);
  // When each recipe was on the menu, from the days it sold (by version, so a summer and a
  // fall dish on one button each get their own days), and which days the restaurant was open.
  const openDays = new Set<string>();
  const sold = new Map<string, { first: string; last: string }>();
  for (const l of model.sales) {
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
  /** Open days a dish was on the menu: first sale to last, or to the period's end if it's still on. */
  const daysOn = (recipeId: string): number | undefined => {
    const s = sold.get(recipeId);
    if (!s) return undefined;
    const end = s.last >= stillOn ? model.today : s.last;
    return open.filter((d) => d >= s.first && d <= end).length || undefined;
  };
  const byCategory = new Map<string, Model['margins']['dishes']>();
  for (const d of model.margins.dishes) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);
  const categories = [...byCategory].map(([name, dishes]) => {
    const netSales = dishes.reduce((s, d) => s + d.netSales, 0);
    const food = dishes.reduce((s, d) => s + d.plateCost * d.quantity, 0);
    const missing = model.margins.unlinked.filter((u) => u.category === name && u.netSales > 0);
    return {
      name,
      netSales: money(netSales),
      leftOver: money(netSales - food),
      foodCostShare: share(netSales > 0 ? food / netSales : 0),
      dishes: dishes.map((d) => ({
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
        // Came off the menu during the period: its money is real, but it's not a dish to work on.
        ...((lastSold.get(d.recipeId) ?? model.today) < stillOn ? { offSince: lastSold.get(d.recipeId) } : {}),
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
  const t = model.margins.totals;
  return {
    from: model.from,
    to: model.today,
    dataFrom: model.dataFrom,
    openDays: openDays.size,
    weeks: weeks.map((w) => w.from),
    missing: model.missing,
    totals: { netSales: money(t.netSales), foodCostShare: share(t.foodCostShare), leftOver: money(t.contribution), coverage: share(model.margins.coverage) },
    categories,
  };
}

/** The POS item behind a sales name ("Add A Side (Arugula)" → item and variation), for answers. */
function posItemOf(model: Model) {
  return (catalogId: string, name: string) => {
    const m = name.match(/^(.*) \((.*)\)$/);
    const known = model.menuItems.find((x) => x.catalogId === catalogId);
    if (known && posName(known) === name) return { catalogId, itemName: known.itemName, ...(known.variationName ? { variationName: known.variationName } : {}) };
    return m ? { catalogId, itemName: m[1]!, variationName: m[2]! } : { catalogId, itemName: name };
  };
}

/** The menu as sales show it today, what came off, and what needs a manager. */
export function menuView(model: Model) {
  const posItem = posItemOf(model);
  const today = model.today;
  const recent = addDays(today, -7);
  const categoryOf = new Map<string, string>();
  for (const l of model.sales) if (l.category) categoryOf.set(l.catalogId, l.category);
  const recipeCategory = new Map<string, string>();
  for (const d of model.margins.dishes) recipeCategory.set(d.recipeId, d.category);
  // Show dishes by the name they sell under on the POS, not the recipe card's name.
  const posNameOf = new Map<string, { name: string; quantity: number }>();
  for (const sp of model.spans) {
    const link = model.lookup(sp.catalogId, sp.name, sp.last);
    if (!link) continue;
    const seen = posNameOf.get(link.recipeId);
    if (!seen || sp.quantity > seen.quantity) posNameOf.set(link.recipeId, { name: sp.name, quantity: sp.quantity });
  }
  const shownName = (e: { name: string; recipeId?: string }) => (e.recipeId && posNameOf.get(e.recipeId)?.name) || e.name;
  // "Add a side (…)" buttons are add-ons, listed apart from the dishes.
  const sectionFor = (name: string, section: string) => (/^add\b/i.test(name) ? `${section} add-ons` : section);

  const current = onMenu(model.entries, today).map((e) => ({
    name: shownName(e),
    section: sectionFor(shownName(e), (e.recipeId && recipeCategory.get(e.recipeId)) || 'Other'),
    since: e.startsOn,
    hasCard: true,
  }));
  const cameOff = model.entries.filter((e) => e.endsOn).map((e) => ({ name: shownName(e), section: sectionFor(shownName(e), (e.recipeId && recipeCategory.get(e.recipeId)) || 'Other'), from: e.startsOn, to: e.endsOn!, hasCard: true }));

  // Selling with no card: on the menu by name until a card is linked.
  const foodSections = new Set([...recipeCategory.values()]);
  for (const s of model.spans) {
    if (model.lookup(s.catalogId, s.name, s.last)) continue;
    const section = categoryOf.get(s.catalogId) ?? 'Other';
    if (!foodSections.has(section) || s.quantity <= 0) continue;
    const item = { name: s.name, section: sectionFor(s.name, section), hasCard: false };
    if (s.last >= recent) current.push({ ...item, since: s.first });
    else cameOff.push({ ...item, from: s.first, to: s.last });
  }

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
    checks: model.checks.map((c) => {
      const span = c.catalogId ? model.spans.filter((sp) => sp.catalogId === c.catalogId).sort((a, b) => b.last.localeCompare(a.last))[0] : undefined;
      const item = span ? posItem(span.catalogId, span.name) : undefined;
      return { kind: c.kind, title: c.title, dedupeKey: c.dedupeKey, netSales: money(c.netSales), suggestedDate: c.suggestedDate, ...(item ? { item } : {}) };
    }),
    linkQuestions: model.linkQuestions
      .filter((q) => foodSections.has(q.item.category ?? ''))
      .slice(0, 10)
      .map((q) => {
        const span = model.spans.filter((sp) => sp.catalogId === q.item.catalogId && sp.name === q.posName)[0];
        return {
          type: q.type,
          name: q.posName,
          netSales: money(q.netSales),
          candidates: q.candidates.slice(0, 3).map((c) => c.name),
          item: { catalogId: q.item.catalogId, itemName: q.item.itemName, ...(q.item.variationName ? { variationName: q.item.variationName } : {}) },
          ...(span ? { first: span.first, last: span.last } : {}),
        };
      }),
    recipes: model.recipes.filter((r) => r.kind === 'dish').map((r) => r.name).sort((a, b) => a.localeCompare(b)),
  };
}
