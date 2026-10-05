/**
 * Ordering: when each vendor delivers, when the order is due, and how much to order.
 *
 *  - Delivery days are learned from invoice dates; a manager confirms them and adds the
 *    cutoff ("by 2 pm the day before"). Nobody types a schedule from scratch.
 *  - A recommended order covers use until the delivery after this one, plus a safety
 *    margin, minus what's on hand (counted or estimated) and what's already on its way,
 *    in whole packs, and never more than will keep.
 *  - Orders are drafts until a manager approves them. Nothing is sent without approval.
 *
 * Amounts are in each product's base unit; dates are YYYY-MM-DD (weekday 0 = Sunday).
 */

import { addDays, weekdayOf } from './forecast.ts';

// ---------------------------------------------------------------- delivery days

export interface DeliveryRecord {
  vendorId: string;
  date: string;
}

export interface DeliverySchedule {
  vendorId: string;
  /** Weekdays the vendor regularly delivers (0 = Sunday). */
  weekdays: number[];
  /** Deliveries on each weekday over the period looked at. */
  counts: number[];
  deliveries: number;
  /** Typical days between deliveries. */
  typicalGap?: number;
  source: 'inferred' | 'confirmed';
  /** Orders are due this many days before delivery, by this time (manager-confirmed). */
  cutoff?: { daysBefore: number; time: string };
}

/**
 * Learns each vendor's delivery days from when its invoices are dated. A weekday counts as
 * a delivery day when it carries a fair share of the vendor's deliveries; one-off extra
 * deliveries don't make a schedule.
 */
export function inferDeliveryDays(records: readonly DeliveryRecord[], options: { minShare?: number; minDeliveries?: number } = {}): DeliverySchedule[] {
  const minShare = options.minShare ?? 0.15;
  const minDeliveries = options.minDeliveries ?? 4;
  const byVendor = new Map<string, Set<string>>();
  for (const r of records) byVendor.set(r.vendorId, (byVendor.get(r.vendorId) ?? new Set()).add(r.date));

  const out: DeliverySchedule[] = [];
  for (const [vendorId, dateSet] of byVendor) {
    const dates = [...dateSet].sort();
    if (dates.length < minDeliveries) continue;
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const d of dates) counts[weekdayOf(d)]!++;
    const weekdays = counts.flatMap((c, day) => (c / dates.length >= minShare ? [day] : []));
    const gaps = dates.slice(1).map((d, i) => (Date.parse(d) - Date.parse(dates[i]!)) / 86400000).sort((a, b) => a - b);
    out.push({ vendorId, weekdays, counts, deliveries: dates.length, ...(gaps.length ? { typicalGap: gaps[Math.floor(gaps.length / 2)]! } : {}), source: 'inferred' });
  }
  return out.sort((a, b) => b.deliveries - a.deliveries);
}

/** The next delivery dates on or after `from`. */
export function nextDeliveries(schedule: DeliverySchedule, from: string, count = 2): string[] {
  const out: string[] = [];
  if (schedule.weekdays.length === 0) return out;
  for (let d = from; out.length < count; d = addDays(d, 1)) if (schedule.weekdays.includes(weekdayOf(d))) out.push(d);
  return out;
}

/** When the order for a delivery is due, from the vendor's cutoff. */
export function orderDeadline(schedule: DeliverySchedule, delivery: string): { date: string; time: string } | undefined {
  if (!schedule.cutoff) return undefined;
  return { date: addDays(delivery, -schedule.cutoff.daysBefore), time: schedule.cutoff.time };
}

/**
 * The delivery the next order is for: the first one whose cutoff hasn't passed. Without a
 * confirmed cutoff, the next delivery at least a day away.
 */
export function deliveryToOrderFor(schedule: DeliverySchedule, today: string, now = '00:00'): { delivery: string; following?: string; deadline?: { date: string; time: string } } | undefined {
  const upcoming = nextDeliveries(schedule, addDays(today, 1), 3);
  for (const [i, delivery] of upcoming.entries()) {
    const deadline = orderDeadline(schedule, delivery);
    if (deadline && (deadline.date < today || (deadline.date === today && deadline.time <= now))) continue;
    return { delivery, ...(upcoming[i + 1] ? { following: upcoming[i + 1] } : {}), ...(deadline ? { deadline } : {}) };
  }
  return undefined;
}

// ---------------------------------------------------------------- how much

export interface OrderNeed {
  productId: string;
  /** On hand now: a count, or the running estimate. */
  onHand: number;
  onHandIsEstimate?: boolean;
  /** Expected use per day from today on (from the sales forecast, by recipe). */
  dailyUse: (date: string) => number;
  /** Already ordered and arriving by `delivery` (inclusive). */
  incoming?: number;
  /** What one pack holds, in the base unit (a 50 lb bag). */
  packSize: number;
  packName?: string;
  /** Days it keeps once delivered: never order more than will be used in that time. */
  shelfLifeDays?: number;
  /** Price per pack, for the order total. */
  packPrice?: number;
}

