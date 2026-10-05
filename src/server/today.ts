/**
 * Today: what needs someone, deadlines first, then by the money behind it.
 *
 *   GET /api/today
 *
 * Everyone sees prep: today's lists and how far along they are, and the count for the next
 * day the restaurant opens. Managers also see menu questions, plate-cost gaps, ingredient
 * prices that moved enough to matter, dishes coming to the menu and sync problems, plus a
 * short "at a glance" of the last service, the week so far and the dishes earning most.
 *
 * Nothing here is stored: it's worked out from the prep lists, the model and the syncs on
 * each look, so an answered question or a finished list simply drops off.
 */

import type { Db } from './db.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, type Model } from './model.ts';
import { gapsOf, menuView } from './views.ts';
import { view as stationDay } from './prep.ts';
import { blendedPrices } from '../connectors/marginedge.ts';

export interface TodayItem {
  key: string;
  group: 'prep' | 'menu' | 'costs' | 'setup';
  /** Short label down the left: "Count", "Question", "Price". */
  label: string;
  tone: 'due' | 'ask' | 'alert' | 'info';
  title: string;
  detail?: string;
  /** The day it's needed by; items with a day come first. */
  due?: string;
  /** Money behind it, for ordering the rest. */
  dollars?: number;
  go: { to: 'count' | 'review' | 'work' | 'menu' | 'performance' | 'settings'; stationId?: string; date?: string };
  button: string;
  /** Answers that can be given right here (POST /api/answers), the likeliest first. */
  answers?: { label: string; body: Record<string, unknown> }[];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SERVICE_HOUR = 17;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const dollars = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const cents = (v: number) => `$${v.toFixed(2)}`;
const list = (names: string[], max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);

/** Weekdays the restaurant opens, from the last 8 weeks of sales (every day, with no sales yet). */
async function openWeekdays(db: Db, restaurantId: string, today: string): Promise<Set<number>> {
  const rows = (await db.query<{ day: string }>('SELECT DISTINCT day::text AS day FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day < $2 AND day >= $3 AND net_sales > 0', [restaurantId, today, addDays(today, -56)])).rows;
  if (rows.length < 7) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const n = new Map<number, number>();
  for (const r of rows) n.set(weekday(r.day), (n.get(weekday(r.day)) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c >= 3).map(([w]) => w));
}

/** Prep: today's lists and the next count, for the stations this person sees. */
async function prepItems(db: Db, who: SignedIn, stations: { id: string; name: string }[], today: string, hour: number, openToday: boolean, nextOpen: string) {
  const manager = atLeast(who.roleLevel, 'chef');
  const items: TodayItem[] = [];
  const status: { stationId: string; station: string; today?: { approved: boolean; left: number; total: number }; next: { date: string; counted: number; toCount: number; approved: boolean } }[] = [];
  const nextName = nextOpen === addDays(today, 1) ? 'tomorrow' : DAYS[weekday(nextOpen)]!;
  for (const s of stations) {
    let todayStatus;
    if (openToday) {
      const v = await stationDay(db, who, s.id, today);
      const work = v.lines.filter((l: any) => l.kind === 'task' || (l.toMake ?? 0) > 0);
      const left = [...work.filter((l: any) => !l.doneAt).map((l: any) => l.name as string), ...v.checklist.filter((c) => !c.doneAt).map((c) => c.name)];
      const total = work.length + v.checklist.length;
      todayStatus = { approved: v.status === 'approved', left: left.length, total };
      if (total && v.status !== 'approved') {
        items.push(manager
          ? { key: `prep:approve:${s.id}:${today}`, group: 'prep', label: 'Prep', tone: 'due', due: today, title: `${s.name}: today’s list isn’t approved`, detail: 'The station can’t start until it is.', go: { to: 'review', stationId: s.id, date: today }, button: 'Review' }
          : { key: `prep:wait:${s.id}:${today}`, group: 'prep', label: 'Prep', tone: 'info', due: today, title: `${s.name}: waiting for a manager to approve today’s list`, go: { to: 'work', stationId: s.id, date: today }, button: 'See list' });
      } else if (left.length) {
        const late = hour >= SERVICE_HOUR - 2;
        items.push({ key: `prep:work:${s.id}:${today}`, group: 'prep', label: late ? 'Prep, before 5' : 'Prep today', tone: late ? 'due' : 'info', due: today,
          title: `${s.name}: ${left.length} of ${total} left`, detail: list(left), go: { to: 'work', stationId: s.id, date: today }, button: 'Open list' });
      }
    }
    // The count for the next open day: tonight if that's tomorrow.
    const n = await stationDay(db, who, s.id, nextOpen);
    const countable = n.lines.filter((l: any) => l.kind === 'count' || l.kind === 'batch');
    const counted = countable.filter((l: any) => l.counted !== undefined).length;
    status.push({ stationId: s.id, station: s.name, ...(todayStatus ? { today: todayStatus } : {}), next: { date: nextOpen, counted, toCount: countable.length, approved: n.status === 'approved' } });
    if (!countable.length || n.status === 'approved') continue;
    const countDue = addDays(nextOpen, -1) < today ? today : addDays(nextOpen, -1);
    if (counted < countable.length) {
      const tonight = openToday && nextName === 'tomorrow';
      items.push({ key: `prep:count:${s.id}:${nextOpen}`, group: 'prep', label: tonight ? 'Count tonight' : 'Count', tone: 'due', due: countDue,
        title: `Count ${s.name} for ${nextName === 'tomorrow' && !openToday ? DAYS[weekday(nextOpen)] : nextName}`, detail: counted ? `${counted} of ${countable.length} counted` : `${countable.length} items${tonight ? ', after service' : ''}`, go: { to: 'count', stationId: s.id, date: nextOpen }, button: 'Count' });
    } else if (manager) {
      const toMake = n.lines.filter((l: any) => (l.toMake ?? 0) > 0).length;
      items.push({ key: `prep:review:${s.id}:${nextOpen}`, group: 'prep', label: 'Approve', tone: 'due', due: countDue,
        title: `Approve ${s.name}’s list for ${nextName}`, detail: `Counted${n.countedBy ? ` by ${n.countedBy}` : ''}. ${toMake} item${toMake === 1 ? '' : 's'} to make.`, go: { to: 'review', stationId: s.id, date: nextOpen }, button: 'Review' });
    }
  }
  return { items, status };
}

/**
 * Ingredients whose price moved: the blend over the last 60 days against the 60 days ending
 * 90 days ago, weighed by how much the menu uses (last 90 days of plates). Only moves of 8%
 * or more that change food cost by $5 a week or more.
 */
export function priceMoves(model: Model, today: string) {
  const now = blendedPrices(model.imported.prices, today);
  const before = blendedPrices(model.imported.prices, addDays(today, -90));
  const recent = new Set(model.imported.prices.filter((p) => p.date.slice(0, 10) > addDays(today, -60)).map((p) => p.productExternalId));
  const old = new Set(model.imported.prices.filter((p) => p.date.slice(0, 10) <= addDays(today, -90)).map((p) => p.productExternalId));
  const days = Math.max(1, (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${model.from}T12:00:00Z`)) / 86_400_000 + 1);
  const use = new Map<string, { amount: number; dishes: Map<string, number> }>();
  for (const d of model.margins.dishes) {
    if (!(d.quantity > 0)) continue;
    for (const l of d.cost.lines) {
      const u = use.get(l.productId) ?? { amount: 0, dishes: new Map() };
      u.amount += l.amount * d.quantity;
      u.dishes.set(d.name, (u.dishes.get(d.name) ?? 0) + l.amount);
      use.set(l.productId, u);
    }
  }
  const out = [];
  for (const [productId, u] of use) {
    const a = before.get(productId), b = now.get(productId);
    if (!a || !b || !recent.has(productId) || !old.has(productId)) continue;
    const change = b / a - 1;
    const perWeek = (b - a) * u.amount / days * 7;
    if (Math.abs(change) < 0.08 || Math.abs(perWeek) < 5) continue;
    const [dish, perPlate] = [...u.dishes].sort((x, y) => y[1] - x[1])[0]!;
    out.push({ productId, product: model.book.products.get(productId)?.name ?? productId, change, perWeek, dish, plateChange: (b - a) * perPlate });
  }
  return out.sort((x, y) => Math.abs(y.perWeek) - Math.abs(x.perWeek));
}

async function managerItems(db: Db, who: SignedIn, model: Model, today: string): Promise<TodayItem[]> {
  const items: TodayItem[] = [];

  // Syncs that failed, or haven't run in a while.
  const runs = (await db.query<{ source: string; status: string; finished_at: Date | null; started_at: Date; detail: any }>(
    `SELECT DISTINCT ON (source) source, status, finished_at, started_at, detail FROM sync_runs WHERE restaurant_id = $1 AND status <> 'running' ORDER BY source, started_at DESC`, [who.restaurantId])).rows;
  for (const r of runs) {
    const name = r.source === 'square' ? 'Square' : 'MarginEdge';
    const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
    if (r.status === 'failed') items.push({ key: `sync:${r.source}`, group: 'setup', label: 'Sync', tone: 'alert', title: `${name} didn’t sync`, detail: detail?.error ?? 'The last sync failed.', go: { to: 'settings' }, button: 'Settings' });
    else if (r.finished_at && Date.now() - new Date(r.finished_at).getTime() > 3 * 86_400_000) items.push({ key: `sync:${r.source}:stale`, group: 'setup', label: 'Sync', tone: 'alert', title: `${name} hasn’t synced in ${Math.floor((Date.now() - new Date(r.finished_at).getTime()) / 86_400_000)} days`, go: { to: 'settings' }, button: 'Settings' });
  }

  // Dishes coming to the menu whose preps aren't on the lists yet.
  const plans = (await db.query<{ id: string; name: string; starts_on: string }>(
    "SELECT id, name, starts_on::text AS starts_on FROM menu_plans WHERE restaurant_id = $1 AND status = 'planned' AND starts_on <= $2 ORDER BY starts_on", [who.restaurantId, addDays(today, 21)])).rows;
  for (const p of plans) {
    const due = addDays(p.starts_on, -1) < today ? today : addDays(p.starts_on, -1);
    items.push({ key: `plan:${p.id}`, group: 'menu', label: 'Coming up', tone: 'due', due, title: `${p.name} starts ${DAYS[weekday(p.starts_on)]}, ${shortDate(p.starts_on)}`, detail: 'Its preps aren’t on the station lists yet.', go: { to: 'menu' }, button: 'Plan preps' });
  }

  // Menu questions, the biggest sellers first, answerable here.
  const menu = menuView(model);
  const questions: (Omit<TodayItem, 'group' | 'label' | 'tone' | 'go' | 'button'> & { name: string })[] = [
    ...menu.checks.map((c) => {
      const answers = c.kind === 'dishChanged' && c.item && c.suggestedDate ? [{ label: `New version from ${shortDate(c.suggestedDate)}`, body: { type: 'newDish', ...c.item, from: c.suggestedDate, note: 'new version, card to come' } }, { label: 'Same dish', body: { type: 'dismiss', dedupeKey: c.dedupeKey } }]
        : c.kind === 'newButton' && c.item ? [{ label: 'New dish, card to come', body: { type: 'newDish', ...c.item } }, { label: 'Not food', body: { type: 'notFood', ...c.item } }]
        : [{ label: 'Ignore', body: { type: 'dismiss', dedupeKey: c.dedupeKey } }];
      return { key: `q:${c.dedupeKey}`, name: c.title, title: c.title, dollars: c.netSales, detail: `${dollars(c.netSales)} in sales over 90 days`, answers };
    }),
    ...menu.linkQuestions.map((q) => {
      const sold = q.first ? ` · sold ${shortDate(q.first)} – ${shortDate(q.last!)}` : '';
      return q.candidates.length
        ? { key: `q:link:${q.item.catalogId}:${q.name}`, name: q.name, title: q.candidates.length === 1 || q.type === 'confirm' ? `${q.name}: is it the ${q.candidates[0]} card?` : `${q.name}: which recipe card is it?`, dollars: q.netSales,
            detail: `${dollars(q.netSales)} in sales over 90 days${sold}`,
            answers: [...q.candidates.slice(0, 2).map((c, i) => ({ label: i === 0 && (q.candidates.length === 1 || q.type === 'confirm') ? `Yes, ${c}` : i === 0 ? c : `No, ${c}`, body: { type: 'link', ...q.item, recipe: c } })), { label: 'New dish, card to come', body: { type: 'newDish', ...q.item } }] }
        : { key: `q:link:${q.item.catalogId}:${q.name}`, name: q.name, title: `${q.name} sells but has no recipe card`, dollars: q.netSales,
            detail: `${dollars(q.netSales)} in sales over 90 days${sold}. Mark it and it stops asking; its plate cost comes with the card.`,
            answers: [{ label: 'New dish, card to come', body: { type: 'newDish', ...q.item } }, { label: 'Not food', body: { type: 'notFood', ...q.item } }] };
    }),
  ].sort((a, b) => (b.dollars ?? 0) - (a.dollars ?? 0));
  for (const { name: _, ...q } of questions.slice(0, 3)) items.push({ ...q, group: 'menu', label: 'Question', tone: 'ask', go: { to: 'menu' }, button: 'Menu' });
  if (questions.length > 3) {
    const rest = questions.slice(3);
    items.push({ key: 'q:more', group: 'menu', label: 'Questions', tone: 'ask', dollars: rest[0]!.dollars, title: `${rest.length} more menu question${rest.length === 1 ? '' : 's'}`, detail: list(rest.map((q) => q.name.replace(/[.?]$/, '')), 4), go: { to: 'menu' }, button: 'Menu' });
  }

  // What keeps plate costs incomplete, most plates first.
  const gaps = gapsOf(model, model.margins.dishes);
  for (const g of gaps.slice(0, 2)) {
    items.push({ key: `gap:${g.key}`, group: 'costs', label: 'Plate cost', tone: 'ask',
      title: g.kind === 'price' ? `${g.product}: no price yet` : `${g.product}: how much is one ${g.needed === 'unknownUnit' ? g.to : g.from ?? 'unit'}?`,
      detail: `Leaves ${list(g.dishes, 2)} without a full plate cost (${g.plates.toLocaleString('en-US')} plates)`, go: { to: 'performance' }, button: 'Fill in' });
  }

  // Prices that moved enough to matter.
  for (const m of priceMoves(model, today).slice(0, 3)) {
    const up = m.change > 0;
    items.push({ key: `price:${m.productId}`, group: 'costs', label: up ? 'Price up' : 'Price down', tone: up ? 'alert' : 'info', dollars: Math.abs(m.perWeek) * 13,
      title: `${m.product} is ${up ? 'up' : 'down'} ${Math.round(Math.abs(m.change) * 100)}% in 3 months`,
      detail: `About ${dollars(Math.abs(m.perWeek))} a week ${up ? 'more' : 'less'} at your volume · ${m.dish} ${up ? '+' : '−'}${cents(Math.abs(m.plateChange))} a plate`, go: { to: 'performance' }, button: 'See dishes' });
  }
  return items;
}

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The last service, the week so far, the dishes earning most this week. */
async function glance(db: Db, restaurantId: string, today: string, model: Model, week: Model) {
  const days = (await db.query<{ day: string; net: string; plates: string }>(
    'SELECT day::text AS day, sum(net_sales) AS net, sum(quantity) AS plates FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day <= $2 AND day >= $3 GROUP BY day HAVING sum(net_sales) > 0 ORDER BY day', [restaurantId, today, addDays(today, -42)])).rows
    .map((r) => ({ day: r.day, net: Number(r.net) }));
  const last = days[days.length - 1];
  let lastDay;
  if (last) {
    const same = days.filter((d) => d.day < last.day && weekday(d.day) === weekday(last.day)).slice(-4);
    const usual = same.length >= 2 ? same.reduce((s, d) => s + d.net, 0) / same.length : undefined;
    lastDay = { date: last.day, netSales: Math.round(last.net), ...(usual ? { usual: Math.round(usual) } : {}) };
  }
  // Business weeks run Monday to Sunday: this week so far against the same days last week.
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const sum = (from: string, to: string) => days.filter((d) => d.day >= from && d.day <= to).reduce((s, d) => s + d.net, 0);
  const lastSold = last?.day ?? today;
  const weekToDate = lastSold >= monday ? { from: monday, to: lastSold, netSales: Math.round(sum(monday, lastSold)), lastWeek: Math.round(sum(addDays(monday, -7), addDays(lastSold, -7))) } : undefined;
  const lastWeek = { from: addDays(monday, -7), to: addDays(monday, -1), netSales: Math.round(sum(addDays(monday, -7), addDays(monday, -1))), before: Math.round(sum(addDays(monday, -14), addDays(monday, -8))) };
  return {
    ...(lastDay ? { lastDay } : {}),
    ...(weekToDate ? { weekToDate } : {}),
    lastWeek,
    ...(model.margins.dishes.length ? { foodCost: Math.round(model.margins.totals.foodCostShare * 1000) / 1000 } : {}),
    earners: [...week.margins.dishes].sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 3)
      .map((d) => ({ name: d.name, left: Math.round(d.totalContribution), sold: Math.round(d.quantity) })),
    noCard: model.margins.unlinked.filter((u) => new Set(model.margins.dishes.map((d) => d.category)).has(u.category)).slice(0, 6).map((u) => ({ name: u.name, netSales: Math.round(u.netSales) })),
  };
}

export async function todayView(db: Db, who: SignedIn, today: string, hour: number, onlyStation?: string) {
  const open = await openWeekdays(db, who.restaurantId, today);
  let nextOpen = addDays(today, 1);
  for (let i = 0; i < 7 && !open.has(weekday(nextOpen)); i++) nextOpen = addDays(nextOpen, 1);
  const openToday = open.has(weekday(today));
  let stations = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [who.restaurantId])).rows;
  if (onlyStation && stations.some((s) => s.id === onlyStation)) stations = stations.filter((s) => s.id === onlyStation);
  const prep = await prepItems(db, who, stations, today, hour, openToday, nextOpen);
  const items = [...prep.items];
  let atAGlance;
  if (atLeast(who.roleLevel, 'manager')) {
    const model = await getModel(db, who.restaurantId, today);
    const week = await getModel(db, who.restaurantId, today, { from: addDays(today, -6), to: today });
    items.push(...await managerItems(db, who, model, today));
    atAGlance = await glance(db, who.restaurantId, today, model, week);
  }
  // Deadlines first (prep before counts on the same day), then the money behind the rest.
  const rank = (i: TodayItem) => ({ prep: 0, menu: 1, costs: 2, setup: 3 })[i.group];
  items.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1)
    || (a.due && b.due ? a.due.localeCompare(b.due) : 0)
    || (a.tone === 'alert' && a.group === 'setup' ? -1 : 0) - (b.tone === 'alert' && b.group === 'setup' ? -1 : 0)
    || (b.dollars ?? 0) - (a.dollars ?? 0)
    || rank(a) - rank(b));
  return {
    today, hour, openToday, nextOpen,
    openDays: [...open].sort(),
    items,
    prep: prep.status,
    ...(atAGlance ? { glance: atAGlance } : {}),
  };
}
