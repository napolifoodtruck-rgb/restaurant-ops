/**
 * The menu: which dishes are on, which recipe version each uses, and from when to when.
 *
 * The app's menu is the source of truth for the food. Square stays read-only and supplies
 * buttons, prices and sales. Rather than asking anyone to keep the menu up to date by hand,
 * the app compares the three and turns every disagreement into a to-do item:
 *  - a new Square button started selling: add it to the menu?
 *  - a dish on the menu hasn't sold in days: still on?
 *  - a dish sold but isn't on the menu: put it back, or was it a special?
 *  - a dish's own modifier buttons changed ("No Pistachio" stopped, "No Tomato Jam" started):
 *    did the dish change? (a seasonal version switch)
 *
 * Seasonal versions are separate entries, and separate recipes, on the same Square button.
 * They never overlap, so each is costed with its own recipe and they compare fairly.
 */

import { addDays } from './forecast.ts';
import { confirmLink, markNewDish, type LinkState, type PosMenuItem } from './menuLinks.ts';
import { modifierKey, readModifier } from './modifiers.ts';
import type { LinkLookup, SaleLine, SellingSpan } from './sales.ts';

export interface MenuEntry {
  id: string;
  menuId: string;
  /** Undefined while the dish's card isn't in yet. */
  recipeId?: string;
  name: string;
  section?: string;
  /** First and last day on the menu (YYYY-MM-DD). No end: still on. */
  startsOn: string;
  endsOn?: string;
  /** Set by a manager, or taken from the first and last day it sold. */
  datesFrom: 'manager' | 'sales';
}

export class MenuError extends Error {}

const isOn = (e: MenuEntry, date: string) => e.startsOn <= date && (e.endsOn === undefined || e.endsOn >= date);

/** The menu on a day, optionally one menu (dinner, brunch, bar). */
export function onMenu(entries: readonly MenuEntry[], date: string, menuId?: string): MenuEntry[] {
  return entries.filter((e) => isOn(e, date) && (menuId === undefined || e.menuId === menuId));
}

let counter = 0;
const newId = () => `entry-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Puts a dish on a menu. The same recipe can't be on the same menu twice at once. */
export function addToMenu(entries: readonly MenuEntry[], entry: Omit<MenuEntry, 'id' | 'datesFrom'> & { id?: string; datesFrom?: MenuEntry['datesFrom'] }): MenuEntry[] {
  const added: MenuEntry = { datesFrom: 'manager', ...entry, id: entry.id ?? newId() };
  if (added.endsOn !== undefined && added.endsOn < added.startsOn) throw new MenuError(`${added.name} would end before it starts.`);
  if (added.recipeId !== undefined) {
    const clash = entries.find((e) => e.menuId === added.menuId && e.recipeId === added.recipeId && overlaps(e, added));
    if (clash) throw new MenuError(`${added.name} is already on this menu from ${clash.startsOn}.`);
  }
  return [...entries, added];
}

function overlaps(a: MenuEntry, b: MenuEntry): boolean {
  const aEnd = a.endsOn ?? '9999-12-31';
  const bEnd = b.endsOn ?? '9999-12-31';
  return a.startsOn <= bEnd && b.startsOn <= aEnd;
}

/** Takes a dish off: `lastDay` is the last day it was served. */
export function takeOffMenu(entries: readonly MenuEntry[], entryId: string, lastDay: string): MenuEntry[] {
  return entries.map((e) => {
    if (e.id !== entryId) return e;
    if (lastDay < e.startsOn) throw new MenuError(`${e.name} can't come off before it went on (${e.startsOn}).`);
    return { ...e, endsOn: lastDay };
  });
}

export interface SeasonalSwitch {
  menuId: string;
  /** The Square button both versions sell under. */
  button: PosMenuItem;
  /** The version coming off. */
  fromEntryId: string;
  /** The version going on; undefined while its card isn't in yet. */
  toRecipeId?: string;
  toName: string;
  /** First day of the new version. */
  firstDay: string;
}

