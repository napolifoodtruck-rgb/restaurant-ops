/**
 * Online ordering for customers. Public: no sign-in. Same day, pickup only.
 *
 *   GET  /api/order/menu          the published menu, tonight's windows, and what the card form needs
 *   POST /api/order/checkout      { lines: [{ variationId, quantity, optionIds? }], window, name, phone, email?, tip, understood: true, replaces? }
 *                                 holds the pizzas in that window, creates the Square order; returns its total.
 *                                 `replaces`: the customer's earlier unpaid order, whose hold is given up first
 *   POST /api/order/:id/pay       { sourceId, verificationToken? }  the card token from the Web Payments SDK
 *   POST /api/order/:id/release   gives up a held order's pickup slot (the customer went back to change it)
 *   GET  /api/order/:id           where an order stands, for the confirmation page
 *
 * The cart is priced again here from the catalog, never taken from the browser. A hold lasts
 * HOLD_MINUTES; paying after it lapses works only if the window still has room. While online orders
 * are paused, no new order starts, but one already at checkout can still be paid.
 *
 * Published items are read from Square as they are now (price, sold out) at most once every
 * CATALOG_CHECK_MS, on top of the nightly copy of the catalog; if Square can't be reached, the
 * last read (or the copy) stands.
 *
 * Paying is one at a time per order, and asks Square first whether the order is already paid: a Pay
 * pressed again after the connection dropped (with a new card token, so a new idempotency key) gets
 * the payment that went through, never a second charge.
 *
 * Right before an order is created in Square, and again right before the card is charged, the
 * items in it are read from Square afresh: anything switched off on the POS, or with fewer left
 * than the order wants, stops it there (the customer isn't charged and goes back to their order).
 *
 * A paid order refunded in full in Square (or cancelled from the POS, which refunds it) gives its
 * pizzas back: tonight's payments are looked up again at most once every REFUND_CHECK_MS, as
 * customers load the menu or check out.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { loadOnlineMenu, loadPause, loadWindows, localNow } from './online.ts';
import type { CatalogObject } from '../core/onlineMenu.ts';
import { CartError, priceCart, publicMenu, stockProblem, tipProblem, type CartLine, type CartLineIn } from '../core/onlineCart.ts';
import { fitOrder, fittingWindows, isWindowStart } from '../core/pickupWindows.ts';
import { SquareCheckout, type SquareEnvironment } from '../connectors/squareCheckout.ts';
import { SquareApiError, type Fetch } from '../connectors/squareApi.ts';

export const HOLD_MINUTES = 10;
/** A payment still marked as with Square after this long is taken to have died with its request. */
export const PAYING_MINUTES = 2;
export const REFUND_CHECK_MS = 60_000;
export const CATALOG_CHECK_MS = 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CheckoutSettings {
  /** A Square access token that can create orders and payments. */
  token?: string;
  /** The Square application id: public, the card form needs it. */
  applicationId?: string;
  locationId?: string;
  environment?: SquareEnvironment;
  version?: string;
  /** For tests: stands in for Square. */
  fetch?: Fetch;
  /** For tests: the restaurant's local date and time. */
  now?: (timezone: string) => { date: string; time: string };
  /** For tests: how often to look for refunds (default REFUND_CHECK_MS). */
  refundCheckMs?: number;
  /** For tests: how often to read the published items from Square (default CATALOG_CHECK_MS). */
  catalogCheckMs?: number;
  /** For tests: how many tries one address gets in five minutes (default 20). */
  triesPerFiveMinutes?: number;
}

/** Ready to take payments: all three are set. */
export function checkoutFrom(settings: CheckoutSettings = {}): { square: SquareCheckout; applicationId: string; locationId: string } | undefined {
  const token = settings.token?.trim();
  if (!token || token.toLowerCase() === 'later' || !settings.applicationId || !settings.locationId) return undefined;
  return { square: new SquareCheckout(token, settings.environment ?? 'sandbox', { ...(settings.version ? { version: settings.version } : {}), ...(settings.fetch ? { fetch: settings.fetch } : {}) }), applicationId: settings.applicationId, locationId: settings.locationId };
}

/** A few tries a minute per address: enough for a real customer, not for someone hammering checkout. */
export function rateLimiter(max: number, perMs: number) {
  const seen = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (seen.get(key) ?? []).filter((t) => now - t < perMs);
    if (seen.size > 10_000) seen.clear();
    if (recent.length >= max) return seen.set(key, recent), false;
    recent.push(now);
    seen.set(key, recent);
    return true;
  };
}

