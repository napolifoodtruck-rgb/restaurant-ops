/**
 * Square calls for online orders, and nothing else: read the published items as they are now
 * (prices, sold out) and their stock counts, create a pickup order, take its payment with the one-time card token the Web
 * Payments SDK made in the customer's browser, and look up which payments were refunded since. Card numbers never come here. The nightly sync keeps its own
 * read-only client (squareApi.ts).
 *
 * In the sandbox, Square's test account doesn't have the restaurant's catalog, so lines go in by
 * name and price instead of catalog id. In production they go by catalog id, so Square applies
 * tax and the sale reports against the right item.
 */

import type { Fetch } from './squareApi.ts';
import { SquareApiError } from './squareApi.ts';
import type { CartLine } from '../core/onlineCart.ts';
import type { CatalogObject } from '../core/onlineMenu.ts';

export type SquareEnvironment = 'sandbox' | 'production';

export interface PickupOrderIn {
  idempotencyKey: string;
  locationId: string;
  referenceId: string;
  lines: readonly CartLine[];
  pickupAt: string;
  customer: { name: string; phone: string; email?: string };
  note?: string;
}

export interface SquareOrderOut { id: string; version?: number; total: number; tax: number }
export interface SquarePaymentOut { id: string; status: string; receiptUrl?: string }
/** A payment as it stands now: what it came to, tip included, and how much was refunded. */
export interface SquarePaymentState { id: string; total: number; refunded: number }

const money = (amount: number) => ({ amount, currency: 'USD' });

export class SquareCheckout {
  readonly environment: SquareEnvironment;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #version?: string;

  constructor(token: string, environment: SquareEnvironment, options: { fetch?: Fetch; version?: string } = {}) {
    this.#token = token;
    this.environment = environment;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.#version = options.version;
  }

