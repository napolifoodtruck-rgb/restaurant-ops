/**
 * Square writes for online orders, and nothing else: create a pickup order, and take its payment
 * with the one-time card token the Web Payments SDK made in the customer's browser. Card numbers
 * never come here. The nightly sync keeps its own read-only client (squareApi.ts).
 *
 * In the sandbox, Square's test account doesn't have the restaurant's catalog, so lines go in by
 * name and price instead of catalog id. In production they go by catalog id, so Square applies
 * tax and the sale reports against the right item.
 */

import type { Fetch } from './squareApi.ts';
import { SquareApiError } from './squareApi.ts';
import type { CartLine } from '../core/onlineCart.ts';

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
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json', 'content-type': 'application/json' };
    if (this.#version) headers['square-version'] = this.#version;
    const res = await this.#fetch(this.#base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    let data: any = {};
    try { data = await res.json(); } catch {}
    if (res.ok) return data;
    const errors: { code?: string; detail?: string; category?: string }[] = data.errors ?? [];
    const err = new SquareApiError(res.status, `Square POST ${path} failed (${res.status})${errors.length ? `: ${errors.map((e) => e.detail ?? e.code).join('; ')}` : ''}`);
    (err as SquareApiError & { codes?: string[] }).codes = errors.map((e) => e.code ?? '').filter(Boolean);
    throw err;
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
}
