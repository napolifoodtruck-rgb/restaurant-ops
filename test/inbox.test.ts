// Email coming in: who it's for, who may send, WebstaurantStore's order email read line by line,
// Resend's signed webhook, and end to end against a real PostgreSQL with Resend faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cleanSender, gmailConfirmCode, htmlToText, inboxOf, readWebstaurantEmail, senderAllowed } from '../src/core/inboundMail.ts';
import { verifyWebhook } from '../src/connectors/resendInbound.ts';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { startTestDb } from './support/psqlDb.ts';

/** A WebstaurantStore order email, cut down to what matters, as their template lays it out. */
const line = (name: string, code: string, qty: number, each: string, total: string) => `
  <tr><td><a href="#"><img src="x.jpg"></a></td><td><a href="#"><!-- Item Title & Item Number --><b>${name}</b><br>
  <font style="font-size: 10px;">${code}</font><br><font>Estimated Delivery: 3 - 5 days</font></a></td>
  <td><!-- Item QTY -->${qty}</td><td class="desktop--show"><!-- Item Price (individual) -->${each}</td><td><!-- Item Price (total) -->${total}</td></tr>`;
const webstaurant = (lines: string, subtotal: string, tax: string, total: string) => `<html><body>
  <a href="https://www.webstaurantstore.com/trackorder.cfm?order_number=129910929">129910929</a>
  Order Date: <b>August 22, 2026 at 2:45 PM</b>
  <!-- Start Products --><table>${lines}
  <tr><td>Subtotal</td><td></td><td align="right">${subtotal}</td></tr>
  <tr><td>Shipping</td><td></td><td align="right">$0.00</td></tr>
  <tr><td>Tax</td><td></td><td align="right">${tax}</td></tr>
  <tr><td><b>Total <span style="font-size: 11px;">(USD)</span></b></td><td></td><td><font><b>${total}</b></font></td></tr>
  </table><!-- End Products --></body></html>`;
const ORDER = webstaurant(line('Lavex Natural Brown Kraft M-Fold Towel - 4,000/Case', '500MFTN', 1, '$24.49', '$24.49') + line('Carlisle Smart Lid 1/9 Size &quot;Soft&quot; Food Pan Cover', '70090S', 6, '$2.19', '$13.14'), '$37.63', '$2.82', '$40.45');

test('which inbox: invoices@ or reports@, plus-addressing ignored', () => {
  assert.equal(inboxOf(['Napoli <invoices@napolicarrboro.com>']), 'invoices');
  assert.equal(inboxOf(['invoices+sysco@napolicarrboro.com']), 'invoices');
  assert.equal(inboxOf(['someone@else.com', 'reports@napolicarrboro.com']), 'reports');
  assert.equal(inboxOf(['hello@napolicarrboro.com']), undefined);
});

test('only senders a manager listed: an address, or a whole domain', () => {
  const list = [{ address: '@webstaurantstore.com', inbox: 'invoices' as const }, { address: 'napolifoodtruck@gmail.com', inbox: 'both' as const }];
  assert.ok(senderAllowed('WebstaurantStore <orders@webstaurantstore.com>', 'invoices', list));
  assert.ok(senderAllowed('x@mail.webstaurantstore.com', 'invoices', list));
  assert.equal(senderAllowed('orders@webstaurantstore.com', 'reports', list), undefined, 'listed for invoices only');
  assert.equal(senderAllowed('orders@webstaurantstore.com.evil.com', 'invoices', list), undefined);
  assert.ok(senderAllowed('NapoliFoodTruck@gmail.com', 'reports', list));
  assert.equal(cleanSender(' Orders@Vendor.com '), 'orders@vendor.com');
  assert.equal(cleanSender('vendor.com'), '@vendor.com');
  assert.equal(cleanSender('@vendor.com'), '@vendor.com');
  assert.equal(cleanSender('not an address'), undefined);
});

