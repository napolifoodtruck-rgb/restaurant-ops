/**
 * The dough count: how many dough balls are left tonight, how many of them are promised to takeout,
 * and how many the reservations still to come will likely use. Pure: the server reads Square's
 * orders for today and hands them in.
 *
 * One dough ball per item whose recipe uses the dough recipe, at any depth (a pizza, breadsticks).
 * A change rung on it that takes the dough off (a gluten-free crust) uses none, but a gluten-free
 * pizza to go still counts against the takeout number: it's a pizza out of the kitchen's takeout night.
 *
 * Takeout is anything without a table number: online orders, phone orders, a to-go ticket at the
 * counter. Table tickets are "T9 - 3", "T8 - S2" (a split check: a third of a pizza on each). The
 * open counter tickets with no name are gelato and coffee; they count as takeout, and use no dough.
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

/** What one of a line uses: a dough ball (0 or 1), and whether it's a pizza made from the dough as the dish is written, gluten-free crust or not (0 or 1). */
export type DoughOf = (line: LiveLine) => { balls: number; pizza: number };

export const isTableTicket = (name?: string) => /^\s*T\s*\d+/i.test(name ?? '');
export const isOnline = (source?: string) => /online/i.test(source ?? '');

export interface DoughTally {
  /** Dough balls on today's tickets, open or paid. */
  used: number;
  /** Dough balls on table tickets. */
  dineIn: number;
  /** Pizzas (and breadsticks) to go, gluten-free crust included. */
  takeout: { online: number; toGo: number; total: number };
  /** Orders read (not cancelled, not drafts). */
  orders: number;
}

/** Today's orders, open and paid, into dough balls used. Cancelled orders and unfinished online carts (drafts) don't count. */
export function tallyDough(orders: readonly LiveOrder[], doughOf: DoughOf): DoughTally {
  let dineIn = 0, takeoutBalls = 0, online = 0, toGo = 0, n = 0;
  for (const o of orders) {
    if (o.state === 'CANCELED' || o.state === 'DRAFT') continue;
    n++;
    let balls = 0, pizzas = 0;
    for (const l of o.lines) {
      const q = Number.isFinite(l.quantity) ? l.quantity : 0;
      const d = doughOf(l);
      balls += q * d.balls;
      pizzas += q * d.pizza;
    }
    if (isTableTicket(o.ticketName)) { dineIn += balls; continue; }
    takeoutBalls += balls;
    if (isOnline(o.source)) online += pizzas;
    else toGo += pizzas;
  }
  // Thirds of a pizza on split checks add back up to whole ones.
  const whole = (v: number) => Math.round(v + 1e-6);
  const t = { online: whole(online), toGo: whole(toGo) };
  return { used: whole(dineIn + takeoutBalls), dineIn: whole(dineIn), takeout: { ...t, total: t.online + t.toGo }, orders: n };
}

/** Reservations not yet here: from ten minutes ago on (a table at 7:00 may not be seated at 7:05). */
export function stillToCome(reservations: readonly { time: string; partySize: number }[], nowMinutes: number) {
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h! * 60 + m!; };
  const coming = reservations.filter((r) => mins(r.time) >= nowMinutes - 10);
  return { parties: coming.length, covers: coming.reduce((a, r) => a + r.partySize, 0) };
}

export interface DoughNumbers {
  /** Dough balls the night started with; unset until the kitchen enters it. */
  start?: number;
  /** Takeout pizzas for tonight: the day's number, or what the kitchen changed it to. */
  takeoutCap?: number;
  tally: DoughTally;
  toCome?: { parties: number; covers: number };
  /** Dough balls to set aside for each guest still to come: one each. */
  perCover?: number;
}

/**
 * What the boards show. Dough left: start less every ball on today's tickets. Takeout left: the
 * night's takeout number less what takeout has sold. Spare for walk-ins: dough left, less what's
 * still promised to takeout, less what the reservations to come will likely use.
 */
export function doughBoard(n: DoughNumbers) {
  const left = n.start !== undefined ? n.start - n.tally.used : undefined;
  const takeoutLeft = n.takeoutCap !== undefined ? Math.max(0, n.takeoutCap - n.tally.takeout.total) : undefined;
  const forReservations = n.toCome && n.perCover !== undefined ? Math.round(n.toCome.covers * n.perCover) : undefined;
  const spare = left !== undefined ? left - (takeoutLeft ?? 0) - (forReservations ?? 0) : undefined;
  return {
    ...(left !== undefined ? { left } : {}),
    used: n.tally.used,
    dineIn: n.tally.dineIn,
    takeout: { ...n.tally.takeout, ...(n.takeoutCap !== undefined ? { cap: n.takeoutCap, left: takeoutLeft! } : {}) },
    ...(n.toCome ? { toCome: { ...n.toCome, ...(forReservations !== undefined ? { pizzas: forReservations } : {}) } } : {}),
    ...(spare !== undefined ? { spare } : {}),
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
