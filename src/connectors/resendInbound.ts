/**
 * Email coming in through Resend: its webhook says an email arrived (signed the Svix way), then the
 * email itself and its attachments are fetched with the API key the order confirmations already use.
 * Read only: nothing is sent from here.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Whether a webhook really came from Resend: HMAC-SHA256 of "id.timestamp.body" with the signing
 * secret (base64 after "whsec_"), matching one of the "v1,…" signatures, sent within five minutes.
 */
export function verifyWebhook(headers: Record<string, string | string[] | undefined>, body: string, secret: string, now = Date.now()): boolean {
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const id = h('svix-id'), ts = h('svix-timestamp'), sigs = h('svix-signature');
  if (!id || !ts || !sigs || !secret) return false;
  if (!/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((s) => {
    const [v, sig] = s.split(',');
    if (v !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  createdAt?: string;
  /** SPF, DKIM, DMARC as Resend checked them: "pass", "fail"... */
  authentication?: Record<string, string>;
}

export interface ReceivedAttachment { filename: string; contentType: string; data: Buffer }

export class ResendInbound {
  readonly #key: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  constructor(key: string, opts: { fetch?: Fetch; baseUrl?: string } = {}) {
    this.#key = key;
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.#base = opts.baseUrl ?? 'https://api.resend.com';
  }

  async #get(path: string): Promise<any> {
    const res = await this.#fetch(this.#base + path, { method: 'GET', headers: { authorization: `Bearer ${this.#key}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Resend GET ${path.split('?')[0]} failed (${res.status})`);
    return res.json();
  }

  /** The email as received: who from, to whom, the subject, the body. */
  async email(id: string): Promise<ReceivedEmail> {
    const d = await this.#get(`/emails/receiving/${encodeURIComponent(id)}`);
    const auth = d.authentication && typeof d.authentication === 'object'
      ? Object.fromEntries(Object.entries(d.authentication).map(([k, v]: [string, any]) => [k, String(typeof v === 'object' && v ? v.result ?? v.status ?? '' : v).toLowerCase()])) : undefined;
    return {
      id: String(d.id ?? id), from: String(d.from ?? ''), to: Array.isArray(d.to) ? d.to.map(String) : d.to ? [String(d.to)] : [],
      subject: String(d.subject ?? ''), ...(typeof d.html === 'string' ? { html: d.html } : {}), ...(typeof d.text === 'string' ? { text: d.text } : {}),
      ...(d.created_at ? { createdAt: String(d.created_at) } : {}), ...(auth ? { authentication: auth } : {}),
    };
  }

  /** Its attachments, downloaded (PDFs, CSVs, photos); at most ten, none over 15 MB. */
  async attachments(id: string): Promise<ReceivedAttachment[]> {
    const d = await this.#get(`/emails/receiving/${encodeURIComponent(id)}/attachments`);
    const out: ReceivedAttachment[] = [];
    for (const a of (Array.isArray(d.data) ? d.data : []).slice(0, 10)) {
      if (!a?.download_url || Number(a.size ?? 0) > 15 * 1024 * 1024) continue;
      const res = await this.#fetch(String(a.download_url), { method: 'GET' });
      if (!res.ok) continue;
      out.push({ filename: String(a.filename ?? 'attachment'), contentType: String(a.content_type ?? 'application/octet-stream').toLowerCase(), data: Buffer.from(await res.arrayBuffer()) });
    }
    return out;
  }
}