test('Gmail’s forwarding confirmation: the code', () => {
  assert.equal(gmailConfirmCode('Gmail Team <forwarding-noreply@google.com>', '(#123456789) Gmail Forwarding Confirmation - Receive Mail from x', 'Confirmation code: 123456789'), '123456789');
  assert.equal(gmailConfirmCode('someone@else.com', 'Confirmation code: 123456', ''), undefined);
});

test('WebstaurantStore’s order email, line by line, checked against its subtotal', () => {
  const inv = readWebstaurantEmail(ORDER)!;
  assert.equal(inv.vendor, 'WebstaurantStore');
  assert.equal(inv.invoiceNumber, '129910929');
  assert.equal(inv.invoiceDate, '2026-08-22');
  assert.deepEqual(inv.lines.map((l) => [l.code, l.description, l.quantity, l.unitPrice, l.total]), [
    ['500MFTN', 'Lavex Natural Brown Kraft M-Fold Towel - 4,000/Case', 1, 24.49, 24.49],
    ['70090S', 'Carlisle Smart Lid 1/9 Size "Soft" Food Pan Cover', 6, 2.19, 13.14],
  ]);
  assert.deepEqual([inv.tax, inv.total], [2.82, 40.45]);
  // Lines that don't add up to the subtotal: not trusted; the reader has a go instead.
  assert.equal(readWebstaurantEmail(ORDER.replace('$37.63', '$99.00')), undefined);
  assert.equal(readWebstaurantEmail('<p>Thanks from another shop</p>'), undefined);
  assert.match(htmlToText('<style>x{}</style><table><tr><td>A</td><td>B &amp; C</td></tr></table>'), /A B & C/);
});

const SECRET = `whsec_${Buffer.from('a test secret for signing').toString('base64')}`;
const sign = (body: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) => ({
  'svix-id': id, 'svix-timestamp': String(ts),
  'svix-signature': `v1,${createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`,
});

test('Resend’s webhook: signed with the secret, recently', () => {
  const body = '{"type":"email.received"}';
  assert.ok(verifyWebhook(sign(body), body, SECRET));
  assert.ok(!verifyWebhook(sign(body), `${body} `, SECRET), 'the body changed');
  assert.ok(!verifyWebhook(sign(body, 'msg_1', Math.floor(Date.now() / 1000) - 3600), body, SECRET), 'an old one replayed');
  assert.ok(!verifyWebhook({}, body, SECRET));
});

const db = startTestDb();

