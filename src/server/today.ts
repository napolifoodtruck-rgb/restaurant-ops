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
 * each look, so an answered question or a finished list simply drops off. The one thing kept
 * is who snoozed what (POST /api/today/snooze): a snoozed line is set aside for that person
 * until it comes back. Deadlines can't be snoozed past their day, and anything due today
 * always shows.
 */

import type { Db } from './db.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel, loadBook, type Model } from './model.ts';
import { coverageOf, inArea, menuView, posItemOf, type AreaView } from './views.ts';
import { guessArea, loadAreas } from './areas.ts';
import { ordersDue } from './orders.ts';
import { view as stationDay } from './prep.ts';
import { blendedPrices } from '../core/purchasing.ts';
import { notBoughtKey, quietVendorKey, recipeChecks } from './recipeChecks.ts';

export interface TodayItem {
  key: string;
  group: 'prep' | 'orders' | 'menu' | 'costs' | 'setup';
  /** Short label down the left: "Count", "Question", "Price". */
  label: string;
  tone: 'due' | 'ask' | 'alert' | 'info';
  title: string;
  detail?: string;
  /** The day it's needed by; items with a day come first. */
  due?: string;
  /** Money behind it, for ordering the rest. */
  dollars?: number;
  go: { to: 'count' | 'review' | 'work' | 'menu' | 'performance' | 'settings' | 'cards' | 'drafts' | 'order' | 'orders' | 'recipeChecks' | 'scan' | 'invoices' | 'inventory' | 'floor'; listId?: string; stationId?: string; date?: string; vendorId?: string; side?: 'kitchen' | 'bar'; scanId?: string };
  button: string;
  /** The side it's about (a station's side comes from its name: "Bar" is the bar's); none for syncs, which everyone sees. */
  side?: 'kitchen' | 'bar';
  /** A POS button with no recipe yet: any recipe can be picked for it here, besides the likeliest. */
  pick?: { catalogId: string; itemName: string; variationName?: string };
  /** Answers that can be given right here (POST /api/answers), the likeliest first. */
  answers?: { label: string; body: Record<string, unknown> }[];
  /** How long it can be set aside for (POST /api/today/snooze); none when it's due today. */
  snooze?: SnoozeChoice[];
  /** Set aside by this person until then (ISO time). */
  snoozedUntil?: string;
}

export type SnoozeChoice = { label: string; hours: number } | { label: string; day: string };

/** Snoozes end at 6 in the morning, before anyone's in. */
export const SNOOZE_MORNING = '06:00';

/** What a line can be snoozed for: anything that can wait, never past the day it's due. */
export function snoozeChoices(i: Pick<TodayItem, 'due'>, today: string): SnoozeChoice[] {
  const tomorrow = addDays(today, 1);
  if (i.due && i.due <= today) return [];
  if (i.due) {
    const day = DAYS[weekday(i.due)]!;
    return i.due === tomorrow ? [{ label: 'Until tomorrow', day: tomorrow }] : [{ label: 'Until tomorrow', day: tomorrow }, { label: `Until ${day}`, day: i.due }];
  }
  return [{ label: 'For 3 hours', hours: 3 }, { label: 'Until tomorrow', day: tomorrow }, { label: 'For a week', day: addDays(today, 7) }];
}

const clock = (t: string) => { const [hh, mm] = t.split(':').map(Number); return `${((hh! + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${hh! < 12 ? 'am' : 'pm'}`; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SERVICE_HOUR = 17;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const dollars = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
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
  const status: { stationId: string; station: string; side: 'kitchen' | 'bar'; today?: { approved: boolean; left: number; total: number }; next: { date: string; counted: number; toCount: number; approved: boolean } }[] = [];
  const nextName = nextOpen === addDays(today, 1) ? 'tomorrow' : DAYS[weekday(nextOpen)]!;
  for (const s of stations) {
    const side = guessArea(s.name) === 'bar' ? 'bar' as const : 'kitchen' as const;
    const before = items.length;
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
    status.push({ stationId: s.id, station: s.name, side, ...(todayStatus ? { today: todayStatus } : {}), next: { date: nextOpen, counted, toCount: countable.length, approved: n.status === 'approved' } });
    if (!countable.length || n.status === 'approved') { for (const it of items.slice(before)) it.side = side; continue; }
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
    for (const it of items.slice(before)) it.side = side;
  }
  return { items, status };
}

