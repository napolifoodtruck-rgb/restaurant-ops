/**
 * The cost side of the reports: prime cost week by week, what the recipes say the food should
 * have cost against what was bought, sales and labor by weekday and hour, and each ingredient's
 * price over time with the vendor it came from.
 *
 * Purchases are by invoice date, so a week's food cost is what was bought that week; over a month
 * or more it evens out to what was used. Labor is hours × base wage from Square timecards: no
 * overtime premiums, payroll taxes or salaried pay.
 */

export const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The Monday a day's week starts on (weeks run Monday to Sunday). */
export const weekOf = (day: string) => shift(day, -((weekdayOf(day) + 6) % 7));
const money = (v: number) => Math.round(v * 100) / 100;

export type PurchaseKind = 'food' | 'bar' | 'other';
/** MarginEdge's category types: food, the bar's drinks, and everything else (supplies, repairs). */
export function purchaseKind(categoryType: string | undefined): PurchaseKind {
  if (!categoryType) return 'other';
  if (/^FOOD$/i.test(categoryType)) return 'food';
  if (/WINE|BEER|LIQUOR|BEVERAGE/i.test(categoryType)) return 'bar';
  return 'other';
}

export interface Purchase { date: string; amount: number; kind: PurchaseKind; productId?: string; vendor?: string }
export interface DaySales { day: string; sales: number }
export interface LaborDay { day: string; cost: number; hours: number; job?: string }

export interface PrimeWeek { week: string; days: number; sales: number; food: number; bar: number; labor: number; laborHours: number; prime: number; foodShare?: number; barShare?: number; laborShare?: number; primeShare?: number }

/** Prime cost by week: food and bar bought, plus labor, against sales. */
export function primeCost(sales: DaySales[], purchases: Purchase[], labor: LaborDay[]): { weeks: PrimeWeek[]; total: PrimeWeek; byJob: { job: string; cost: number; hours: number }[] } {
  const weeks = new Map<string, PrimeWeek & { daySet: Set<string> }>();
  const at = (day: string) => {
    const w = weekOf(day);
    let x = weeks.get(w);
    if (!x) { x = { week: w, days: 0, sales: 0, food: 0, bar: 0, labor: 0, laborHours: 0, prime: 0, daySet: new Set() }; weeks.set(w, x); }
    return x;
  };
  for (const s of sales) { const x = at(s.day); x.sales += s.sales; if (s.sales > 0) x.daySet.add(s.day); }
  for (const p of purchases) { if (p.kind === 'other') continue; at(p.date)[p.kind] += p.amount; }
  for (const l of labor) { const x = at(l.day); x.labor += l.cost; x.laborHours += l.hours; }
  const finish = (x: Omit<PrimeWeek, 'prime' | 'days'> & { days: number }): PrimeWeek => {
    const prime = x.food + x.bar + x.labor;
    const share = (v: number) => (x.sales > 0 ? v / x.sales : undefined);
    return { week: x.week, days: x.days, sales: money(x.sales), food: money(x.food), bar: money(x.bar), labor: money(x.labor), laborHours: Math.round(x.laborHours * 10) / 10, prime: money(prime),
      ...(x.sales > 0 ? { foodShare: share(x.food), barShare: share(x.bar), laborShare: share(x.labor), primeShare: share(prime) } : {}) };
  };
  const list = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map((x) => finish({ ...x, days: x.daySet.size }));
  const sum = (k: 'sales' | 'food' | 'bar' | 'labor' | 'laborHours' | 'days') => list.reduce((a, w) => a + w[k], 0);
  const jobs = new Map<string, { job: string; cost: number; hours: number }>();
  for (const l of labor) { const k = l.job || 'No job title'; const j = jobs.get(k) ?? { job: k, cost: 0, hours: 0 }; j.cost += l.cost; j.hours += l.hours; jobs.set(k, j); }
  return {
    weeks: list,
    total: finish({ week: list[0]?.week ?? '', days: sum('days'), sales: sum('sales'), food: sum('food'), bar: sum('bar'), labor: sum('labor'), laborHours: sum('laborHours') }),
    byJob: [...jobs.values()].map((j) => ({ job: j.job, cost: money(j.cost), hours: Math.round(j.hours * 10) / 10 })).sort((a, b) => b.cost - a.cost),
  };
}

export interface ExpectedUse { productId: string; name: string; dollars: number }
export interface UsageGap { productId: string; name: string; kind: PurchaseKind; bought: number; expected: number; gap: number; share?: number }

/**
 * What the recipes say was used (each dish sold × its recipe, at today's prices) against what was
 * bought, product by product. Without stock counts the two only meet over a month or more.
 */