const clientOf = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() || req.socket.remoteAddress || '?';
const clock = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${h! % 12 || 12}:${String(m).padStart(2, '0')} ${h! < 12 ? 'am' : 'pm'}`; };
const hhmm = (t: string) => t.slice(0, 5);

interface OrderRow { id: string; restaurant_id: string; day: string; window_starts: string; pizzas: number; status: string; hold_until: string; customer_name: string; customer_phone: string; customer_email: string | null; lines: unknown; subtotal_cents: number; tax_cents: number; total_cents: number; tip_cents: number; square_order_id: string | null; receipt_url: string | null; still_held: boolean }

const summary = (o: OrderRow) => ({
  id: o.id,
  status: o.status,
  day: o.day,
  window: { starts: hhmm(o.window_starts), label: clock(hhmm(o.window_starts)) },
  name: o.customer_name,
  lines: typeof o.lines === 'string' ? JSON.parse(o.lines) : o.lines,
  subtotal: o.subtotal_cents,
  tax: o.tax_cents,
  total: o.total_cents,
  tip: o.tip_cents,
  ...(o.receipt_url ? { receiptUrl: o.receipt_url } : {}),
});

export function checkoutRoutes(db: Db, settings: CheckoutSettings = {}) {
  const ready = checkoutFrom(settings);
  const allowed = rateLimiter(settings.triesPerFiveMinutes ?? 20, 5 * 60_000);
  const nowIn = settings.now ?? localNow;

  async function restaurant() {
    // One restaurant per app for now, as with the brand.
    const r = (await db.query<{ id: string; name: string; timezone: string }>('SELECT id, name, timezone FROM restaurants ORDER BY created_at LIMIT 1')).rows[0];
    if (!r) throw new HttpError(404, 'Online ordering isn’t set up.');
    return r;
  }

  // Paid orders refunded in full in Square give their pizzas back. A failed look-up never stops anyone ordering.
  let refundsCheckedAt = -Infinity;
  async function noticeRefunds(restaurantId: string, day: string) {
    if (!ready || Date.now() - refundsCheckedAt < (settings.refundCheckMs ?? REFUND_CHECK_MS)) return;
    refundsCheckedAt = Date.now();
    const paid = (await db.query<{ id: string; square_payment_id: string; paid_at: Date | string }>("SELECT id, square_payment_id, paid_at FROM online_orders WHERE restaurant_id = $1 AND day = $2 AND status = 'paid'", [restaurantId, day])).rows;
    if (!paid.length) return;
    const since = new Date(Math.min(...paid.map((o) => new Date(o.paid_at).getTime())) - 10 * 60_000).toISOString();
    try {
      const refunded = new Set((await ready.square.paymentsSince(ready.locationId, since)).filter((p) => p.refunded > 0 && p.refunded >= p.total).map((p) => p.id));
      const ids = paid.filter((o) => refunded.has(o.square_payment_id)).map((o) => o.id);
      if (ids.length) await db.query("UPDATE online_orders SET status = 'refunded', refunded_at = now() WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid) AND status = 'paid'", [JSON.stringify(ids)]);
    } catch (err) {
      console.error(`online orders: couldn’t check for refunds: ${(err as Error).message}`);
    }
  }

  // The published items as they are in Square now, so a price change or a "sold out" shows within a minute.
  let fresh: { at: number; objects: CatalogObject[] } | undefined;
  async function menuNow(restaurantId: string, today: string, now = false) {
    if (ready && (now || !fresh || Date.now() - fresh.at >= (settings.catalogCheckMs ?? CATALOG_CHECK_MS))) {
      let objects = fresh?.objects ?? [];
      try {
        const ids = (await db.query<{ item_id: string }>('SELECT item_id FROM online_items WHERE restaurant_id = $1 AND published', [restaurantId])).rows.map((r) => r.item_id);
        objects = ids.length ? await ready.square.catalogObjects(ids) : [];
      } catch (err) {
        console.error(`online menu: couldn’t read items from Square: ${(err as Error).message}`);
      }
      fresh = { at: Date.now(), objects };
    }
    return loadOnlineMenu(db, restaurantId, today, { fresh: fresh?.objects ?? [], ...(ready ? { locationId: ready.locationId } : {}) });
  }

  // Square's word on the order's items right now: still on, and enough of anything it counts.
  async function confirmStock(restaurantId: string, today: string, lines: readonly CartLine[]) {
    if (!ready) return;
    const { menu } = await menuNow(restaurantId, today, true);
    const counted = [...new Set(lines.map((l) => l.variationId))].filter((id) => menu.some((x) => x.variations.some((v) => v.id === id && v.counted)));
    let counts = new Map<string, number>();
    if (counted.length) {
      try { counts = await ready.square.stockCounts(counted, ready.locationId); } catch (err) { console.error(`online order: couldn’t read stock counts from Square: ${(err as Error).message}`); }
    }
    const problem = stockProblem(menu, lines, counts);
    if (problem) throw new HttpError(409, problem, { backToOrder: true });
  }

  // Gives up an unpaid order's hold, unless a payment for it is with Square right now.
  async function release(id: string) {
    await db.query(`UPDATE online_orders SET status = 'released' WHERE id = $1 AND status IN ('held', 'expired')
      AND (paying_since IS NULL OR paying_since < now() - make_interval(mins => $2::int))`, [id, PAYING_MINUTES]);
  }

  async function loadOrder(id: string): Promise<OrderRow | undefined> {
    return (await db.query<OrderRow>('SELECT id, restaurant_id, day::text AS day, window_starts::text AS window_starts, pizzas, status, hold_until, customer_name, customer_phone, customer_email, lines, subtotal_cents, tax_cents, total_cents, tip_cents, square_order_id, receipt_url, hold_until > now() AS still_held FROM online_orders WHERE id = $1', [id])).rows[0];
  }

  return async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith('/api/order/')) return false;
    const method = req.method ?? 'GET';
    if (method === 'POST' && !allowed(clientOf(req))) throw new HttpError(429, 'Too many tries. Wait a few minutes, or call us.');
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/api/order/menu') {
      const r = await restaurant();
      const now = nowIn(r.timezone);
      const { menu } = await menuNow(r.id, now.date);
      await noticeRefunds(r.id, now.date);
      const windows = await loadWindows(db, r.id, now.date);
      const fit = fitOrder(windows, 1, now.time);
      const pause = await loadPause(db, r.id, r.timezone);
      return send(res, 200, {
        restaurant: r.name,
        today: now.date,
        now: now.time,
        open: Boolean(ready) && fit.kind !== 'closed' && !pause,
        // Paused for a busy spell: back at that time, or not again tonight.
        paused: pause ? { until: pause.tonight ? null : { starts: pause.untilTime, label: clock(pause.untilTime) } } : null,
        items: publicMenu(menu),
        // How much room each window has left, so the cart can show the earliest pickup as it fills.
        windows: windows.map((w) => ({ starts: w.starts, ends: w.ends, label: clock(w.starts), left: w.left, open: fittingWindows([w], 0, now.time).length > 0 })),
        payments: ready ? { applicationId: ready.applicationId, locationId: ready.locationId, environment: ready.square.environment } : null,
      }), true;
    }

    if (method === 'POST' && path === '/api/order/checkout') {
      if (!ready) throw new HttpError(503, 'Online ordering isn’t open yet. Please call us.');
      const r = await restaurant();
      const now = nowIn(r.timezone);
      const b = await body(req);
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
      const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
      const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().slice(0, 120) : undefined;
      if (!name) throw new HttpError(400, 'What name is the order under?');
      const digits = phone.replace(/\D/g, '');
      if (digits.length !== 10 && !(digits.length === 11 && digits.startsWith('1'))) throw new HttpError(400, 'A phone number, so we can reach you about the order.');
      const e164 = `+1${digits.slice(-10)}`;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email doesn’t look right.');
      if (b.understood !== true) throw new HttpError(400, 'Please confirm you know the pizzas are partially cooked, to finish at home.');
      const pause = await loadPause(db, r.id, r.timezone);
      if (pause) throw new HttpError(409, pause.tonight ? 'Sorry, we’ve stopped taking online orders for tonight.' : `Sorry, we’re very busy right now. We’ll take online orders again from ${clock(pause.untilTime)}.`);
      if (typeof b.window !== 'string' || !isWindowStart(b.window)) throw new HttpError(400, 'Pick a pickup time.');
      if (!Array.isArray(b.lines)) throw new HttpError(400, 'Your cart is empty.');

      const { menu } = await menuNow(r.id, now.date);
      let cart;
      try {
        cart = priceCart(menu, (b.lines as Record<string, unknown>[]).map((l) => ({ variationId: String(l.variationId ?? ''), quantity: Number(l.quantity), optionIds: Array.isArray(l.optionIds) ? l.optionIds.map(String) : [] }) satisfies CartLineIn));
      } catch (err) {
        if (err instanceof CartError) throw new HttpError(400, err.message);
        throw err;
      }
      const tip = Number(b.tip ?? 0);
      const tipBad = tipProblem(tip, cart.subtotal);
      if (tipBad) throw new HttpError(400, tipBad);
      await confirmStock(r.id, now.date, cart.lines);

      await db.query("UPDATE online_orders SET status = 'expired' WHERE restaurant_id = $1 AND status = 'held' AND hold_until < now() - interval '1 hour'", [r.id]);
      // Went back to change the order: the earlier one's pizzas aren't held twice.
      if (typeof b.replaces === 'string' && ID.test(b.replaces)) await release(b.replaces);
      await noticeRefunds(r.id, now.date);
      const windows = await loadWindows(db, r.id, now.date);
      const fit = fitOrder(windows, cart.pizzas, now.time);
      if (fit.kind === 'tooBig') throw new HttpError(409, `That’s more pizzas than we can make for one pickup online (${fit.mostAnyWindowTakes} at most). Please call us and we’ll sort it out.`);
      if (fit.kind !== 'fits') throw new HttpError(409, 'Sorry, we’re full for online orders tonight.');
      if (!fit.windows.some((w) => w.starts === b.window)) throw new HttpError(409, `That pickup time just filled up. The earliest now is ${clock(fit.earliest.starts)}.`);

      const id = (await db.query<{ id: string; pickup_at: string }>(
        `INSERT INTO online_orders (restaurant_id, day, window_starts, pizzas, hold_until, customer_name, customer_phone, customer_email, lines, subtotal_cents, total_cents, tip_cents, understood_partial)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int), $6, $7, $8, $9::jsonb, $10, $10, $11, true) RETURNING id`,
        [r.id, now.date, b.window, cart.pizzas, HOLD_MINUTES, name, phone, email ?? null, JSON.stringify(cart.lines), cart.subtotal, tip])).rows[0]!.id;
      const pickupAt = (await db.query<{ t: string }>('SELECT to_char((($1::date + $2::time) AT TIME ZONE $3) AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') AS t', [now.date, b.window, r.timezone])).rows[0]!.t;
      try {
        const order = await ready.square.createPickupOrder({ idempotencyKey: id, locationId: ready.locationId, referenceId: id.slice(0, 8), lines: cart.lines, pickupAt, customer: { name, phone: e164, ...(email ? { email } : {}) }, note: 'Online order: pizzas partially cooked, finished at home.' });
        await db.query('UPDATE online_orders SET square_order_id = $2, tax_cents = $3, total_cents = $4 WHERE id = $1', [id, order.id, order.tax, order.total]);
      } catch (err) {
        await db.query("UPDATE online_orders SET status = 'failed', failure = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 500)]);
        console.error(`online order ${id}: ${(err as Error).message}`);
        throw new HttpError(502, 'We couldn’t start your order. Please try again, or call us.');
      }
      return send(res, 201, { ...summary((await loadOrder(id))!), holdMinutes: HOLD_MINUTES }), true;
    }

    if (method === 'POST' && (m = path.match(/^\/api\/order\/([0-9a-f-]{36})\/pay$/)) && ID.test(m[1]!)) {
      if (!ready) throw new HttpError(503, 'Online ordering isn’t open yet. Please call us.');
      const b = await body(req);
      const sourceId = typeof b.sourceId === 'string' ? b.sourceId : '';
      if (!sourceId || sourceId.length > 500) throw new HttpError(400, 'The card details didn’t come through. Try again.');
      const order = await loadOrder(m[1]!);
      if (!order || !order.square_order_id) throw new HttpError(404, 'That order isn’t here. Start again from the menu.');
      if (order.status === 'paid') return send(res, 200, summary(order)), true;
      if (order.status !== 'held' && order.status !== 'expired') throw new HttpError(409, 'That order can’t be paid any more. Start again from the menu.');
      // One payment at a time: a second Pay while the first is with Square waits for it.
      const claimed = await db.query(`UPDATE online_orders SET paying_since = now() WHERE id = $1 AND status IN ('held', 'expired')
        AND (paying_since IS NULL OR paying_since < now() - make_interval(mins => $2::int)) RETURNING id`, [order.id, PAYING_MINUTES]);
      if (!claimed.rows.length) {
        const now = (await loadOrder(order.id))!;
        if (now.status === 'paid') return send(res, 200, summary(now)), true;
        throw new HttpError(409, 'Your payment is still going through. Give it a moment.', { paying: true });
      }
      try {
        // Already paid in Square (an earlier Pay went through, but its answer never got back): no second charge.
        let already;
        try { already = await ready.square.paidWith(order.square_order_id); } catch (err) { console.error(`online order ${order.id}: couldn’t ask Square whether it’s paid: ${(err as Error).message}`); }
        if (already) {
          await db.query("UPDATE online_orders SET status = 'paid', square_payment_id = $2, paid_at = now(), failure = NULL WHERE id = $1", [order.id, already.id]);
          return send(res, 200, summary((await loadOrder(order.id))!)), true;
        }
        if (!order.still_held || order.status === 'expired') {
          // The hold lapsed while they were paying: fine if the window still has room.
          const r = await restaurant();
          const now = nowIn(r.timezone);
          const windows = await loadWindows(db, r.id, order.day, order.id);
          if (order.day !== now.date || !fittingWindows(windows, order.pizzas, now.time).some((w) => w.starts === hhmm(order.window_starts))) {
            await db.query("UPDATE online_orders SET status = 'expired' WHERE id = $1 AND status = 'held'", [order.id]);
            throw new HttpError(409, 'Sorry, that pickup time filled up while you were paying. You haven’t been charged: start again to pick another time.');
          }
          await db.query("UPDATE online_orders SET status = 'held', hold_until = now() + make_interval(mins => $2::int) WHERE id = $1", [order.id, HOLD_MINUTES]);
        }
        try {
          await confirmStock(order.restaurant_id, order.day, (typeof order.lines === 'string' ? JSON.parse(order.lines) : order.lines) as CartLine[]);
        } catch (err) {
          if (err instanceof HttpError) await db.query("UPDATE online_orders SET status = 'failed', failure = $2 WHERE id = $1 AND status = 'held'", [order.id, err.message]);
          throw err;
        }
        // One key per card token: pressing Pay twice can't charge twice, and a declined card can be retried with another.
        const key = `${order.id}:${createHash('sha256').update(sourceId).digest('hex').slice(0, 8)}`;
        try {
          const payment = await ready.square.payOrder({ idempotencyKey: key, orderId: order.square_order_id, locationId: ready.locationId, sourceId, amount: order.total_cents, tip: order.tip_cents, ...(typeof b.verificationToken === 'string' ? { verificationToken: b.verificationToken } : {}), ...(order.customer_email ? { email: order.customer_email } : {}) });
          if (payment.status !== 'COMPLETED' && payment.status !== 'APPROVED') throw new HttpError(402, 'The payment didn’t go through. Try another card.');
          await db.query("UPDATE online_orders SET status = 'paid', square_payment_id = $2, receipt_url = $3, paid_at = now(), failure = NULL WHERE id = $1", [order.id, payment.id, payment.receiptUrl ?? null]);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const codes = (err as { codes?: string[] }).codes ?? [];
          await db.query('UPDATE online_orders SET failure = $2 WHERE id = $1', [order.id, (err as Error).message.slice(0, 500)]);
          if (err instanceof SquareApiError && err.status >= 400 && err.status < 500 && codes.length) throw new HttpError(402, codes.some((c) => /CVV|ADDRESS|POSTAL|EXPIRATION/.test(c)) ? 'The card details didn’t match. Check them and try again.' : 'The card was declined. Try another card.');
          console.error(`online order ${order.id} payment: ${(err as Error).message}`);
          throw new HttpError(502, 'We couldn’t finish the payment. Try again in a moment: you won’t be charged twice.');
        }
      } finally {
        await db.query('UPDATE online_orders SET paying_since = NULL WHERE id = $1', [order.id]);
      }
      return send(res, 200, summary((await loadOrder(order.id))!)), true;
    }

    if (method === 'POST' && (m = path.match(/^\/api\/order\/([0-9a-f-]{36})\/release$/)) && ID.test(m[1]!)) {
      await release(m[1]!);
      const order = await loadOrder(m[1]!);
      if (!order) throw new HttpError(404, 'That order isn’t here.');
      return send(res, 200, summary(order)), true;
    }

    if (method === 'GET' && (m = path.match(/^\/api\/order\/([0-9a-f-]{36})$/)) && ID.test(m[1]!)) {
      const order = await loadOrder(m[1]!);
      if (!order) throw new HttpError(404, 'That order isn’t here.');
      return send(res, 200, summary(order)), true;
    }

    throw new HttpError(404, 'Not found.');
  };
}
