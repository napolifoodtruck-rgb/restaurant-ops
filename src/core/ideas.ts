/**
 * Ideas: what the numbers suggest doing, each worth a figure in dollars a month, so the list can be
 * ranked by money. Each rule needs a pattern that holds (weeks, not a blip) and enough data behind
 * it, says why in numbers, and points to where to act.
 *
 *   waste    an ingredient bought well beyond what the recipes use, two periods running
 *   unused   bought every month, but no recipe uses it
 *   price    an ingredient up a lot in 90 days, at what you buy of it
 *   vendor   the same item cheaper from another vendor lately
 *   dish     a dish selling clearly less than it did, in gross profit lost
 *   foodcost a dish whose food cost runs well over its section's: the price that would fix it
 *   labor    hours of the week staffed well beyond the sales they bring
 *   prep     one cook taking much longer than the others on one item, over several times
 */

export type IdeaKind = 'waste' | 'unused' | 'price' | 'vendor' | 'dish' | 'foodcost' | 'labor' | 'prep';
export interface Idea {
  /** Stable across days, so Not now and Done stick to the same idea. */
  key: string;
  kind: IdeaKind;
  area?: 'kitchen' | 'bar';
  title: string;
  /** Dollars a month at stake. */
  monthly: number;
  /** The numbers behind it, a line each. */
  why: string[];
  /** What to try. */
  suggestion: string;
  /** Where to look or act. */
  go?: { to: 'usage' | 'prices' | 'performance' | 'menu' | 'hours' | 'prep' | 'recipes'; productId?: string; name?: string; area?: 'kitchen' | 'bar' };
}

const round = (v: number) => Math.round(v);
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const perMonth = (amount: number, days: number) => (amount * 30) / Math.max(days, 1);

// ---------------------------------------------------------------- waste and unused

export interface UsageRow { productId: string; name: string; bought: number; expected: number; gap: number }
/**
 * Bought well beyond what the recipes used, in this period and the one before (stock evens out over
 * two periods, so a single big delivery doesn't count). Worth it from $75 a month and 15% of what was bought.
 */
export function wasteIdeas(now: UsageRow[], before: UsageRow[] | undefined, days: number, area: 'kitchen' | 'bar', opts: { minMonthly?: number; minShare?: number } = {}): Idea[] {
  const minMonthly = opts.minMonthly ?? 75, minShare = opts.minShare ?? 0.15;
  const prev = new Map((before ?? []).map((r) => [r.productId, r]));
  return now.flatMap((r) => {
    const monthly = perMonth(r.gap, days);
    if (r.bought <= 0 || r.expected <= 0 || monthly < minMonthly || r.gap / r.bought < minShare) return [];
    const p = prev.get(r.productId);
    if (before && !(p && p.gap > 0 && p.bought > 0 && p.gap / p.bought >= minShare / 2)) return [];
    return [{
      key: `waste:${area}:${r.productId}`, kind: 'waste' as const, area, monthly: round(monthly),
      title: `${r.name}: about ${money(monthly)} a month more bought than the recipes use`,
      why: [`Last ${days} days: ${money(r.bought)} bought, recipes account for ${money(r.expected)} (${pct(r.gap / r.bought)} unexplained).`,
        ...(p ? [`The ${days} days before: ${money(p.bought)} bought, ${money(p.expected)} by recipe. It's not one big delivery.`] : [])],
      suggestion: 'Check portions on the line against the recipe, what gets thrown out, and comps. If the recipe is short an amount, fix the recipe instead.',
      go: { to: 'usage', productId: r.productId, name: r.name, area },
    }];
  });
}

/** Not food at all, though filed with it: deposits, fees, delivery. */
const NOT_FOOD = /\b(deposit|fee|fees|delivery|fuel|surcharge|credit|rebate|rental)\b/i;
/**
 * Bought regularly, but no recipe uses it: its cost lands nowhere. One idea each for the biggest (up to
 * six); the rest together. When a side has few recipes yet (they explain under 30% of what's bought,
 * like the bar before its drinks have specs), one idea for the lot: write the recipes first.
 */
