/**
 * The app's email inbox: invoices@ and reports@ at the restaurant's domain, received through Resend.
 *
 *   POST /api/inbound/resend        Resend's webhook (public, signed): an email arrived
 *   GET  /api/inbox                 managers: the addresses, who may send, the last emails and what became of them
 *   POST /api/inbox/senders         { address, inbox?: 'invoices' | 'reports' | 'both' } or { address, remove: true }
 *
 * Only senders a manager listed are taken, and only when the email passes its checks (DKIM or
 * DMARC): anything else is noted and dropped. Invoices are read by the same reader as photos (a PDF
 * attached, else the email's own text); from a vendor we know whose lines were all matched before
 * they count on their own, the rest land with the photos to check; OpenTable reports land on tonight's boards (the CSV export straight in, a PDF or the email
 * itself read). Gmail's forwarding confirmation is kept, so its code shows in Settings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { autoCount, readScan } from './invoiceScans.ts';
import { readReport } from './floor.ts';
import { localNow } from './online.ts';
import { readOpenTableCsv } from '../core/reservations.ts';
import { bare, cleanSender, gmailConfirmCode, htmlToText, inboxOf, senderAllowed, type InboxKind, type Sender } from '../core/inboundMail.ts';
import { ResendInbound, verifyWebhook, type Fetch } from '../connectors/resendInbound.ts';

export interface InboxSettings {
  /** Resend's API key (the one order confirmations use). */
  apiKey?: string;
  /** The webhook's signing secret, from Resend's webhook page (RESEND_WEBHOOK_SECRET). */
  webhookSecret?: string;
  /** The restaurant's email domain: invoices@ and reports@ it. */
  domain?: string;
  fetch?: Fetch;
  baseUrl?: string;
  now?: () => number;
  /** Count an invoice on its own even when the restaurant's setting is off (tests). */
  autoCount?: boolean;
}

const PDF = /application\/pdf/, CSV = /text\/csv|application\/vnd\.ms-excel|\.csv$/i, IMAGE = /^image\/(jpeg|png|webp)$/;

async function readRaw(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new HttpError(413, 'Too big.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendersOf(db: Db, rid: string): Promise<Sender[]> {
  return (await db.query<{ address: string; inbox: Sender['inbox'] }>('SELECT address, inbox FROM inbox_senders WHERE restaurant_id = $1 ORDER BY address', [rid])).rows;
}

/** An email Resend says arrived: fetched, checked, and turned into an invoice to check or tonight's book. */
export async function takeEmail(db: Db, settings: InboxSettings, emailId: string): Promise<{ status: string; detail?: string }> {
  const rid = (await db.query<{ id: string; timezone: string }>('SELECT id, timezone FROM restaurants ORDER BY created_at LIMIT 1')).rows[0];
  if (!rid) return { status: 'dropped', detail: 'No restaurant.' };
  // Taken once, however many times Resend tries.
  const seen = (await db.query<{ status: string }>('SELECT status FROM inbox_emails WHERE provider_id = $1', [emailId])).rows[0];
  if (seen) return { status: seen.status, detail: 'Already taken.' };
  const resend = new ResendInbound(settings.apiKey!, { ...(settings.fetch ? { fetch: settings.fetch } : {}), ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}) });
  const mail = await resend.email(emailId);
  const from = bare(mail.from);
  const text = mail.text ?? (mail.html ? htmlToText(mail.html) : '');
  const note = async (status: string, extra: { inbox?: string; detail?: string; scanId?: string; reportId?: string; code?: string } = {}) => {
    await db.query(`INSERT INTO inbox_emails (restaurant_id, provider_id, inbox, from_address, subject, status, detail, scan_id, report_id, code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (provider_id) DO NOTHING`,
      [rid.id, emailId, extra.inbox ?? null, from, mail.subject.slice(0, 300), status, extra.detail ?? null, extra.scanId ?? null, extra.reportId ?? null, extra.code ?? null]);
    return { status, ...(extra.detail ? { detail: extra.detail } : {}) };
  };

  // Gmail asks the new address to confirm forwarding: the code is shown in Settings.
  const code = gmailConfirmCode(mail.from, mail.subject, text);
  if (code) return note('code', { code, detail: 'Gmail’s forwarding confirmation' });

  const inbox = inboxOf(mail.to);
  if (!inbox) return note('dropped', { detail: `Not for invoices@ or reports@ (${mail.to.join(', ')})` });
  if (!senderAllowed(mail.from, inbox, await sendersOf(db, rid.id))) return note('dropped', { inbox, detail: 'Sender not on the list. Add it in Settings → Email inbox.' });
  // Checked by the sender's own mail server: a look-alike From line doesn't get in.
  const auth = mail.authentication;
  if (auth && auth.dkim !== 'pass' && auth.dmarc !== 'pass') return note('dropped', { inbox, detail: 'Failed the email checks (DKIM and DMARC), so it may not be from who it says.' });

  const files = await resend.attachments(emailId).catch(() => []);
  if (inbox === 'reports') return takeReport(db, rid, files, text, mail.subject, (s, x) => note(s, { inbox, ...x }));
  // An invoice email's own layout (its HTML tables), as text for the reader.
  return takeInvoice(db, rid.id, files, mail.html ? htmlToText(mail.html) : text, Boolean(settings.autoCount), (s, x) => note(s, { inbox, ...x }));
}

