/**
 * The dough count: how many dough balls and gluten-free crusts are left tonight, and how many
 * takeout pizzas. Pure: the server reads Square's orders for today and hands them in.
 *
 * One dough ball per item whose recipe uses the dough recipe, at any depth (a pizza, breadsticks).
 * A gluten-free crust is its own count: a dish rung with it (or made with the gluten-free dough)
 * uses a crust and no dough ball, and doesn't count against the takeout number.
 *
 * Takeout is anything without a table number: online orders, phone orders, a to-go ticket at the
 * counter. Table tickets are "T9 - 3", "T8 - S2" (a split check: a third of a pizza on each). The
 * open counter tickets with no name are gelato and coffee; they're takeout, and use no dough.
 */

export interface LiveLine {
  catalogId?: string;
  name: string;
  /** A split check puts 0.3333 of a pizza on each of three tickets. */
  quantity: number;
  /** The changes rung on it, by modifier key (modifiers.modifierKey). */
  modifierKeys: readonly string[];
}

export interface LiveOrder {
  id: string;
  /** OPEN, COMPLETED, CANCELED, DRAFT. */
  state: string;
  ticketName?: string;
  /** "Square Online", "Online ordering", "Point of Sale". */
  source?: string;
  lines: readonly LiveLine[];
}

/**
 * What one of a line uses: dough balls and gluten-free crusts, each 0 or 1. `guessed`: no recipe
 * says so, it's counted from its Square category (a pizza); `unknown`: no recipe, and it sells
 * beside dough items (breadsticks among the apps?), so it isn't counted but a manager should look.
 */
export type DoughOf = (line: LiveLine) => { balls: number; glutenFree: number; guessed?: boolean; unknown?: boolean };

export const isTableTicket = (name?: string) => /^\s*T\s*\d+/i.test(name ?? '');
export const isOnline = (source?: string) => /online/i.test(source ?? '');

export interface DoughTally {
  /** Dough balls on today's tickets, open or paid. */
  used: number;
  /** Of them, on table tickets. */
  dineIn: number;
  /** Of them, to go. */
  takeout: { online: number; toGo: number; total: number };
  /** Gluten-free crusts on today's tickets. */
  glutenFree: number;
  /** Orders read (not cancelled, not drafts). */
  orders: number;
  /** Items without a recipe: counted as pizzas by their category, or not counted at all. Name → how many. */
  guessed: Record<string, number>;
  notCounted: Record<string, number>;
}

/** Today's orders, open and paid, into dough balls and crusts used. Cancelled orders and unfinished online carts (drafts) don't count. */
export function tallyDough(orders: readonly LiveOrder[], doughOf: DoughOf): DoughTally {
  let dineIn = 0, online = 0, toGo = 0, gf = 0, n = 0;
  const guessed: Record<string, number> = {}, notCounted: Record<string, number> = {};
  for (const o of orders) {
    if (o.state === 'CANCELED' || o.state === 'DRAFT') continue;
    n++;
    let balls = 0;
    for (const l of o.lines) {
      const q = Number.isFinite(l.quantity) ? l.quantity : 0;
      const d = doughOf(l);
      balls += q * d.balls;
      gf += q * d.glutenFree;
      if (d.guessed) guessed[l.name] = (guessed[l.name] ?? 0) + q;
      if (d.unknown) notCounted[l.name] = (notCounted[l.name] ?? 0) + q;
    }
    if (isTableTicket(o.ticketName)) dineIn += balls;
    else if (isOnline(o.source)) online += balls;
    else toGo += balls;
  }
  // Thirds of a pizza on split checks add back up to whole ones.
  const whole = (v: number) => Math.round(v + 1e-6);
  const t = { online: whole(online), toGo: whole(toGo) };
  const round = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, whole(v)]).filter(([, v]) => (v as number) > 0));
  return { used: whole(dineIn + online + toGo), dineIn: whole(dineIn), takeout: { ...t, total: t.online + t.toGo }, glutenFree: whole(gf), orders: n, guessed: round(guessed), notCounted: round(notCounted) };
}

export interface DoughNumbers {
  /** Dough balls the night started with (left over plus made today); unset until the kitchen enters it. */
  start?: number;
  /** Gluten-free crusts the night started with. */
  glutenFreeStart?: number;
  /** Takeout pizzas for tonight: the day's number, or what the kitchen changed it to. */
  takeoutCap?: number;
  tally: DoughTally;
}

/** What the boards show: what's left of each count, and whether takeout is out for tonight. */
export function doughBoard(n: DoughNumbers) {
  const takeoutLeft = n.takeoutCap !== undefined ? Math.max(0, n.takeoutCap - n.tally.takeout.total) : undefined;
  return {
    dough: { used: n.tally.used, dineIn: n.tally.dineIn, ...(n.start !== undefined ? { start: n.start, left: n.start - n.tally.used } : {}) },
    glutenFree: { used: n.tally.glutenFree, ...(n.glutenFreeStart !== undefined ? { start: n.glutenFreeStart, left: n.glutenFreeStart - n.tally.glutenFree } : {}) },
    takeout: { ...n.tally.takeout, ...(n.takeoutCap !== undefined ? { cap: n.takeoutCap, left: takeoutLeft! } : {}) },
    /** No more takeout tonight: online ordering stops until the kitchen adds some. */
    takeoutOut: takeoutLeft !== undefined && takeoutLeft <= 0,
  };
}

/** The takeout number for a date: the night's own, else the weekday's (0 = Sunday). */
export function takeoutFor(day: string, byWeekday: readonly (number | null)[], tonight?: number | null): number | undefined {
  if (tonight !== undefined && tonight !== null) return tonight;
  const v = byWeekday[new Date(`${day}T12:00:00Z`).getUTCDay()];
  return v === undefined || v === null ? undefined : v;
}