/**
 * Switches a seasonal dish to its next version in one step: the old version ends the day
 * before, the new one starts, and the Square button's sales from that day are costed with
 * the new recipe (or wait for its card).
 */
export function switchVersion(entries: readonly MenuEntry[], links: LinkState, sw: SeasonalSwitch): { entries: MenuEntry[]; links: LinkState } {
  const old = entries.find((e) => e.id === sw.fromEntryId);
  if (!old) throw new MenuError('The version coming off is not on the menu.');
  if (sw.firstDay <= old.startsOn) throw new MenuError(`The new version has to start after ${old.startsOn}.`);
  let next = takeOffMenu(entries, old.id, addDays(sw.firstDay, -1));
  next = addToMenu(next, { menuId: sw.menuId, name: sw.toName, startsOn: sw.firstDay, ...(old.section ? { section: old.section } : {}), ...(sw.toRecipeId ? { recipeId: sw.toRecipeId } : {}) });
  const nextLinks = sw.toRecipeId ? confirmLink(links, sw.button, sw.toRecipeId, undefined, sw.firstDay) : markNewDish(links, sw.button, sw.firstDay);
  return { entries: next, links: nextLinks };
}

/**
 * Proposes menu entries from what sold: each linked dish from its first to its last day
 * sold. A dish still selling within `stillOnDays` of today has no end date.
 */
export function entriesFromSales(spans: readonly SellingSpan[], lookup: LinkLookup, recipeName: (id: string) => string, menuId: string, today: string, options: { stillOnDays?: number } = {}): MenuEntry[] {
  const stillOn = addDays(today, -(options.stillOnDays ?? 7));
  const byRecipe = new Map<string, { first: string; last: string; name: string }>();
  for (const span of spans) {
    const link = lookup(span.catalogId, span.name, span.last);
    if (!link) continue;
    // A portion of a prep sold on its own (a side of sauce) goes on the menu by its button's name.
    const name = link.portion ? span.name : recipeName(link.recipeId);
    const r = byRecipe.get(link.recipeId);
    byRecipe.set(link.recipeId, r ? { name: r.name, first: r.first < span.first ? r.first : span.first, last: r.last > span.last ? r.last : span.last } : { name, first: span.first, last: span.last });
  }
  return [...byRecipe].map(([recipeId, { first, last, name }]) => ({
    id: newId(),
    menuId,
    recipeId,
    name,
    startsOn: first,
    ...(last < stillOn ? { endsOn: last } : {}),
    datesFrom: 'sales' as const,
  }));
}

// ---------------------------------------------------------------- mismatch checks

export interface DatedModifierLine {
  catalogId: string;
  modifierName: string;
  listName?: string;
  date: string;
  quantity: number;
}

export interface MenuCheck {
  kind: 'newButton' | 'soldOffMenu' | 'notSelling' | 'dishChanged';
  title: string;
  /** One open to-do per problem. */
  dedupeKey: string;
  catalogId?: string;
  recipeId?: string;
  entryId?: string;
  /** Sales behind it, for ranking. */
  netSales: number;
  /** For a dish change: the likely first day of the new version. */
  suggestedDate?: string;
}

export interface MenuCheckInput {
  entries: readonly MenuEntry[];
  /** Daily sales lines (with dates), covering at least the last `quietDays`. */
  sales: readonly SaleLine[];
  modifiers?: readonly DatedModifierLine[];
  lookup: LinkLookup;
  recipeName: (id: string) => string;
  today: string;
  /** A dish on the menu with no sales this many days running is questioned. Default 10. */
  quietDays?: number;
  /** A button first sold this recently is new. Default 14. */
  newDays?: number;
}