export interface OrderLine {
  productId: string;
  packs: number;
  packName?: string;
  amount: number;
  /** Use expected until the following delivery. */
  coverNeeded: number;
  /** Why it is this many. */
  reason: string;
  cost?: number;
  /** Capped by shelf life. */
  capped: boolean;
}

export interface RecommendOptions {
  /** Extra on top of expected use. Default 0.15; 0.25 when on hand is an estimate. */
  safety?: number;
  estimateSafety?: number;
}

/**
 * How many packs to order for `delivery`, so stock lasts until `following` arrives.
 * Use between now and the delivery comes out of what's on hand first.
 */
export function recommendLine(need: OrderNeed, today: string, delivery: string, following: string, options: RecommendOptions = {}): OrderLine | undefined {
  const safety = need.onHandIsEstimate ? (options.estimateSafety ?? 0.25) : (options.safety ?? 0.15);
  const useBetween = (from: string, until: string) => {
    let total = 0;
    for (let d = from; d < until; d = addDays(d, 1)) total += need.dailyUse(d);
    return total;
  };
  const beforeDelivery = useBetween(addDays(today, 1), delivery); // today's use is already in tonight's count
  const cover = useBetween(delivery, following);
  const leftAtDelivery = Math.max(0, need.onHand + (need.incoming ?? 0) - beforeDelivery);
  const shortBy = cover * (1 + safety) - leftAtDelivery;
  if (shortBy <= 1e-9) return undefined;

  let packs = Math.ceil(shortBy / need.packSize - 1e-9);
  let capped = false;
  if (need.shelfLifeDays !== undefined) {
    const keeps = useBetween(delivery, addDays(delivery, need.shelfLifeDays)) - leftAtDelivery;
    const maxPacks = Math.max(1, Math.floor(keeps / need.packSize + 1e-9));
    if (packs > maxPacks) {
      packs = maxPacks;
      capped = true;
    }
  }
  const amount = packs * need.packSize;
  const reason = `${round(cover)} needed until ${following} + ${Math.round(safety * 100)}% safety, ${round(leftAtDelivery)} left at delivery${need.onHandIsEstimate ? ' (estimated)' : ''}${capped ? `; capped at ${need.shelfLifeDays} days' keeping` : ''}`;
  return {
    productId: need.productId,
    packs,
    ...(need.packName ? { packName: need.packName } : {}),
    amount,
    coverNeeded: cover,
    reason,
    ...(need.packPrice !== undefined ? { cost: packs * need.packPrice } : {}),
    capped,
  };
}

const round = (x: number) => +x.toFixed(2);

// ---------------------------------------------------------------- drafts and approval

export interface OrderDraft {
  vendorId: string;
  delivery: string;
  deadline?: { date: string; time: string };
  lines: OrderLine[];
  total?: number;
  /** Below the vendor's minimum: the app suggests waiting or adding to it. */
  belowMinimum: boolean;
  status: 'draft' | 'approved' | 'sent';
  approvedBy?: string;
  approvedAt?: string;
}

export function draftOrder(vendorId: string, delivery: string, lines: readonly OrderLine[], options: { minimum?: number; deadline?: { date: string; time: string } } = {}): OrderDraft {
  const priced = lines.every((l) => l.cost !== undefined);
  const total = priced ? lines.reduce((s, l) => s + l.cost!, 0) : undefined;
  return {
    vendorId,
    delivery,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    lines: [...lines],
    ...(total !== undefined ? { total } : {}),
    belowMinimum: options.minimum !== undefined && total !== undefined && total < options.minimum,
    status: 'draft',
  };
}

export class OrderError extends Error {}

/** A manager approves an order; only approved orders can be sent. */
export function approveOrder(draft: OrderDraft, staffId: string, at: string): OrderDraft {
  if (draft.lines.length === 0) throw new OrderError('Nothing to order.');
  return { ...draft, status: 'approved', approvedBy: staffId, approvedAt: at };
}

/** The order as an email to the vendor. Refuses an order that hasn't been approved. */
export function orderEmail(draft: OrderDraft, restaurant: string, productName: (id: string) => string): { subject: string; body: string } {
  if (draft.status === 'draft') throw new OrderError('Orders are sent only after a manager approves them.');
  const lines = draft.lines.map((l) => `- ${l.packs} × ${l.packName ?? 'unit'}  ${productName(l.productId)}`);
  return {
    subject: `${restaurant} order for delivery ${draft.delivery}`,
    body: [`Hello,`, ``, `Please deliver on ${draft.delivery}:`, ``, ...lines, ``, `Thank you,`, restaurant].join('\n'),
  };
}