type Note = (status: string, extra?: { detail?: string; scanId?: string; reportId?: string }) => Promise<{ status: string; detail?: string }>;

async function takeReport(db: Db, r: { id: string; timezone: string }, files: { filename: string; contentType: string; data: Buffer }[], text: string, subject: string, note: Note) {
  const today = localNow(r.timezone).date;
  const csv = files.find((f) => CSV.test(f.contentType) || CSV.test(f.filename));
  if (csv) {
    let book;
    try { book = readOpenTableCsv(csv.data.toString('utf8')); } catch (err) { return note('failed', { detail: (err as Error).message }); }
    const row = await db.query<{ id: string }>("INSERT INTO floor_reports (restaurant_id, day, source, as_of, status, result) VALUES ($1, $2, 'csv', now(), 'read', $3) RETURNING id", [r.id, today, JSON.stringify({ book, asOf: new Date().toISOString() })]);
    return note('read', { reportId: row.rows[0]!.id, detail: `${book.reservations.length} reservations, ${book.covers ?? 0} covers` });
  }
  const pdf = files.find((f) => PDF.test(f.contentType));
  const [data, media] = pdf ? [pdf.data, 'application/pdf'] : [Buffer.from(`${subject}\n\n${text}`, 'utf8'), 'text/plain'];
  if (!pdf && text.length < 40) return note('dropped', { detail: 'No report in it: no CSV, no PDF, no text.' });
  const row = await db.query<{ id: string }>("INSERT INTO floor_reports (restaurant_id, day, source, file, media_type) VALUES ($1, $2, 'digest', $3, $4) RETURNING id", [r.id, today, data, media]);
  void readReport(db, row.rows[0]!.id);
  return note('reading', { reportId: row.rows[0]!.id, detail: pdf ? 'Reading the PDF' : 'Reading the email' });
}

/**
 * Every invoice goes through the same reader, whatever way it came (a photo, a PDF, an order email's
 * text), so the same invoice reads, names and matches the same.
 */
async function takeInvoice(db: Db, rid: string, files: { filename: string; contentType: string; data: Buffer }[], text: string, auto: boolean, note: Note) {
  // A PDF (or photos) attached: the pages, read like a photographed invoice. No attachment: the email's text.
  const pages = files.filter((f) => PDF.test(f.contentType) || IMAGE.test(f.contentType)).slice(0, 8).map((f) => ({ media: PDF.test(f.contentType) ? 'application/pdf' : f.contentType, data: f.data }));
  if (!pages.length) {
    if (text.length < 40) return note('dropped', { detail: 'No invoice in it: no PDF, no text.' });
    pages.push({ media: 'text/plain', data: Buffer.from(text, 'utf8') });
  }
  const scan = await db.query<{ id: string }>('INSERT INTO invoice_scans (restaurant_id) VALUES ($1) RETURNING id', [rid]);
  const id = scan.rows[0]!.id;
  for (const [n, p] of pages.entries()) await db.query('INSERT INTO invoice_scan_pages (scan_id, page, media_type, data) VALUES ($1, $2, $3, $4)', [id, n + 1, p.media, p.data]);
  const out = await note('reading', { scanId: id, detail: `Reading ${pages[0]!.media === 'text/plain' ? 'the email' : `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`}` });
  void readScan(db, rid, id, () => countOrWait(db, rid, id, auto));
  return out;
}

/**
 * Once read: counted on its own when the vendor is one we know and every line was matched before
 * (no one needs to check it), else it waits with the others to check, saying why.
 */