test('the inbox, end to end', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  await migrate(db!, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  // Resend, faked: the emails it holds, and their attachments.
  const csv = 'Time,Party Size,Guest,Table,Notes and Tags\n5:30 PM,4,Smith,T6,Birthday\n7:00 PM,2,Lee,T2,\n';
  const mails: Record<string, any> = {
    e1: { id: 'e1', from: 'WebstaurantStore <orders@webstaurantstore.com>', to: ['invoices@napolicarrboro.com'], subject: 'Thanks for your order #129910929', html: ORDER, authentication: { dkim: 'pass', dmarc: 'pass', spf: 'pass' } },
    e2: { id: 'e2', from: 'Someone <deals@spam.example>', to: ['invoices@napolicarrboro.com'], subject: 'Cheap stuff', html: '<p>hi</p>' },
    e3: { id: 'e3', from: 'Fake <orders@webstaurantstore.com>', to: ['invoices@napolicarrboro.com'], subject: 'Pay now', html: ORDER, authentication: { dkim: 'fail', dmarc: 'fail' } },
    e4: { id: 'e4', from: 'Gmail Team <forwarding-noreply@google.com>', to: ['reports@napolicarrboro.com'], subject: '(#987654321) Gmail Forwarding Confirmation', text: 'Confirmation code: 987654321' },
    e6: { id: 'e6', from: 'WebstaurantStore <orders@webstaurantstore.com>', to: ['invoices@napolicarrboro.com'], subject: 'Thanks for your order #130000001', authentication: { dkim: 'pass' },
      html: webstaurant(line('Lavex Natural Brown Kraft M-Fold Towel - 4,000/Case', '500MFTN', 2, '$24.49', '$48.98') + line('Carlisle Smart Lid 1/9 Size &quot;Soft&quot; Food Pan Cover', '70090S', 12, '$2.19', '$26.28'), '$75.26', '$5.64', '$80.90').replace(/129910929/g, '130000001') },
    e7: { id: 'e7', from: 'WebstaurantStore <orders@webstaurantstore.com>', to: ['invoices@napolicarrboro.com'], subject: 'Thanks for your order #130000002', authentication: { dkim: 'pass' },
      html: webstaurant(line('Lavex Natural Brown Kraft M-Fold Towel - 4,000/Case', '500MFTN', 1, '$24.49', '$24.49') + line('Choice 16 oz. Kraft Pizza Box', 'PB16K', 50, '$0.50', '$25.00'), '$49.49', '$3.71', '$53.20').replace(/129910929/g, '130000002') },
    e5: { id: 'e5', from: 'Napoli <napolifoodtruck@gmail.com>', to: ['reports@napolicarrboro.com'], subject: 'Fwd: Reservations', text: 'see attached', authentication: { dkim: 'pass', dmarc: 'pass' } },
  };
  const files: Record<string, any[]> = { e5: [{ filename: 'reservations.csv', content_type: 'text/csv', size: csv.length, download_url: 'https://files.example/e5.csv' }] };
  const fakeFetch = async (url: string) => {
    const reply = (data: unknown, body?: string) => ({ ok: true, status: 200, json: async () => data, arrayBuffer: async () => new TextEncoder().encode(body ?? '').buffer as ArrayBuffer });
    if (url === 'https://files.example/e5.csv') return reply({}, csv);
    const m = url.match(/\/emails\/receiving\/([^/]+)(\/attachments)?$/);
    if (m && mails[m[1]!]) return m[2] ? reply({ data: files[m[1]!] ?? [] }) : reply(mails[m[1]!]);
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const app = createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false, inbox: { apiKey: 're_test', webhookSecret: SECRET, fetch: fakeFetch as any, domain: 'napolicarrboro.com' } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = (await (await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'setup-secret', restaurantName: 'Napoli', name: 'Pat', email: 'pat@example.com', password: 'a long enough one' }) })).headers.getSetCookie()).map((c) => c.split(';')[0]).join('; ');
  const call = async (method: string, path: string, body?: object) => {
    const res = await fetch(base + path, { method, headers: { cookie: owner, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const arrive = async (id: string, signed = true) => {
    const body = JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: id } });
    const res = await fetch(`${base}/api/inbound/resend`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signed ? sign(body, `msg_${id}`) : {}) }, body });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };

  // Who may send: managers list them.
  assert.equal((await call('POST', '/api/inbox/senders', { address: 'nope' })).status, 400);
  await call('POST', '/api/inbox/senders', { address: 'webstaurantstore.com', inbox: 'invoices' });
  let inbox = (await call('POST', '/api/inbox/senders', { address: 'napolifoodtruck@gmail.com' })).json;
  assert.deepEqual(inbox.senders, [{ address: '@webstaurantstore.com', inbox: 'invoices' }, { address: 'napolifoodtruck@gmail.com', inbox: 'both' }]);
  assert.deepEqual(inbox.addresses, { invoices: 'invoices@napolicarrboro.com', reports: 'reports@napolicarrboro.com' });
  assert.equal(inbox.connected, true);

  // Not signed: refused, nothing taken.
  assert.equal((await arrive('e1', false)).status, 401);
  // WebstaurantStore's order: read line by line, waiting with the invoices to check.
  assert.equal((await arrive('e1')).json.status, 'read');
  assert.equal((await arrive('e1')).json.detail, 'Already taken.', 'taken once, however many times Resend tries');
  const scan = (await db!.query<{ status: string; result: any }>('SELECT status, result FROM invoice_scans')).rows;
  assert.equal(scan.length, 1);
  assert.equal(scan[0]!.status, 'read');
  assert.equal((typeof scan[0]!.result === 'string' ? JSON.parse(scan[0]!.result) : scan[0]!.result).lines.length, 2);
  // A stranger, and a look-alike that fails the email checks: dropped, and noted.
  assert.equal((await arrive('e2')).json.status, 'dropped');
  assert.match((await arrive('e3')).json.detail, /email checks/);
  // Gmail's forwarding code, kept to show in Settings.
  assert.equal((await arrive('e4')).json.status, 'code');
  // The OpenTable CSV, forwarded from Gmail: straight onto tonight's boards.
  const rep = (await arrive('e5')).json;
  assert.deepEqual([rep.status, rep.detail], ['read', '2 reservations, 6 covers']);
  inbox = (await call('GET', '/api/inbox')).json;
  assert.deepEqual(inbox.emails.map((e: any) => e.status).sort(), ['code', 'dropped', 'dropped', 'read', 'waiting']);
  assert.equal(inbox.emails.find((e: any) => e.status === 'code').code, '987654321');
  // A new vendor waits for one check.
  const first = inbox.emails.find((e: any) => e.status === 'waiting');
  assert.match(first.detail, /New vendor \(WebstaurantStore\)/);

  // Checked once: the vendor is added and both items are learned.
  const ing = async (name: string) => (await call('POST', '/api/ingredients', { name, baseUnit: 'each', type: 'other' })).json.id as string;
  const towels = await ing('Paper towels, M-fold case'), lids = await ing('1/9 pan lids');
  const saved = await call('POST', `/api/invoices/scan/${first.scanId}/save`, { vendor: { name: 'WebstaurantStore' }, date: '2026-08-22', number: '129910929', lines: [
    { productId: towels, quantity: 1, unit: 'each', total: 24.49, description: 'Lavex Natural Brown Kraft M-Fold Towel - 4,000/Case', itemKey: '#500mftn', perQuantity: 1 },
    { productId: lids, quantity: 6, unit: 'each', total: 13.14, description: 'Carlisle Smart Lid', itemKey: '#70090s', perQuantity: 1 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  // The next order, the same two items: counted with no one checking it.
  await arrive('e6');
  inbox = (await call('GET', '/api/inbox')).json;
  const second = inbox.emails.find((e: any) => e.subject.includes('130000001'));
  assert.equal(second.status, 'counted', second.detail);
  assert.equal(second.scanStatus, 'saved');
  const counted = (await db!.query<{ number: string; note: string; created_by: string | null; lines: string; total: string }>(
    "SELECT number, note, created_by, (SELECT count(*) FROM supplier_invoice_lines l WHERE l.invoice_id = i.id)::text AS lines, (SELECT sum(quantity) FROM supplier_invoice_lines l WHERE l.invoice_id = i.id)::text AS total FROM supplier_invoices i WHERE i.id = $1", [second.invoiceId])).rows[0]!;
  assert.deepEqual([counted.number, counted.note, counted.created_by, counted.lines, Number(counted.total)], ['130000001', 'Counted automatically from an email.', null, '2', 14]);
  // One with an item never seen before waits, saying which.
  await arrive('e7');
  const third = (await call('GET', '/api/inbox')).json.emails.find((e: any) => e.subject.includes('130000002'));
  assert.deepEqual([third.status, third.scanStatus], ['waiting', 'read']);
  assert.match(third.detail, /1 new item/);
  // Removing a sender.
  inbox = (await call('POST', '/api/inbox/senders', { address: '@webstaurantstore.com', remove: true })).json;
  assert.deepEqual(inbox.senders.map((s: any) => s.address), ['napolifoodtruck@gmail.com']);
});
