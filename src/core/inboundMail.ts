/**
 * Email that comes in to the app: invoices@ and reports@ at the restaurant's domain. Pure: which
 * address it was for, whether its sender is one a manager allowed, an HTML email as text for the
 * reader, and Gmail's forwarding
 * confirmation code, so a manager can turn forwarding on from the app.
 */

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