/**
 * Ingredients whose price moved: the blend over the last 60 days against the 60 days ending
 * 90 days ago, weighed by how much the menu uses (last 90 days of plates). Only moves of 8%
 * or more that change food cost by $5 a week or more.
 */
export function priceMoves(model: Model, today: string, include: (category: string) => boolean = () => true) {
  const now = blendedPrices(model.purchasing.prices, today);
  const before = blendedPrices(model.purchasing.prices, addDays(today, -90));
  const recent = new Set(model.purchasing.prices.filter((p) => p.date.slice(0, 10) > addDays(today, -60)).map((p) => p.productExternalId));
  const old = new Set(model.purchasing.prices.filter((p) => p.date.slice(0, 10) <= addDays(today, -90)).map((p) => p.productExternalId));
  const days = Math.max(1, (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${model.from}T12:00:00Z`)) / 86_400_000 + 1);
  const use = new Map<string, { amount: number; dishes: Map<string, number> }>();
  for (const d of model.margins.dishes) {
    if (!(d.quantity > 0) || !include(d.category)) continue;
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

async function managerItems(db: Db, who: SignedIn, model: Model, today: string, areaOf: AreaView['areaOf']): Promise<TodayItem[]> {
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

  // Notes left on a Service board at the end of the night (feedback, something broken, what ran low):
  // first on the list until a manager marks each one seen.
  const seen = new Set(((await loadBook(db, who.restaurantId)).linkAnswers?.dismissed ?? []).map((d) => d.dedupeKey));
  const notes = (await db.query<{ id: string; day: string; body: string; by: string | null; post: string | null }>(
    `SELECT h.id::text AS id, h.day::text AS day, h.body, s.display_name AS by, p.name AS post FROM floor_handoffs h LEFT JOIN staff s ON s.id = h.written_by LEFT JOIN floor_posts p ON p.id = h.post_id
       WHERE h.restaurant_id = $1 AND h.day >= $2 ORDER BY h.written_at`, [who.restaurantId, addDays(today, -3)])).rows;
  for (const n of notes.filter((x) => !seen.has(handoffKey(x.id)))) {
    const when = n.day === addDays(today, -1) ? 'last night' : n.day === today ? 'today' : DAYS[weekday(n.day)]!;
    items.push({ key: `handoff:${n.id}`, group: 'setup', label: 'From the floor', tone: 'ask', dollars: 2_000_000,
      title: n.body.length > 400 ? `${n.body.slice(0, 398).trim()}…` : n.body,
      detail: `${n.by ?? 'Someone'}${n.post ? ` at ${n.post}` : ''}, ${when}`,
      answers: [{ label: 'Seen', body: { type: 'dismiss', dedupeKey: handoffKey(n.id), note: `Seen: ${n.body.slice(0, 60)}` } }],
      go: { to: 'floor' }, button: 'Service' });
  }

  // Dishes coming to the menu whose preps aren't on the lists yet.
  const plans = (await db.query<{ id: string; name: string; starts_on: string; section: string | null }>(
    "SELECT id, name, section, starts_on::text AS starts_on FROM menu_plans WHERE restaurant_id = $1 AND status = 'planned' AND starts_on <= $2 ORDER BY starts_on", [who.restaurantId, addDays(today, 21)])).rows;
  for (const p of plans) {
    const due = addDays(p.starts_on, -1) < today ? today : addDays(p.starts_on, -1);
    items.push({ key: `plan:${p.id}`, side: areaOf(p.section ?? undefined) === 'bar' ? 'bar' : 'kitchen', group: 'menu', label: 'Coming up', tone: 'due', due, title: `${p.name} starts ${DAYS[weekday(p.starts_on)]}, ${shortDate(p.starts_on)}`, detail: 'Its preps aren’t on the station lists yet.', go: { to: 'menu' }, button: 'Plan preps' });
  }

  // Questions, plate-cost gaps and price moves, side by side: kitchen and bar people each see theirs.
  const dismissed = ((await loadBook(db, who.restaurantId)).linkAnswers?.dismissed ?? []).map((d) => d.dedupeKey);
  for (const side of ['kitchen', 'bar'] as const) {
    const view: AreaView = { area: side, areaOf };
    // Menu questions, the biggest sellers first, answerable here.
    const menu = menuView(model, view);
    const before = items.length;
    const questions: (Omit<TodayItem, 'group' | 'label' | 'tone' | 'go' | 'button'> & { name: string })[] = [
      // Quiet dishes are asked about on the Menu page, where the menu is kept.
      ...menu.checks.filter((c) => c.kind !== 'notSelling').map((c) => {
        const answers = c.kind === 'dishChanged' && c.item && c.suggestedDate ? [{ label: `New version from ${shortDate(c.suggestedDate)}`, body: { type: 'newDish', ...c.item, from: c.suggestedDate, note: 'new version, recipe to come' } }, { label: 'Same dish', body: { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title } }]
          : c.kind === 'newButton' && side === 'bar' ? [{ label: 'Got it', body: { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title } }]
          : c.kind === 'newButton' && c.item ? [{ label: 'New dish, recipe to come', body: { type: 'newDish', ...c.item } }, { label: 'Not food', body: { type: 'notFood', ...c.item } }]
          : [{ label: 'Ignore', body: { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title } }];
        return { key: `q:${c.dedupeKey}`, name: c.title, title: c.title, dollars: c.netSales, detail: `${dollars(c.netSales)} in sales over 90 days`, answers, ...(c.kind === 'newButton' && c.item && side === 'kitchen' ? { pick: c.item } : {}) };
      }),
      ...menu.linkQuestions.map((q) => {
        const sold = q.first ? ` · sold ${shortDate(q.first)} – ${shortDate(q.last!)}` : '';
        // Only prep recipes match: say so, and put "its own recipe" first, since a prep is rarely sold as is.
        // Best matched by a prep recipe (Corn Panna the pizza, Corn Panna the sauce): say so, and put "its own recipe" first.
        const dishes = q.candidates.filter((_c, i) => q.candidateKinds[i] !== 'prep');
        if (q.candidates.length > 0 && q.candidateKinds[0] === 'prep') {
          return { pick: q.item, key: `q:link:${q.item.catalogId}:${q.name}`, name: q.name, title: `${q.name} best matches the ${q.candidates[0]} prep recipe`, dollars: q.netSales,
            detail: `${dollars(q.netSales)} in sales over 90 days${sold}. A prep recipe is a batch (a sauce, a dough), not what's sold, so this usually needs its own recipe.`,
            answers: [{ label: 'Needs its own recipe', body: { type: 'newDish', ...q.item } }, ...dishes.slice(0, 1).map((c) => ({ label: `It's ${c}`, body: { type: 'link', ...q.item, recipe: c } })), { label: `Sold as is: ${q.candidates[0]}`, body: { type: 'link', ...q.item, recipe: q.candidates[0] } }] };
        }
        return dishes.length
          ? { pick: q.item, key: `q:link:${q.item.catalogId}:${q.name}`, name: q.name, title: dishes.length === 1 || q.type === 'confirm' ? `${q.name}: is it the ${dishes[0]} recipe?` : `${q.name}: which recipe is it?`, dollars: q.netSales,
              detail: `${dollars(q.netSales)} in sales over 90 days${sold}`,
              answers: [...dishes.slice(0, 2).map((c, i) => ({ label: i === 0 && (dishes.length === 1 || q.type === 'confirm') ? `Yes, ${c}` : i === 0 ? c : `No, ${c}`, body: { type: 'link', ...q.item, recipe: c } })), { label: 'New dish, recipe to come', body: { type: 'newDish', ...q.item } }] }
          : { pick: q.item, key: `q:link:${q.item.catalogId}:${q.name}`, name: q.name, title: `${q.name} sells but has no recipe`, dollars: q.netSales,
              detail: `${dollars(q.netSales)} in sales over 90 days${sold}. Mark it and it stops asking; its plate cost comes with the recipe.`,
              answers: [{ label: 'New dish, recipe to come', body: { type: 'newDish', ...q.item } }, { label: 'Not food', body: { type: 'notFood', ...q.item } }] };
      }),
    ].sort((a, b) => (b.dollars ?? 0) - (a.dollars ?? 0));
    for (const { name: _, ...q } of questions.slice(0, 3)) items.push({ ...q, group: 'menu', label: 'Question', tone: 'ask', go: { to: 'menu' }, button: 'Menu' });
    if (questions.length > 3) {
      const rest = questions.slice(3);
      items.push({ key: `q:more:${side}`, group: 'menu', label: 'Questions', tone: 'ask', dollars: rest[0]!.dollars, title: `${rest.length} more ${side} question${rest.length === 1 ? '' : 's'}`, detail: list(rest.map((q) => q.name.replace(/[.?]$/, '')), 4), go: { to: 'menu' }, button: 'Menu' });
    }

    // Prices that moved enough to matter are on the dashboard (GET /api/today/dashboard), not here.
    // Recipe checks: a product the menu uses every week that hasn't come in on an invoice in far too
    // long (the recipe probably names one you stopped buying), and what you buy weekly that no recipe uses.
    const checks = recipeChecks(model, today, dismissed);
    const stale = checks.notBought.filter((x) => x.side === side);
    const shown = stale.length <= 3 ? stale.length : 2;
    for (const x of stale.slice(0, shown)) {
      const amount = x.perWeek >= 10 ? Math.round(x.perWeek) : Math.round(x.perWeek * 10) / 10;
      items.push({ key: `recipe:notBought:${x.productId}`, group: 'costs', label: 'Recipe check', tone: 'ask', dollars: (x.dollarsPerWeek ?? 0) * 13,
        title: x.last ? `${x.name} hasn’t been on an invoice since ${shortDate(x.last.date)}` : `${x.name} isn’t on any invoice`,
        detail: `The menu uses about ${amount} ${x.unit} a week (${list(x.dishes, 2)}). ${x.likely ? `You’ve been buying ${x.likely.name}${x.likely.vendor ? ` from ${x.likely.vendor}` : ''}: is that what the recipe${x.recipes.length === 1 ? '' : 's'} should say?` : 'The recipe may name a product you no longer buy.'}`,
        answers: [{ label: 'It’s right as is', body: { type: 'dismiss', dedupeKey: notBoughtKey(x.productId), note: `${x.name}: right as is, though not bought lately` } }],
        go: { to: 'recipeChecks', side }, button: 'Recipe checks' });
    }
    if (stale.length > shown) items.push({ key: `recipe:notBought:more:${side}`, group: 'costs', label: 'Recipe checks', tone: 'ask', dollars: stale.slice(shown).reduce((a, x) => a + (x.dollarsPerWeek ?? 0) * 13, 0), title: `${stale.length - shown} more ingredients the menu uses but you haven’t bought lately`, detail: list(stale.slice(shown).map((x) => x.name), 4), go: { to: 'recipeChecks', side }, button: 'Recipe checks' });
    // A vendor gone quiet: their invoices may not be reaching MarginEdge, so food cost reads low.
    for (const v of checks.quietVendors.filter((x) => x.side === side)) {
      items.push({ key: `vendor:quiet:${v.vendorId}`, group: 'costs', label: 'Invoices', tone: 'alert', dollars: 10_000,
        title: `No ${v.vendor} invoice since ${shortDate(v.lastDate)}`,
        detail: `They usually come every ${v.usualGap} day${v.usualGap === 1 ? '' : 's'} (${v.invoices} in the 6 months before). If deliveries are still coming, their invoices aren’t reaching MarginEdge, and food cost reads low until they do.`,
        answers: [{ label: 'We stopped buying from them', body: { type: 'dismiss', dedupeKey: quietVendorKey(v.vendorId, v.lastDate), note: `${v.vendor}: stopped buying from them` } }],
        go: { to: 'recipeChecks', side }, button: 'Recipe checks' });
    }
    // The bar's wines and spirits aren't in recipes until the drinks are drafted: that's asked about already.
    const unused = checks.notInRecipes.filter((x) => x.side === side);
    const barUndrafted = side === 'bar' && model.margins.unlinked.some((u) => u.catalogId && u.netSales > 0 && areaOf(u.category) === 'bar');
    if (unused.length && !barUndrafted) {
      items.push({ key: `recipe:notInRecipes:${side}`, group: 'costs', label: 'Recipe checks', tone: 'ask', dollars: unused.reduce((a, x) => a + x.dollars, 0) * 1.5,
        title: `${unused.length} thing${unused.length === 1 ? ' you buy regularly isn’t' : 's you buy regularly aren’t'} in any recipe`,
        detail: `${list(unused.map((x) => x.name), 3)}. A recipe may be missing ${unused.length === 1 ? 'it' : 'them'}.`, go: { to: 'recipeChecks', side }, button: 'Recipe checks' });
    }
    // Drinks with no card: one item for the lot, since most are drafted in a few taps.
    if (side === 'bar') {
      const missing = model.margins.unlinked.filter((u) => u.catalogId && u.netSales > 0 && areaOf(u.category) === 'bar');
      // Counted by drink, not by button: half-price Wednesday is the same glass.
      const posItem = posItemOf(model);
      const drinks = [...new Set(missing.map((u) => posItem(u.catalogId, u.name).itemName))];
      if (drinks.length) {
        const total = missing.reduce((s, u) => s + u.netSales, 0);
        items.push({ key: 'bar:nocard', group: 'menu', label: 'Recipes', tone: 'ask', dollars: total, title: `${drinks.length} drink${drinks.length === 1 ? ' has' : 's have'} no recipe`,
          detail: `${dollars(total)} in sales over 90 days with no cost behind it: ${list(drinks, 3)}`, go: { to: 'drafts' }, button: 'Draft recipes' });
      }
    }
    for (const it of items.slice(before)) it.side = side;
  }
  return items;
}

