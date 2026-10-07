import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationEmail, tidy } from '../src/core/orderConfirmation.ts';
import { emailSender } from '../src/connectors/email.ts';

const order = { id: 'abcdef12-0000-0000-0000-000000000000', restaurant: 'Napoli', name: '<b>Ada</b> Lovelace', pickup: '6:20 pm', lines: [{ quantity: 1, name: 'MARGHERITA', total: 1500, isPizza: true, modifiers: [{ name: 'PARTIALLY COOKED (ONLY OPTION ONLINE)' }, { name: '++ Extra Mozzarella' }] }], subtotal: 1500, tax: 113, tip: 0, total: 1613, receiptUrl: 'https://squareup.com/receipt/r?a=1&b=2' };

test('the confirmation email', () => {
  const e = confirmationEmail(order);
  assert.equal(e.subject, 'Your Napoli order: pickup today at 6:20 pm');
  assert.match(e.text, /Order ABCDEF12, under the name <b>Ada<\/b> Lovelace/);
  assert.match(e.text, /1 × Margherita  \$15\.00\n   Partially cooked, Extra Mozzarella/);
  assert.match(e.text, /Tax: \$1\.13\nTotal paid: \$16\.13/);
  assert.doesNotMatch(e.text, /Tip:/);
  assert.match(e.text, /4\. Add any finishing toppings\./);
  // Names from the order can't add markup.
  assert.match(e.html, /Thank you, &lt;b&gt;Ada&lt;\/b&gt;!/);
  assert.match(e.html, /href="https:\/\/squareup\.com\/receipt\/r\?a=1&amp;b=2"/);
  // Drinks only: nothing about finishing pizzas.
  const drinks = confirmationEmail({ ...order, lines: [{ quantity: 2, name: 'Soda', total: 600, isPizza: false, modifiers: [] }], receiptUrl: null });
  assert.doesNotMatch(drinks.html, /partially cooked|receipt/i);
  assert.equal(tidy('-- NO BASIL'), 'No basil');
});

test('sending through Resend', async () => {
  assert.equal(emailSender({}), undefined);
  assert.equal(emailSender({ apiKey: 'later', from: 'x@y.z' }), undefined);
  assert.equal(emailSender({ apiKey: 're_1' }), undefined);
  const calls: { url: string; init: any }[] = [];
  const send = emailSender({ apiKey: 're_1', from: 'Napoli <o@napoli.test>', replyTo: 'hi@napoli.test', fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200, json: async () => ({}), text: async () => '' }) })!;
  await send('ada@example.com', confirmationEmail(order), 'order-confirmation/1');
  const b = JSON.parse(calls[0]!.init.body);
  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  assert.deepEqual([calls[0]!.init.headers.authorization, calls[0]!.init.headers['idempotency-key'], b.from, b.to, b.reply_to], ['Bearer re_1', 'order-confirmation/1', 'Napoli <o@napoli.test>', ['ada@example.com'], 'hi@napoli.test']);
  const failing = emailSender({ apiKey: 're_1', from: 'o@napoli.test', fetch: async () => ({ ok: false, status: 422, json: async () => ({}), text: async () => 'bad from' }) })!;
  await assert.rejects(failing('a@b.c', confirmationEmail(order), 'k'), /Resend 422: bad from/);
});
