/**
 * Email that comes in to the app: invoices@ and reports@ at the restaurant's domain. Pure: which
 * address it was for, whether its sender is one a manager allowed, what's in it (WebstaurantStore's
 * order emails read line by line; anything else as text for the reader), and Gmail's forwarding
 * confirmation code, so a manager can turn forwarding on from the app.
 */

import type { ReadInvoice } from '../connectors/claudeInvoices.ts';

export type InboxKind = 'invoices' | 'reports';

/** invoices@… or reports@… (anything after a + is ignored: invoices+sysco@…). */
export function inboxOf(addresses: readonly string[]): InboxKind | undefined {
  for (const a of addresses) {
    const local = bare(a).split('@')[0]!.split('+')[0]!;
    if (local === 'invoices' || local === 'invoice') return 'invoices';
    if (local === 'reports' || local === 'report' || local === 'otreport') return 'reports';
  }
  return undefined;
}

/** "WebstaurantStore <orders@webstaurantstore.com>" → "orders@webstaurantstore.com". */
export function bare(address: string): string {
  const m = address.match(/<([^>]+)>/);
  return (m ? m[1]! : address).trim().toLowerCase();
}

export interface Sender { address: string; inbox: InboxKind | 'both' }

/**
 * Whether a manager allowed this sender for this inbox: an exact address, or a whole domain written
 * "@vendor.com" (which also takes its subdomains, mail.vendor.com).
 */
export function senderAllowed(from: string, inbox: InboxKind, senders: readonly Sender[]): Sender | undefined {
  const f = bare(from);
  const domain = f.split('@')[1] ?? '';
  return senders.find((s) => (s.inbox === 'both' || s.inbox === inbox) && (s.address.startsWith('@')
    ? domain === s.address.slice(1) || domain.endsWith(`.${s.address.slice(1)}`)
    : s.address === f));
}

/** A sender as a manager types it: an address, or a domain ("vendor.com" or "@vendor.com"). Undefined if it's neither. */
export function cleanSender(v: string): string | undefined {
  const t = v.trim().toLowerCase().replace(/^mailto:/, '');
  if (/^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t)) return t;
  const d = t.replace(/^@/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d)) return `@${d}`;
  return undefined;
}

/** Gmail's "confirm forwarding" email: the code to type into Gmail's settings. */
export function gmailConfirmCode(from: string, subject: string, text: string): string | undefined {
  if (!/forwarding-noreply@google\.com$/.test(bare(from))) return undefined;
  return (`${subject}\n${text}`.match(/Confirmation code:\s*(\d{6,12})/i) ?? `${subject}`.match(/#(\d{6,12})/))?.[1];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', trade: '™', copy: '©' };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all);

/** An HTML email as plain text, for the reader: tables row by row, styles and scripts gone. */
export function htmlToText(html: string): string {
  return decode(html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|h\d|li|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

const money = (s: string | undefined) => (s === undefined ? undefined : Number(s.replace(/[$,\s]/g, '')));

/**
 * WebstaurantStore's "Thanks for your order" email, read exactly: each line's item number, name,
 * quantity, unit price and total, and the order's tax, shipping and total. Undefined when it isn't
 * one, or the lines don't add up to its subtotal (then the reader has a go instead).
 */
export function readWebstaurantEmail(html: string, receivedAt?: string): ReadInvoice | undefined {
  if (!/webstaurant/i.test(html)) return undefined;
  const start = html.indexOf('Start Products'), end = html.indexOf('End Products');
  const seg = start >= 0 && end > start ? html.slice(start, end) : html;
  const rows = [...seg.matchAll(/<b>([\s\S]*?)<\/b>[\s\S]*?<font[^>]*>\s*([0-9A-Za-z-]+)\s*<\/font>[\s\S]*?Item QTY -->\s*([\d.,]+)\s*<\/td>[\s\S]*?Item Price \(individual\) -->\s*(\$[\d,.]+)\s*<\/td>[\s\S]*?Item Price \(total\) -->\s*(\$[\d,.]+)/g)];
  if (!rows.length) return undefined;
  const lines = rows.map((r) => ({ code: r[2]!, description: decode(r[1]!.replace(/\s+/g, ' ').trim()), quantity: Number(r[3]!.replace(/,/g, '')), unitPrice: money(r[4])!, total: money(r[5])! }));
  const after = (label: string) => money(seg.match(new RegExp(`${label}\\s*</td>\\s*<td></td>\\s*<td[^>]*>\\s*(\\$[\\d,.]+)`))?.[1]);
  const subtotal = after('Subtotal'), shipping = after('Shipping'), tax = after('Tax');
  const total = money(seg.match(/Total <span[\s\S]*?<b>(\$[\d,.]+)<\/b>/)?.[1]);
  const sum = Math.round(lines.reduce((a, l) => a + l.total, 0) * 100) / 100;
  if (subtotal !== undefined && Math.abs(sum - subtotal) > 0.01) return undefined;
  const number = html.match(/order_number=3?D?(\d{6,})/)?.[1] ?? html.match(/Order Number:[\s\S]*?(\d{6,})/)?.[1];
  const dateText = htmlToText(html).match(/Order Date:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
  const date = dateText ? new Date(`${dateText} 12:00 UTC`).toISOString().slice(0, 10) : receivedAt?.slice(0, 10);
  return {
    vendor: 'WebstaurantStore', ...(number ? { invoiceNumber: number } : {}), ...(date ? { invoiceDate: date } : {}),
    lines: lines.map((l) => ({ code: l.code, description: l.description, quantity: l.quantity, unit: 'EA', unitPrice: l.unitPrice, total: l.total })),
    ...(tax !== undefined ? { tax } : {}), ...(shipping ? { delivery: shipping } : {}), ...(total !== undefined ? { total } : {}),
    notes: 'From WebstaurantStore’s order email.',
  };
}