/** A board note marked seen on Today. */
export const handoffKey = (id: string) => `handoff:${id}`;

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The last service, the week so far, what's earning or selling most this week: for one side, or both. */
function glance(days: { day: string; category: string; net: number }[], today: string, model: Model, week: Model, view: AreaView) {
  const byDay = new Map<string, number>();
  for (const d of days) if (inArea(view, d.category)) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.net);
  const series = [...byDay].filter(([, net]) => net > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([day, net]) => ({ day, net }));
  const last = series[series.length - 1];
  let lastDay;
  if (last) {
    const same = series.filter((d) => d.day < last.day && weekday(d.day) === weekday(last.day)).slice(-4);
    const usual = same.length >= 2 ? same.reduce((s, d) => s + d.net, 0) / same.length : undefined;
    lastDay = { date: last.day, netSales: Math.round(last.net), ...(usual ? { usual: Math.round(usual) } : {}) };
  }
  // Business weeks run Monday to Sunday: this week so far against the same days last week.
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const sum = (from: string, to: string) => series.filter((d) => d.day >= from && d.day <= to).reduce((s, d) => s + d.net, 0);
  const lastSold = last?.day ?? today;
  const weekToDate = lastSold >= monday ? { from: monday, to: lastSold, netSales: Math.round(sum(monday, lastSold)), lastWeek: Math.round(sum(addDays(monday, -7), addDays(lastSold, -7))) } : undefined;
  const lastWeek = { from: addDays(monday, -7), to: addDays(monday, -1), netSales: Math.round(sum(addDays(monday, -7), addDays(monday, -1))), before: Math.round(sum(addDays(monday, -14), addDays(monday, -8))) };
  const dishes = model.margins.dishes.filter((d) => inArea(view, d.category));
  const net = dishes.reduce((s, d) => s + d.netSales, 0), food = dishes.reduce((s, d) => s + d.plateCost * d.quantity, 0);
  // Items with no costs yet (drinks) are ranked by sales instead.
  const selling = new Map<string, { name: string; sold: number; netSales: number }>();
  for (const l of week.sales) {
    if (!inArea(view, l.category) || (l.date && week.lookup(l.catalogId, l.name, l.date))) continue;
    const it = selling.get(l.name) ?? { name: l.name, sold: 0, netSales: 0 };
    it.sold += l.quantity; it.netSales += l.netSales;
    selling.set(l.name, it);
  }
  return {
    coverage: coverageOf(model, view),
    ...(lastDay ? { lastDay } : {}),
    ...(weekToDate ? { weekToDate } : {}),
    lastWeek,
    ...(net > 0 ? { foodCost: Math.round((food / net) * 1000) / 1000 } : {}),
    earners: week.margins.dishes.filter((d) => inArea(view, d.category)).sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 3)
      .map((d) => ({ name: d.name, left: Math.round(d.totalContribution), sold: Math.round(d.quantity) })),
    ...(view.area === 'bar' ? { sellers: [...selling.values()].sort((a, b) => b.netSales - a.netSales).slice(0, 3).map((i) => ({ name: i.name, sold: Math.round(i.sold), netSales: Math.round(i.netSales) })) } : {}),
    noCard: view.area === 'bar' ? [] : model.margins.unlinked.filter((u) => view.areaOf(u.category) === 'kitchen' && new Set(model.margins.dishes.map((d) => d.category)).has(u.category)).slice(0, 6).map((u) => ({ name: u.name, netSales: Math.round(u.netSales) })),
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
  // Count day (Saturday unless set otherwise): each list not counted yet, for whoever counts it.
  if (atLeast(who.roleLevel, 'chef')) {
    const countDay = Number((await db.query<{ d: string | null }>("SELECT settings->>'countDay' AS d FROM restaurants WHERE id = $1", [who.restaurantId])).rows[0]?.d ?? 6);
    if (new Date(`${today}T12:00:00Z`).getUTCDay() === countDay) {
      const lists = (await db.query<{ id: string; name: string; counted_by: string; started: boolean; finished: boolean }>(
        `SELECT a.id, a.name, a.counted_by, c.id IS NOT NULL AS started, c.finished_at IS NOT NULL AS finished FROM storage_areas a
           LEFT JOIN inventory_counts c ON c.area_id = a.id AND c.day = $2 WHERE a.restaurant_id = $1 AND a.active ORDER BY a.sort_order`, [who.restaurantId, today])).rows;
      const who_ = { kitchen: 'the chef', bar: 'the bar manager', foh: 'the FOH manager' } as Record<string, string>;
      for (const l of lists.filter((x) => !x.finished)) {
        items.push({ key: `inventory:${l.id}:${today}`, group: 'prep', label: 'Inventory', tone: 'due', due: today, dollars: 500_000, side: l.counted_by === 'bar' ? 'bar' : 'kitchen',
          title: `Count ${l.name}`, detail: `${l.started ? 'Started; pick up where it left off' : 'This afternoon'} · counted by ${who_[l.counted_by] ?? 'a manager'}`, go: { to: 'inventory', listId: l.id }, button: l.started ? 'Keep counting' : 'Count' });
      }
    }
  }
  let atAGlance;
  if (atLeast(who.roleLevel, 'manager')) {
    const model = await getModel(db, who.restaurantId, today);
    const week = await getModel(db, who.restaurantId, today, { from: addDays(today, -6), to: today });
    const areaOf = await loadAreas(db, who.restaurantId);
    items.push(...await managerItems(db, who, model, today, areaOf));
    // Invoice photos read and waiting for a check (or that couldn't be read): first thing, since
    // nothing on them is priced until someone looks.
    const scans = (await db.query<{ id: string; status: string; vendor: string | null; lines: string | null; created_at: string }>(
      "SELECT id, status, result->>'vendor' AS vendor, jsonb_array_length(coalesce(result->'lines', '[]'::jsonb))::text AS lines, created_at::text AS created_at FROM invoice_scans WHERE restaurant_id = $1 AND status IN ('read', 'failed') AND created_at > now() - interval '30 days' ORDER BY created_at", [who.restaurantId])).rows;
    for (const x of scans) {
      const when = new Date(x.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
      items.push(x.status === 'read'
        ? { key: `scan:${x.id}`, group: 'setup', label: 'Invoice', tone: 'alert', due: today, dollars: 1_000_000, title: `Invoice${x.vendor ? ` from ${x.vendor}` : ''} ready to check`, detail: `Photographed ${when} · ${x.lines ?? 0} lines. Nothing on it is priced until it’s checked.`, go: { to: 'scan', scanId: x.id }, button: 'Check it' }
        : { key: `scan:${x.id}`, group: 'setup', label: 'Invoice', tone: 'alert', due: today, dollars: 1_000_000, title: 'An invoice photo couldn’t be read', detail: `Photographed ${when}. Retake it, try again, or type it in.`, go: { to: 'scan', scanId: x.id }, button: 'Open it' });
    }
    // Orders due soon that no manager has approved yet: one item per vendor with a cutoff set,
    // one item for the vendors delivering soon whose cutoff nobody has set yet.
    const dueSoon = await ordersDue(db, who, today);
    for (const v of dueSoon.filter((x) => x.deadline)) {
      const when = `due ${v.deadline!.date === today ? 'today' : DAYS[weekday(v.deadline!.date)]} by ${clock(v.deadline!.time)}`;
      items.push({ key: `order:${v.vendorId}:${v.next}`, side: v.side, group: 'orders', label: 'Order', tone: 'due', due: v.deadline!.date, dollars: v.spendPerWeek,
        title: `${v.name}: order for ${DAYS[weekday(v.next!)]}’s delivery`, detail: `${v.draft ? 'Draft started · ' : ''}${when}`, go: { to: 'order', vendorId: v.vendorId }, button: v.draft ? 'Review' : 'Start order' });
    }
    for (const side of ['kitchen', 'bar'] as const) {
      const unset = dueSoon.filter((x) => !x.deadline && x.side === side && x.next! <= addDays(today, 2));
      if (!unset.length) continue;
      items.push({ key: `orders:unset:${side}`, side, group: 'orders', label: 'Orders', tone: 'due', due: addDays(unset.map((x) => x.next!).sort()[0]!, -1) < today ? today : addDays(unset.map((x) => x.next!).sort()[0]!, -1), dollars: unset.reduce((a, x) => a + x.spendPerWeek, 0),
        title: `${unset.length} ${side} vendor${unset.length === 1 ? ' delivers' : 's deliver'} in the next two days`, detail: `${list(unset.map((x) => `${x.name} (${DAYS[weekday(x.next!)]!.slice(0, 3)})`), 3)}. Set when each order is due and they’ll each get a reminder.`, go: { to: 'orders', side }, button: 'Orders' });
    }
    const days = (await db.query<{ day: string; category: string; net: string }>(
      'SELECT day::text AS day, category, sum(net_sales) AS net FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day <= $2 AND day >= $3 GROUP BY day, category', [who.restaurantId, today, addDays(today, -42)])).rows
      .map((r) => ({ day: r.day, category: r.category, net: Number(r.net) }));
    atAGlance = Object.fromEntries((['all', 'kitchen', 'bar'] as const).map((area) => [area, glance(days, today, model, week, { area, areaOf })]));
  }
  // Deadlines first (prep before counts on the same day), then the money behind the rest.
  const rank = (i: TodayItem) => ({ prep: 0, orders: 1, menu: 2, costs: 3, setup: 4 })[i.group];
  items.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1)
    || (a.due && b.due ? a.due.localeCompare(b.due) : 0)
    || (a.tone === 'alert' && a.group === 'setup' ? -1 : 0) - (b.tone === 'alert' && b.group === 'setup' ? -1 : 0)
    || (b.dollars ?? 0) - (a.dollars ?? 0)
    || rank(a) - rank(b));
  // Snoozed by this person and not back yet; anything due today shows regardless.
  const snoozed = new Map((await db.query<{ item_key: string; until: Date }>(
    'SELECT item_key, until FROM today_snoozes WHERE restaurant_id = $1 AND staff_id = $2 AND until > now()', [who.restaurantId, who.staffId])).rows.map((r) => [r.item_key, new Date(r.until).toISOString()]));
  for (const i of items) {
    const choices = snoozeChoices(i, today);
    if (choices.length) i.snooze = choices;
    const until = snoozed.get(i.key);
    if (until && choices.length) i.snoozedUntil = until;
  }
  return {
    today, hour, openToday, nextOpen,
    // Where this person's Today opens: their side, or both.
    side: who.area === 'both' ? 'all' : who.area,
    openDays: [...open].sort(),
    items,
    prep: prep.status,
    ...(atAGlance ? { glance: atAGlance } : {}),
  };
}
