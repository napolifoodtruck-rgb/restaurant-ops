/**
 * The dough count: how many dough balls and gluten-free crusts are left tonight, and how many
 * takeout pizzas. Pure: the server reads Square's orders for today and hands them in.
 *
 * One dough ball per pizza or breadsticks: anything in Square's Pizza category, and the breadsticks.
 * A gluten-free crust is its own count: a pizza rung gluten-free uses a crust and no dough ball, and
 * doesn't count against the takeout number; a side of gluten-free bread (meatballs, ricotta) uses a
 * quarter of a crust.
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

/** What one of a line uses: dough balls (0 or 1) and gluten-free crusts (0, ¼ or 1). */
export type DoughOf = (line: LiveLine) => { balls: number; glutenFree: number };

export const isTableTicket = (name?: string) => /^\s*T\s*\d+/i.test(name ?? '');
export const isOnline = (source?: string) => /online/i.test(source ?? '');

export interface DoughTally {
  /** Dough balls on today's tickets, open or paid. */
  used: number;
  /** Of them, on table tickets. */
  dineIn: number;
  /** Of them, to go. */
  takeout: { online: number; toGo: number; total: number };
  /** Gluten-free crusts on today's tickets, to the quarter. */
  glutenFree: number;
  /** Orders read (not cancelled, not drafts). */
  orders: number;
}

/** Today's orders, open and paid, into dough balls and crusts used. Cancelled orders and unfinished online carts (drafts) don't count. */
export function tallyDough(orders: readonly LiveOrder[], doughOf: DoughOf): DoughTally {
  let dineIn = 0, online = 0, toGo = 0, gf = 0, n = 0;
  for (const o of orders) {
    if (o.state === 'CANCELED' || o.state === 'DRAFT') continue;
    n++;
    let balls = 0;
    for (const l of o.lines) {
      const q = Number.isFinite(l.quantity) ? l.quantity : 0;
      const d = doughOf(l);
      balls += q * d.balls;
      gf += q * d.glutenFree;
    }
    if (isTableTicket(o.ticketName)) dineIn += balls;
    else if (isOnline(o.source)) online += balls;
    else toGo += balls;
  }
  // Thirds of a pizza on split checks add back up to whole ones.
  const whole = (v: number) => Math.round(v + 1e-6);
  const t = { online: whole(online), toGo: whole(toGo) };
  return { used: whole(dineIn + online + toGo), dineIn: whole(dineIn), takeout: { ...t, total: t.online + t.toGo }, glutenFree: Math.round(gf * 4 + 1e-6) / 4, orders: n };
}

export interface DoughNumbers {
  /** Dough balls the night started with (left over plus made today); unset until the kitchen enters it. */
  start?: number;
  /** Gluten-free crusts the night started with. */
  glutenFreeStart?: number;
  /** Takeout pizzas for tonight: the day's number, or what the kitchen changed it to. */
  takeoutCap?: number;
  /** Dough balls kept back for remakes (a pizza that goes wrong): not sold, to takeout or the floor. */
  spare?: number;
  tally: DoughTally;
}

/**
 * What the boards show. One dough number for the night, in two parts: takeout's share, and the
 * rest for dine-in. Takeout is what the kitchen steers (online ordering stops at zero); it can
 * never be more than the dough left, less a few kept spare for remakes. Dine-in is whatever's left
 * of that after takeout's share; at zero, the floor stops seating (the spare is still there).
 */
export function doughBoard(n: DoughNumbers) {
  const spare = n.spare ?? 0;
  const left = n.start !== undefined ? n.start - n.tally.used : undefined;
  // What can still be sold: the dough left, less the spare kept for remakes.
  const sellable = left !== undefined ? Math.max(0, left - spare) : undefined;
  const byCap = n.takeoutCap !== undefined ? n.takeoutCap - n.tally.takeout.total : undefined;
  const takeoutLeft = byCap === undefined ? undefined : Math.max(0, sellable !== undefined ? Math.min(byCap, sellable) : byCap);
  return {
    dough: {
      used: n.tally.used, usedDineIn: n.tally.dineIn, usedTakeout: n.tally.used - n.tally.dineIn,
      ...(n.start !== undefined ? { start: n.start, left: left!, spare } : {}),
      // The split of what can still be sold: takeout's share, and the rest for dine-in.
      ...(sellable !== undefined ? { forDineIn: Math.max(0, sellable - (takeoutLeft ?? 0)), out: sellable <= 0 } : {}),
    },
    glutenFree: { used: n.tally.glutenFree, ...(n.glutenFreeStart !== undefined ? { start: n.glutenFreeStart, left: n.glutenFreeStart - n.tally.glutenFree } : {}) },
    takeout: { ...n.tally.takeout, ...(n.takeoutCap !== undefined ? { cap: n.takeoutCap, left: takeoutLeft! } : {}), ...(byCap !== undefined && takeoutLeft! < Math.max(0, byCap) ? { limitedByDough: true } : {}) },
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