export function menuChecks(input: MenuCheckInput): MenuCheck[] {
  const quietDays = input.quietDays ?? 10;
  const newDays = input.newDays ?? 14;
  const quietFrom = addDays(input.today, -(quietDays - 1));
  const newFrom = addDays(input.today, -(newDays - 1));
  const checks: MenuCheck[] = [];
  const dated = input.sales.filter((l) => l.date && l.quantity > 0);

  // New buttons, and dishes sold while off the menu.
  const firstSold = new Map<string, string>();
  for (const l of dated) {
    const key = `${l.catalogId}|${l.name}`;
    if (!firstSold.has(key) || l.date! < firstSold.get(key)!) firstSold.set(key, l.date!);
  }
  const newButtons = new Map<string, MenuCheck>();
  const offMenu = new Map<string, MenuCheck & { quantity: number; since: string }>();
  for (const l of dated) {
    if (l.date! < newFrom || !l.catalogId) continue;
    const recipeId = input.lookup(l.catalogId, l.name, l.date)?.recipeId;
    const key = `${l.catalogId}|${l.name}`;
    if (!recipeId) {
      if (firstSold.get(key)! < newFrom || l.netSales <= 0) continue;
      const c = newButtons.get(key) ?? { kind: 'newButton', title: '', dedupeKey: `menu:new:${key}`, catalogId: l.catalogId, netSales: 0 };
      c.netSales += l.netSales;
      c.title = `"${l.name}" started selling on ${firstSold.get(key)}. Add it to the menu?`;
      newButtons.set(key, c);
      continue;
    }
    if (input.entries.some((e) => e.recipeId === recipeId && isOn(e, l.date!))) continue;
    const c = offMenu.get(recipeId) ?? { kind: 'soldOffMenu', title: '', dedupeKey: `menu:off:${recipeId}`, recipeId, catalogId: l.catalogId, netSales: 0, quantity: 0, since: l.date! };
    c.netSales += l.netSales;
    c.quantity += l.quantity;
    if (l.date! < c.since) c.since = l.date!;
    offMenu.set(recipeId, c);
  }
  checks.push(...newButtons.values());
  for (const c of offMenu.values()) {
    const { quantity, since, ...check } = c;
    checks.push({ ...check, title: `${input.recipeName(c.recipeId!)} sold ${quantity} times since ${since} but isn't on the menu. Put it on, or was it a special?` });
  }

  // On the menu, not selling.
  const openDays = new Set(dated.filter((l) => l.date! >= quietFrom).map((l) => l.date!));
  if (openDays.size > 0) {
    const lastSold = new Map<string, string>();
    for (const l of dated) {
      const recipeId = input.lookup(l.catalogId, l.name, l.date)?.recipeId;
      if (recipeId && (!lastSold.has(recipeId) || l.date! > lastSold.get(recipeId)!)) lastSold.set(recipeId, l.date!);
    }
    for (const e of onMenu(input.entries, input.today)) {
      if (!e.recipeId || e.startsOn > quietFrom) continue;
      const last = lastSold.get(e.recipeId);
      if (last && last >= quietFrom) continue;
      checks.push({
        kind: 'notSelling',
        title: `${e.name} is on the menu but ${last ? `hasn't sold since ${last}` : `hasn't sold in ${quietDays} days`}. Still on?`,
        dedupeKey: `menu:quiet:${e.id}`,
        recipeId: e.recipeId,
        entryId: e.id,
        netSales: 0,
      });
    }
  }

  // A dish's own modifier buttons changed.
  if (input.modifiers?.length) checks.push(...dishChanges(input.modifiers, dated, input.today));

  const order: Record<MenuCheck['kind'], number> = { dishChanged: 0, soldOffMenu: 1, newButton: 2, notSelling: 3 };
  return checks.sort((a, b) => order[a.kind] - order[b.kind] || b.netSales - a.netSales);
}

/**
 * Spots a dish changing from its own modifier buttons: buttons used on only this item
 * ("No Pistachio" on the ricotta app) that stop, while new ones start shortly after.
 * Shared lists (toppings for every pizza) say nothing about one dish and are left out.
 */