export function unusedIdeas(rows: { productId: string; name: string; bought: number }[], days: number, area: 'kitchen' | 'bar', opts: { minMonthly?: number; coverage?: number } = {}): Idea[] {
  const minMonthly = opts.minMonthly ?? 75;
  const items = rows.filter((r) => !NOT_FOOD.test(r.name) && r.bought > 0).sort((a, b) => b.bought - a.bought);
  const total = perMonth(items.reduce((a, r) => a + r.bought, 0), days);
  const side = area === 'bar' ? 'bar' : 'kitchen';
  const names = (xs: typeof items) => xs.slice(0, 5).map((r) => r.name).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '');
  if (opts.coverage !== undefined && opts.coverage < 0.3) {
    if (total < minMonthly) return [];
    return [{
      key: `unused:${area}:all`, kind: 'unused', area, monthly: round(total),
      title: `${items.length} ${side} items, about ${money(total)} a month, aren't in any recipe yet`,
      why: [`Recipes explain only ${pct(opts.coverage)} of what the ${side} buys, so waste can't be told apart from missing recipes yet.`, `Biggest: ${names(items)}.`],
      suggestion: area === 'bar' ? 'Draft the drink recipes (Recipes › Draft recipes does most of it): pours, specs and cans. Then these turn into real waste checks.' : 'Write the missing recipes; then these turn into real waste checks.',
      go: { to: 'recipes' },
    }];
  }
  const big = items.filter((r) => perMonth(r.bought, days) >= minMonthly).slice(0, 6);
  const rest = items.filter((r) => !big.includes(r));
  const restMonthly = perMonth(rest.reduce((a, r) => a + r.bought, 0), days);
  return [
    ...big.map((r) => {
      const monthly = perMonth(r.bought, days);
      return {
        key: `unused:${area}:${r.productId}`, kind: 'unused' as const, area, monthly: round(monthly),
        title: `${r.name}: ${money(monthly)} a month bought, but no recipe uses it`,
        why: [`${money(r.bought)} on invoices in the last ${days} days, and it isn't in any recipe, so no dish carries its cost.`],
        suggestion: 'Add it to the recipes that use it (or a special\'s recipe). If it isn\'t food, file it as supplies in MarginEdge.',
        go: { to: 'prices' as const, productId: r.productId, name: r.name },
      };
    }),
    ...(rest.length >= 3 && restMonthly >= minMonthly * 2 ? [{
      key: `unused:${area}:rest`, kind: 'unused' as const, area, monthly: round(restMonthly),
      title: `${rest.length} smaller ${side} items, about ${money(restMonthly)} a month, aren't in any recipe`,
      why: [`Each under ${money(minMonthly)} a month: ${names(rest)}.`],
      suggestion: 'Worth a pass through the recipes: most are a line missing from one.',
      go: { to: 'usage' as const, area },
    }] : []),
  ];
}

// ---------------------------------------------------------------- prices and vendors

export interface PricePoint { date: string; vendor?: string; perUnit: number; packPrice: number; quantity: number }
export interface ProductPrices { productId: string; name: string; unit: string; points: PricePoint[]; change90?: number }

/** Up 8% or more in 90 days, at what's been bought since: from $25 a month. */
export function priceIdeas(products: ProductPrices[], today: string, minMonthly = 25): Idea[] {
  const since = shift(today, -90);
  return products.flatMap((p) => {
    if (p.change90 === undefined || p.change90 < 0.08) return [];
    const spent = p.points.filter((x) => x.date >= since).reduce((a, x) => a + x.packPrice * x.quantity, 0);
    const monthly = (spent - spent / (1 + p.change90)) / 3;
    if (monthly < minMonthly) return [];
    return [{
      key: `price:${p.productId}`, kind: 'price' as const, monthly: round(monthly),
      title: `${p.name} is up ${pct(p.change90)} in 3 months: about ${money(monthly)} a month more`,
      why: [`${money(spent)} spent on it in the last 90 days.`, `Price now ${perUnitText(lastOf(p.points)!.perUnit)}/${p.unit}.`],
      suggestion: 'Ask the vendor, price it against another vendor, or check whether a dish needs a new price.',
      go: { to: 'prices', productId: p.productId, name: p.name },
    }];
  });
}

/** Bought lately from one vendor while another sold it 5%+ cheaper in the last 4 months: what switching saves. */
export function vendorIdeas(products: ProductPrices[], today: string, minMonthly = 20): Idea[] {
  const since = shift(today, -120);
  return products.flatMap((p) => {
    const recent = p.points.filter((x) => x.date >= since && x.vendor);
    const now = lastOf(recent);
    if (!now?.vendor) return [];
    const latestBy = new Map<string, PricePoint>();
    for (const x of recent) latestBy.set(x.vendor!, x);
    // 5% cheaper or more; past 40% it's more likely a different product or a pack logged wrong than a deal.
    const others = [...latestBy.values()].filter((x) => x.vendor !== now.vendor && x.perUnit <= now.perUnit * 0.95 && x.perUnit >= now.perUnit * 0.6).sort((a, b) => a.perUnit - b.perUnit);
    const best = others[0];
    if (!best) return [];
    const units = recent.filter((x) => x.date >= shift(today, -90)).reduce((a, x) => a + (x.packPrice * x.quantity) / x.perUnit, 0);
    const monthly = ((now.perUnit - best.perUnit) * units) / 3;
    if (monthly < minMonthly) return [];
    return [{
      key: `vendor:${p.productId}:${best.vendor}`, kind: 'vendor' as const, monthly: round(monthly),
      title: `${p.name}: ${best.vendor} had it ${pct(1 - best.perUnit / now.perUnit)} cheaper, about ${money(monthly)} a month`,
      why: [`Last bought from ${now.vendor} at ${perUnitText(now.perUnit)}/${p.unit} (${now.date}).`, `${best.vendor}: ${perUnitText(best.perUnit)}/${p.unit} on ${best.date}.`, `At what you've bought in 90 days.`],
      suggestion: `Ask ${now.vendor} to match, or order it from ${best.vendor} (check it's the same product and pack).`,
      go: { to: 'prices', productId: p.productId, name: p.name },
    }];
  });
}