export function usageGaps(expected: ExpectedUse[], purchases: Purchase[], names: Map<string, string>, kinds: Map<string, PurchaseKind>) {
  const bought = new Map<string, number>();
  for (const p of purchases) if (p.productId && p.kind !== 'other') bought.set(p.productId, (bought.get(p.productId) ?? 0) + p.amount);
  const used = new Map<string, number>();
  for (const e of expected) used.set(e.productId, (used.get(e.productId) ?? 0) + e.dollars);
  const ids = new Set([...bought.keys(), ...used.keys()]);
  const rows: UsageGap[] = [...ids].map((id) => {
    const b = bought.get(id) ?? 0, e = used.get(id) ?? 0;
    return { productId: id, name: names.get(id) ?? id, kind: kinds.get(id) ?? 'food', bought: money(b), expected: money(e), gap: money(b - e), ...(b > 0 ? { share: (b - e) / b } : {}) };
  });
  const onRecipes = rows.filter((r) => r.expected > 0);
  const offRecipes = rows.filter((r) => r.expected === 0 && r.bought > 0).sort((a, b) => b.bought - a.bought);
  const total = (xs: UsageGap[], k: 'bought' | 'expected') => money(xs.reduce((a, r) => a + r[k], 0));
  return {
    rows: onRecipes.sort((a, b) => b.gap - a.gap),
    notOnRecipes: offRecipes,
    totals: { bought: total(onRecipes, 'bought'), expected: total(onRecipes, 'expected'), gap: money(total(onRecipes, 'bought') - total(onRecipes, 'expected')), boughtOff: total(offRecipes, 'bought') },
  };
}

export interface HourSales { day: string; hour: number; sales: number; orders: number; covers: number }
export interface Shift { day: string; clockIn: string; clockOut: string; cost: number; job?: string }

/** Hours of each shift that fall in each clock hour of each day (local times "YYYY-MM-DD HH:MM:SS"). */
export function spreadShift(s: Pick<Shift, 'clockIn' | 'clockOut'>): { day: string; hour: number; hours: number }[] {
  const parse = (t: string) => Date.parse(`${t.replace(' ', 'T').slice(0, 19)}Z`);
  const start = parse(s.clockIn), end = parse(s.clockOut);
  const out: { day: string; hour: number; hours: number }[] = [];
  if (!(end > start) || end - start > 24 * 3_600_000) return out;
  for (let t = start; t < end;) {
    const hourStart = Math.floor(t / 3_600_000) * 3_600_000, next = Math.min(end, hourStart + 3_600_000);
    const d = new Date(hourStart);
    out.push({ day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), hours: (next - t) / 3_600_000 });
    t = next;
  }
  return out;
}

export interface HourCell { weekday: number; hour: number; sales: number; covers: number; laborHours: number; laborCost: number; perLaborHour?: number }

/**
 * The week by weekday and hour: average sales, covers and labor hours on that weekday's open days,
 * and sales per labor hour. Shifts are spread over the hours actually worked.
 */
export function hoursGrid(sales: HourSales[], shifts: Shift[]): { cells: HourCell[]; weekdays: number[]; hours: number[]; days: Record<number, number> } {
  const openDays = new Map<number, Set<string>>();
  for (const s of sales) if (s.sales > 0) { const w = weekdayOf(s.day); openDays.set(w, (openDays.get(w) ?? new Set()).add(s.day)); }
  const cells = new Map<string, HourCell>();
  const cell = (weekday: number, hour: number) => {
    const k = `${weekday}|${hour}`;
    let c = cells.get(k);
    if (!c) { c = { weekday, hour, sales: 0, covers: 0, laborHours: 0, laborCost: 0 }; cells.set(k, c); }
    return c;
  };
  for (const s of sales) { const c = cell(weekdayOf(s.day), s.hour); c.sales += s.sales; c.covers += s.covers; }
  for (const sh of shifts) {
    const total = spreadShift(sh).reduce((a, x) => a + x.hours, 0);
    for (const part of spreadShift(sh)) {
      const c = cell(weekdayOf(part.day), part.hour);
      c.laborHours += part.hours;
      c.laborCost += total > 0 ? (sh.cost * part.hours) / total : 0;
    }
  }
  const weekdays = [1, 2, 3, 4, 5, 6, 0].filter((w) => openDays.has(w));
  const days: Record<number, number> = Object.fromEntries(weekdays.map((w) => [w, openDays.get(w)!.size]));
  const out = [...cells.values()].filter((c) => days[c.weekday]).map((c) => {
    const n = days[c.weekday]!;
    const sales = c.sales / n, hours = c.laborHours / n;
    return { weekday: c.weekday, hour: c.hour, sales: money(sales), covers: Math.round((c.covers / n) * 10) / 10, laborHours: Math.round(hours * 10) / 10, laborCost: money(c.laborCost / n), ...(hours >= 0.5 ? { perLaborHour: money(sales / hours) } : {}) };
  });
  const active = out.filter((c) => c.sales > 0 || c.laborHours > 0).map((c) => c.hour);
  const hours = active.length ? Array.from({ length: Math.max(...active) - Math.min(...active) + 1 }, (_, i) => Math.min(...active) + i) : [];
  return { cells: out, weekdays, hours, days };
}