function dishChanges(modifiers: readonly DatedModifierLine[], sales: readonly SaleLine[], today: string): MenuCheck[] {
  const itemsUsing = new Map<string, Set<string>>();
  for (const m of modifiers) {
    const key = modifierKey({ name: m.modifierName, ...(m.listName ? { listName: m.listName } : {}) });
    itemsUsing.set(key, (itemsUsing.get(key) ?? new Set()).add(m.catalogId));
  }
  interface Use { name: string; listName?: string; first: string; last: string; uses: number; days: { date: string; quantity: number }[] }
  const perItem = new Map<string, Map<string, Use>>();
  for (const m of modifiers) {
    const key = modifierKey({ name: m.modifierName, ...(m.listName ? { listName: m.listName } : {}) });
    if (itemsUsing.get(key)!.size > 1 || !(m.quantity > 0)) continue;
    const uses = perItem.get(m.catalogId) ?? new Map<string, Use>();
    const u = uses.get(key) ?? { name: m.modifierName, ...(m.listName ? { listName: m.listName } : {}), first: m.date, last: m.date, uses: 0, days: [] };
    if (m.date < u.first) u.first = m.date;
    if (m.date > u.last) u.last = m.date;
    u.uses += m.quantity;
    u.days.push({ date: m.date, quantity: m.quantity });
    uses.set(key, u);
    perItem.set(m.catalogId, uses);
  }

  const checks: MenuCheck[] = [];
  for (const [catalogId, uses] of perItem) {
    const list = [...uses.values()];
    let best: { stopped: Use; started: Use; score: number } | undefined;
    for (const a of list) {
      if (a.uses < 3 || a.last > addDays(today, -7)) continue; // still in use, or too rare to mean much
      for (const b of list) {
        if (b === a || b.uses < 2 || b.first <= a.last || b.first > addDays(a.last, 21)) continue;
        const score = a.uses + b.uses;
        if (!best || score > best.score) best = { stopped: a, started: b, score };
      }
    }
    if (!best) continue;
    const { stopped, started } = best;
    // A dish that changed loses its "no X" buttons together. If the dish's other removal
    // buttons ("No Chorizo", "No Goat" on a Calabria unchanged for years) carry on through the
    // change and were used more than the one that stopped, a rarely used button simply fell
    // out of use: not a new version.
    const carriedOn = list
      .filter((u) => u !== stopped && u !== started && readModifier({ name: u.name, ...(u.listName ? { listName: u.listName } : {}) }).action === 'remove')
      .filter((u) => u.first <= stopped.last && u.last >= started.first)
      .reduce((sum, u) => sum + u.days.filter((d) => d.date <= stopped.last).reduce((s, d) => s + d.quantity, 0), 0);
    const stoppedBefore = stopped.days.reduce((s, d) => s + d.quantity, 0);
    if (carriedOn > stoppedBefore) continue;
    // The change happened on a day the item sold between the old button's last use and the new
    // one's first. Menus usually change over a closed day, so the day after the longest
    // closure in that window is the best guess; with no closure, the first day after.
    const days = [...new Set(sales.filter((l) => l.catalogId === catalogId && l.date! > stopped.last && l.date! <= started.first).map((l) => l.date!))].sort();
    let suggestedDate = days[0] ?? addDays(stopped.last, 1);
    let longest = 0;
    days.forEach((day, i) => {
      const gap = (Date.parse(day) - Date.parse(i === 0 ? stopped.last : days[i - 1]!)) / 86400000;
      if (gap > longest) {
        longest = gap;
        suggestedDate = day;
      }
    });
    const itemName = sales.find((l) => l.catalogId === catalogId)?.name ?? catalogId;
    const since = sales.filter((l) => l.catalogId === catalogId && l.date! >= suggestedDate).reduce((s, l) => s + l.netSales, 0);
    checks.push({
      kind: 'dishChanged',
      title: `${itemName}: "${stopped.name}" was last used ${stopped.last} and "${started.name}" first used ${started.first}. Did the dish change on ${suggestedDate}?${days.length > 1 ? ` (It sold on ${days.length} days in between.)` : ''}`,
      dedupeKey: `menu:changed:${catalogId}:${suggestedDate}`,
      catalogId,
      netSales: since,
      suggestedDate,
    });
  }
  return checks;
}