// ---------------------------------------------------------------- dishes

export interface DishNumbers {
  recipeId: string; name: string; sold: number; averagePrice: number; plateCost: number; leftPerPlate: number;
  foodCostShare?: number; estimated?: boolean; offSince?: string; trend?: { change?: number; series: (number | null)[] };
}
export interface CategoryNumbers { name: string; foodCostShare?: number; dishes: DishNumbers[] }

/**
 * Selling clearly less than it did: plates a day in the latest weeks against the first ones, down 30%+
 * over at least four weeks, in gross profit lost a month. From $150 a month.
 */
export function dishIdeas(categories: CategoryNumbers[], openDaysPerMonth: number, area: 'kitchen' | 'bar', minMonthly = 150): Idea[] {
  return categories.flatMap((c) => c.dishes.flatMap((d) => {
    const pts = (d.trend?.series ?? []).filter((v): v is number => v !== null);
    if (d.offSince || pts.length < 4 || (d.trend?.change ?? 0) > -0.3) return [];
    const early = (pts[0]! + pts[1]!) / 2, late = (pts[pts.length - 1]! + pts[pts.length - 2]!) / 2;
    if (!(late < early)) return [];
    const monthly = (early - late) * d.leftPerPlate * openDaysPerMonth;
    if (monthly < minMonthly) return [];
    return [{
      key: `dish:${d.recipeId}`, kind: 'dish' as const, area, monthly: round(monthly),
      title: `${d.name} is selling less: about ${money(monthly)} a month less gross profit`,
      why: [`From about ${early.toFixed(1)} plates a day to ${late.toFixed(1)} over the period.`, `Each plate leaves ${money(d.leftPerPlate)} after food cost.`],
      suggestion: 'Ask the servers why, try it as a feature, or plan what replaces it under Menu › Coming up.',
      go: { to: 'performance', area },
    }];
  }));
}

/**
 * Food cost well over its section's (8+ points) on a dish that sells: the money at today's sales, and
 * the price that would bring it to the section's level. From $100 a month.
 */
export function foodCostIdeas(categories: CategoryNumbers[], days: number, area: 'kitchen' | 'bar', minMonthly = 100): Idea[] {
  return categories.flatMap((c) => c.dishes.flatMap((d) => {
    if (c.foodCostShare === undefined || d.foodCostShare === undefined || d.offSince || d.estimated || d.foodCostShare <= c.foodCostShare + 0.08 || d.averagePrice <= 0) return [];
    const sales = d.sold * d.averagePrice;
    const monthly = perMonth((d.foodCostShare - c.foodCostShare) * sales, days);
    if (monthly < minMonthly) return [];
    const fair = d.plateCost / c.foodCostShare;
    return [{
      key: `foodcost:${d.recipeId}`, kind: 'foodcost' as const, area, monthly: round(monthly),
      title: `${d.name} runs ${pct(d.foodCostShare)} food cost, against ${pct(c.foodCostShare)} for ${c.name.toLowerCase()}`,
      why: [`Plate cost ${money2(d.plateCost)} at an average ${money2(d.averagePrice)} paid.`, `About ${money(monthly)} a month more food cost than if it ran like the rest of ${c.name.toLowerCase()}.`],
      suggestion: `A price around ${money2(Math.ceil(fair))} brings it in line, or trim the portion of its priciest ingredient.`,
      go: { to: 'performance', area },
    }];
  }));
}

// ---------------------------------------------------------------- labor

export interface HourCell { weekday: number; hour: number; sales: number; laborHours: number; perLaborHour?: number }
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const hourText = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
/**
 * Hours (on an average open weekday) where sales per labor hour sit under half the usual, run
 * together into stretches: the hours beyond what the usual rate needs, at the average wage. From $100 a month.
 */