export async function countOrWait(db: Db, rid: string, scanId: string, forced = false): Promise<void> {
  // A manager's setting (Invoices): save one that's all green without a check. Off by default.
  const auto = forced || ((await db.query<{ on: boolean }>('SELECT invoice_autocount AS on FROM restaurants WHERE id = $1', [rid])).rows[0]?.on ?? false);
  const scan = (await db.query<{ status: string; error: string | null; vendor: string | null; total: string | null }>("SELECT status, error, result->>'vendor' AS vendor, result->>'total' AS total FROM invoice_scans WHERE id = $1", [scanId])).rows[0];
  if (!scan) return;
  if (scan.status === 'failed') {
    await db.query("UPDATE inbox_emails SET status = 'failed', detail = $2 WHERE scan_id = $1", [scanId, scan.error ?? 'Couldn’t read it.']);
    return;
  }
  const r = await autoCount(db, rid, scanId, { save: auto }).catch((err) => { console.error(`[inbox] counting ${scanId}`, err); return { counted: false, ready: false, why: 'Couldn’t count it on its own: check it.' }; });
  const what = `${scan.vendor ?? 'Invoice'}${scan.total ? `, $${Number(scan.total).toFixed(2)}` : ''}`;
  await db.query('UPDATE inbox_emails SET status = $2, detail = $3 WHERE scan_id = $1', [scanId, r.counted ? 'counted' : 'waiting', r.counted ? `${what}: counted` : `${what} — ${r.ready ? 'everything matched: check it and save' : r.why ?? 'to check'}`]);
}

export function inboxRoutes(db: Db, settings: InboxSettings = {}) {
  return async function route(req: IncomingMessage, res: ServerResponse, path: string, who?: SignedIn): Promise<boolean> {
    if (path === '/api/inbound/resend' && req.method === 'POST') {
      const raw = await readRaw(req);
      if (!settings.webhookSecret || !settings.apiKey) throw new HttpError(503, 'The inbox isn’t set up.');
      if (!verifyWebhook(req.headers, raw, settings.webhookSecret, settings.now?.() ?? Date.now())) throw new HttpError(401, 'Not signed by Resend.');
      let event: any;
      try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Not JSON.'); }
      if (event?.type !== 'email.received' || !event.data?.email_id) return send(res, 200, { ignored: true }), true;
      try {
        return send(res, 200, await takeEmail(db, settings, String(event.data.email_id))), true;
      } catch (err) {
        console.error('[inbox]', err);
        // Resend tries again later on an error: fine, the email is taken once.
        throw new HttpError(502, 'Couldn’t take it just now.');
      }
    }
    if (!path.startsWith('/api/inbox')) return false;
    if (!who || !atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
    const rid = who.restaurantId;
    if (req.method === 'POST' && path === '/api/inbox/senders') {
      const b = await body(req);
      const address = cleanSender(String(b.address ?? ''));
      if (!address) throw new HttpError(400, 'An email address (orders@vendor.com) or a whole domain (@vendor.com).');
      if (b.remove === true) await db.query('DELETE FROM inbox_senders WHERE restaurant_id = $1 AND address = $2', [rid, address]);
      else {
        const inbox = ['invoices', 'reports', 'both'].includes(String(b.inbox)) ? String(b.inbox) : 'both';
        await db.query('INSERT INTO inbox_senders (restaurant_id, address, inbox, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (restaurant_id, address) DO UPDATE SET inbox = EXCLUDED.inbox', [rid, address, inbox, who.staffId]);
      }
    } else if (req.method !== 'GET' || path !== '/api/inbox') throw new HttpError(404, 'Not found.');
    const emails = (await db.query(`SELECT e.id, e.received_at AS "receivedAt", e.inbox, e.from_address AS "from", e.subject, e.status, e.detail, e.scan_id AS "scanId", e.report_id AS "reportId", e.code, s.invoice_id AS "invoiceId", s.status AS "scanStatus"
       FROM inbox_emails e LEFT JOIN invoice_scans s ON s.id = e.scan_id WHERE e.restaurant_id = $1 ORDER BY e.received_at DESC LIMIT 30`, [rid])).rows;
    const domain = settings.domain ?? 'napolicarrboro.com';
    return send(res, 200, {
      connected: Boolean(settings.apiKey && settings.webhookSecret),
      addresses: { invoices: `invoices@${domain}`, reports: `reports@${domain}` },
      senders: await sendersOf(db, rid),
      emails,
    }), true;
  };
}

export type { InboxKind };