  get #base() {
    return this.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  }

  async #post(path: string, body: unknown): Promise<any> {
    return this.#call('POST', path, body);
  }

  async #call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.#version) headers['square-version'] = this.#version;
    const res = await this.#fetch(this.#base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let data: any = {};
    try { data = await res.json(); } catch {}
    if (res.ok) return data;
    const errors: { code?: string; detail?: string; category?: string }[] = data.errors ?? [];
    const err = new SquareApiError(res.status, `Square ${method} ${path} failed (${res.status})${errors.length ? `: ${errors.map((e) => e.detail ?? e.code).join('; ')}` : ''}`);
    (err as SquareApiError & { codes?: string[] }).codes = errors.map((e) => e.code ?? '').filter(Boolean);
    throw err;
  }

  /** These catalog objects as they are in Square right now (with `related`, also their modifier lists,
   *  categories and images). Ids Square doesn't have are left out. */
  async catalogObjects(ids: readonly string[], related = false): Promise<CatalogObject[]> {
    const out: CatalogObject[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const data = await this.#post('/v2/catalog/batch-retrieve', { object_ids: ids.slice(i, i + 1000), include_related_objects: related });
      out.push(...(data.objects ?? []), ...(related ? data.related_objects ?? [] : []));
    }
    return out;
  }

  /** How many of each size Square has in stock at the location. Sizes it doesn't count are left out. */
  async stockCounts(variationIds: readonly string[], locationId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await this.#post('/v2/inventory/counts/batch-retrieve', { catalog_object_ids: variationIds, location_ids: [locationId], states: ['IN_STOCK'], ...(cursor ? { cursor } : {}) });
      for (const c of data.counts ?? []) if (c.state === 'IN_STOCK') out.set(c.catalog_object_id, Number(c.quantity));
      cursor = data.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /** A pickup order, open in Square once paid (an unpaid order stays out of the POS). */
  async createPickupOrder(o: PickupOrderIn): Promise<SquareOrderOut> {
    const byCatalog = this.environment === 'production';
    const data = await this.#post('/v2/orders', {
      idempotency_key: o.idempotencyKey,
      order: {
        location_id: o.locationId,
        reference_id: o.referenceId,
        source: { name: 'Online ordering' },
        line_items: o.lines.map((l) => (byCatalog
          ? { catalog_object_id: l.variationId, quantity: String(l.quantity), modifiers: l.modifiers.map((m) => ({ catalog_object_id: m.id })) }
          : { name: l.variationName && l.variationName !== 'Regular' ? `${l.name} (${l.variationName})` : l.name, quantity: String(l.quantity), base_price_money: money(l.unitPrice - l.modifiers.reduce((s, m) => s + m.price, 0)),
            modifiers: l.modifiers.map((m) => ({ name: m.name, base_price_money: money(m.price) })) })),
        fulfillments: [{
          type: 'PICKUP',
          state: 'PROPOSED',
          pickup_details: {
            recipient: { display_name: o.customer.name, phone_number: o.customer.phone, ...(o.customer.email ? { email_address: o.customer.email } : {}) },
            schedule_type: 'SCHEDULED',
            pickup_at: o.pickupAt,
            ...(o.note ? { note: o.note } : {}),
          },
        }],
        pricing_options: { auto_apply_taxes: true },
      },
    });
    const order = data.order ?? {};
    return { id: order.id, version: order.version, total: Number(order.total_money?.amount ?? 0), tax: Number(order.total_tax_money?.amount ?? 0) };
  }

  /** The payment an order is already paid with in Square, if it's paid in full. */
  async paidWith(orderId: string): Promise<SquarePaymentOut | undefined> {
    const data = await this.#call('GET', `/v2/orders/${encodeURIComponent(orderId)}`);
    const order = data.order ?? {};
    const tender = (order.tenders ?? []).find((t: any) => t.payment_id);
    if (!tender || Number(order.net_amount_due_money?.amount ?? 1) > 0) return undefined;
    return { id: tender.payment_id, status: 'COMPLETED' };
  }

  /**
   * Cancels an order nobody paid for, so the POS stops counting its items as committed. 'paid': it was paid after all,
   * and is left alone; 'gone': already closed or cancelled.
   */
  async cancelUnpaid(orderId: string, idempotencyKey: string): Promise<'cancelled' | 'paid' | 'gone'> {
    const order = (await this.#call('GET', `/v2/orders/${encodeURIComponent(orderId)}`)).order ?? {};
    if (order.state !== 'OPEN') return 'gone';
    if ((order.tenders ?? []).length || Number(order.net_amount_due_money?.amount ?? 1) <= 0) return 'paid';
    await this.#call('PUT', `/v2/orders/${encodeURIComponent(orderId)}`, {
      idempotency_key: idempotencyKey,
      order: { location_id: order.location_id, version: order.version, state: 'CANCELED', fulfillments: (order.fulfillments ?? []).map((f: any) => ({ uid: f.uid, state: 'CANCELED' })) },
    });
    return 'cancelled';
  }

  /** Charges the order with the card token; the tip goes on top of the order's total. */
  async payOrder(p: { idempotencyKey: string; orderId: string; locationId: string; sourceId: string; amount: number; tip: number; verificationToken?: string; email?: string }): Promise<SquarePaymentOut> {
    const data = await this.#post('/v2/payments', {
      idempotency_key: p.idempotencyKey,
      source_id: p.sourceId,
      amount_money: money(p.amount),
      ...(p.tip ? { tip_money: money(p.tip) } : {}),
      order_id: p.orderId,
      location_id: p.locationId,
      autocomplete: true,
      ...(p.verificationToken ? { verification_token: p.verificationToken } : {}),
      ...(p.email ? { buyer_email_address: p.email } : {}),
    });
    const payment = data.payment ?? {};
    return { id: payment.id, status: payment.status, ...(payment.receipt_url ? { receiptUrl: payment.receipt_url } : {}) };
  }

  /** Every payment taken at the location since `since` (an ISO time), with what's been refunded of each. */
  async paymentsSince(locationId: string, since: string): Promise<SquarePaymentState[]> {
    const out: SquarePaymentState[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ location_id: locationId, begin_time: since, limit: '100', ...(cursor ? { cursor } : {}) });
      const data = await this.#call('GET', `/v2/payments?${q}`);
      for (const p of data.payments ?? []) out.push({ id: p.id, total: Number(p.total_money?.amount ?? p.amount_money?.amount ?? 0), refunded: Number(p.refunded_money?.amount ?? 0) });
      cursor = data.cursor;
      if (!cursor) break;
    }
    return out;
  }
}