export interface PricePaid { date: string; vendor?: string; perUnit: number; packPrice: number; pack: string; quantity: number }

/**
 * An ingredient's price over time: each purchase (per base unit, so packs and vendors compare),
 * where the vendor changed, and how much it's moved over the last 90 days and the last year.
 */
export function priceHistory(points: PricePaid[], today: string) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const switches: { date: string; from?: string; to?: string }[] = [];
  for (let i = 1; i < sorted.length; i++) if ((sorted[i]!.vendor ?? '') !== (sorted[i - 1]!.vendor ?? '')) switches.push({ date: sorted[i]!.date, from: sorted[i - 1]!.vendor, to: sorted[i]!.vendor });
  const around = (day: string, window: number) => {
    const xs = sorted.filter((p) => Math.abs(Date.parse(p.date) - Date.parse(day)) <= window * 86_400_000);
    if (!xs.length) return undefined;
    const q = xs.reduce((a, p) => a + p.quantity, 0);
    return q > 0 ? xs.reduce((a, p) => a + p.perUnit * p.quantity, 0) / q : xs[xs.length - 1]!.perUnit;
  };
  const latest = sorted.length ? around(sorted[sorted.length - 1]!.date, 21) : undefined;
  const change = (daysBack: number) => {
    const was = around(shift(today, -daysBack), 30);
    return latest !== undefined && was ? latest / was - 1 : undefined;
  };
  const vendors = new Map<string, { vendor: string; purchases: number; spent: number; last: string; lastPerUnit: number; lastPack: string; lastPackPrice: number }>();
  for (const p of sorted) {
    const k = p.vendor ?? 'Unknown vendor';
    const v = vendors.get(k) ?? { vendor: k, purchases: 0, spent: 0, last: p.date, lastPerUnit: p.perUnit, lastPack: p.pack, lastPackPrice: p.packPrice };
    v.purchases++; v.spent += p.packPrice * p.quantity;
    v.last = p.date; v.lastPerUnit = p.perUnit; v.lastPack = p.pack; v.lastPackPrice = p.packPrice;
    vendors.set(k, v);
  }
  const list = [...vendors.values()].map((v) => ({ ...v, spent: money(v.spent), lastPerUnit: Math.round(v.lastPerUnit * 10000) / 10000 })).sort((a, b) => b.last.localeCompare(a.last));
  const cheaper = cheaperVendor(list, sorted[sorted.length - 1]?.vendor, today);
  return {
    points: sorted,
    switches,
    ...(latest !== undefined ? { latest: Math.round(latest * 10000) / 10000 } : {}),
    ...(change(90) !== undefined ? { change90: change(90) } : {}),
    ...(change(365) !== undefined ? { change365: change(365) } : {}),
    vendors: list,
    ...(cheaper ? { cheaper } : {}),
  };
}

/**
 * Whether another vendor's last price beat what we pay now: the cheapest other vendor whose last
 * price is at least 3% under the current vendor's last price, from the last 6 months. `daysOld` says
 * how stale that price is, so an older quote can be flagged rather than trusted.
 */
export function cheaperVendor(vendors: readonly { vendor: string; last: string; lastPerUnit: number }[], current: string | undefined, today: string):
  { vendor: string; perUnit: number; date: string; current: string; currentPerUnit: number; saves: number; daysOld: number } | undefined {
  if (!current) return undefined;
  const now = vendors.find((v) => v.vendor === current);
  if (!now || !(now.lastPerUnit > 0)) return undefined;
  const best = vendors.filter((v) => v.vendor !== current && v.vendor !== 'Unknown vendor' && v.lastPerUnit > 0)
    .sort((a, b) => a.lastPerUnit - b.lastPerUnit)[0];
  if (!best || best.lastPerUnit > now.lastPerUnit * 0.97) return undefined;
  const daysOld = Math.max(0, Math.round((Date.parse(today) - Date.parse(best.last)) / 86_400_000));
  if (daysOld > 180) return undefined; // a price from over 6 months ago says little about today
  return { vendor: best.vendor, perUnit: best.lastPerUnit, date: best.last, current, currentPerUnit: now.lastPerUnit,
    saves: Math.round((1 - best.lastPerUnit / now.lastPerUnit) * 1000) / 1000, daysOld };
}