export function laborIdeas(cells: HourCell[], wage: number, minMonthly = 100): Idea[] {
  const rated = cells.filter((c) => c.sales > 0 && c.laborHours > 0).map((c) => c.sales / c.laborHours).sort((a, b) => a - b);
  if (rated.length < 10 || !(wage > 0)) return [];
  const usual = rated[Math.floor(rated.length / 2)]!;
  const low = cells.filter((c) => c.sales > 0 && c.laborHours >= 1.5 && c.sales / c.laborHours < usual / 2).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const runs: HourCell[][] = [];
  for (const c of low) {
    const last = runs[runs.length - 1]?.at(-1);
    if (last && last.weekday === c.weekday && last.hour === c.hour - 1) runs[runs.length - 1]!.push(c); else runs.push([c]);
  }
  return runs.flatMap((r) => {
    const hours = r.reduce((a, c) => a + c.laborHours, 0), sales = r.reduce((a, c) => a + c.sales, 0);
    const extra = hours - sales / usual;
    const monthly = extra * wage * 4.3;
    if (monthly < minMonthly) return [];
    const span = `${hourText(r[0]!.hour)}–${hourText(r[r.length - 1]!.hour + 1)}`;
    return [{
      key: `labor:${r[0]!.weekday}:${r[0]!.hour}-${r[r.length - 1]!.hour}`, kind: 'labor' as const, monthly: round(monthly),
      title: `${WEEKDAYS[r[0]!.weekday]} ${span}: about ${Math.round(extra * 10) / 10} more labor hours than the sales need`,
      why: [`On an average ${WEEKDAYS[r[0]!.weekday]!.slice(0, -1)}, ${Math.round(hours * 10) / 10} hours worked against ${money(sales)} in sales then.`, `The usual is ${money(usual)} in sales per labor hour; this stretch runs ${money(sales / hours)}.`, `At about ${money2(wage)} an hour, over a month.`],
      suggestion: 'Start a shift later or send someone home sooner on that day, or move prep into that time.',
      go: { to: 'hours' },
    }];
  });
}

// ---------------------------------------------------------------- prep

export interface PrepTime { itemId: string; name: string; minutes: number; amount?: number; unit?: string; by?: string; byName?: string; date: string }
/**
 * One cook much slower than the rest on one item: 1.5× the others' usual or more, over 4+ times,
 * with others timed on it too. The extra time a month at the kitchen's average wage. From $20 a month.
 */
export function prepIdeas(times: PrepTime[], days: number, wage: number, minMonthly = 20): Idea[] {
  const byItem = new Map<string, PrepTime[]>();
  for (const t of times) if (t.by) byItem.set(t.itemId, [...(byItem.get(t.itemId) ?? []), t]);
  const out: Idea[] = [];
  for (const [itemId, ts] of byItem) {
    const cooks = new Map<string, PrepTime[]>();
    for (const t of ts) cooks.set(t.by!, [...(cooks.get(t.by!) ?? []), t]);
    for (const [by, mine] of cooks) {
      const others = ts.filter((t) => t.by !== by);
      if (mine.length < 4 || others.length < 3) continue;
      // Compared per amount made when every time has one (a double batch takes longer), else per time.
      const sized = ts.every((t) => t.amount !== undefined && t.amount > 0);
      const rate = (t: PrepTime) => (sized ? t.minutes / t.amount! : t.minutes);
      const theirsRate = median(others.map(rate)), mineRate = median(mine.map(rate));
      if (!(theirsRate > 0) || mineRate / theirsRate < 1.5) continue;
      const theirs = median(others.map((t) => t.minutes)), mineMed = median(mine.map((t) => t.minutes));
      const extraMinutes = mine.reduce((a, t) => a + Math.max(0, t.minutes - theirsRate * (sized ? t.amount! : 1)), 0);
      const monthly = perMonth((extraMinutes / 60) * wage, days);
      if (monthly < minMonthly) continue;
      const name = mine[0]!.byName ?? 'A cook';
      out.push({
        key: `prep:${itemId}:${by}`, kind: 'prep', monthly: round(monthly),
        title: `${mine[0]!.name}: ${name} takes about ${Math.round(mineMed)} minutes, the others about ${Math.round(theirs)}`,
        why: [`${mine.length} times for ${name}, ${others.length} for the others, in the last ${days} days${sized ? ', compared per amount made' : ''}.`, `About ${Math.round(perMonth(extraMinutes, days) / 6) / 10} extra hours a month at ${money2(wage)} an hour.`],
        suggestion: `Pair ${name} with whoever is quickest on it for one round, or check the recipe and setup for that item.`,
        go: { to: 'prep' },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }
function shift(day: string, n: number) { return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }
function lastOf<T extends { date: string }>(xs: T[]): T | undefined { return [...xs].sort((a, b) => a.date.localeCompare(b.date)).at(-1); }
function perUnitText(v: number) { return `$${v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(3) : v.toFixed(4)}`; }
function money2(v: number) { return `$${v.toFixed(2)}`; }

/** All of them, the most money first; one idea per key. */
export function rankIdeas(ideas: Idea[]): Idea[] {
  const seen = new Set<string>();
  return ideas.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true))).sort((a, b) => b.monthly - a.monthly);
}
