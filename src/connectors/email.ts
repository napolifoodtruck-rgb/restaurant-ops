/**
 * Sends email through Resend (resend.com) over its HTTPS API. Used for order confirmations only.
 */

import type { Fetch } from './squareApi.ts';
import type { Email } from '../core/orderConfirmation.ts';

export interface EmailSettings {
  /** A Resend API key. Unset or 'later' = no emails sent. */
  apiKey?: string;
  /** "Napoli <orders@napolicarrboro.com>": the domain must be verified in Resend. */
  from?: string;
  /** Where a customer's reply goes. */
  replyTo?: string;
  /** For tests: stands in for Resend. */
  fetch?: Fetch;
}

export type SendEmail = (to: string, email: Email, idempotencyKey: string) => Promise<void>;

/** A sender when a key and a from address are set; otherwise undefined (emails are skipped). */
export function emailSender(settings: EmailSettings = {}): SendEmail | undefined {
  const key = settings.apiKey?.trim();
  if (!key || key.toLowerCase() === 'later' || !settings.from) return undefined;
  const fetch = settings.fetch ?? (globalThis.fetch as unknown as Fetch);
  return async (to, email, idempotencyKey) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ from: settings.from, to: [to], subject: email.subject, text: email.text, html: email.html, ...(settings.replyTo ? { reply_to: settings.replyTo } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}
