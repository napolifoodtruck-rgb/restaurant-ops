import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRead, readInvoice } from '../src/connectors/claudeInvoices.ts';
import { itemKey, matchInvoice, parsePack, vendorKey, type MatchInput } from '../src/core/invoiceMatch.ts';

test('packs as printed', () => {
  assert.deepEqual(parsePack('6/5 LB'), { amount: 30, unit: 'lb' });
  assert.deepEqual(parsePack('4/1 GAL'), { amount: 4, unit: 'gal' });
  assert.deepEqual(parsePack('12/750ML'), { amount: 9000, unit: 'ml' });
  assert.deepEqual(parsePack('50#'), { amount: 50, unit: 'lb' });
  assert.equal(parsePack('CASE'), undefined);
  assert.equal(vendorKey('Homeland Creamery, LLC'), 'homeland creamery');
  assert.equal(itemKey({ code: 'A 123', description: 'x' }), '#a123');
});

test('the reader sends the pages and reads back one tool call', async () => {
  let sent: any;
  const fetch = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'record_invoice', input: { vendor: 'Produce Co', invoiceNumber: 'A-9', invoiceDate: '2026-10-07', lines: [{ description: 'BASIL', quantity: '2', unit: 'CS', pack: '1 LB', unitPrice: 12, total: 24 }, { description: '' , quantity: 1, total: 1 }], total: '$24.00' } }], usage: { input_tokens: 5000, output_tokens: 400 } }) };
  }) as any;
  const r = await readInvoice([{ mediaType: 'image/jpeg', data: Buffer.from('jpegdata') }], { apiKey: 'k', fetch, vendors: ['Produce Co'] });
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.deepEqual([sent.tool_choice.name, sent.messages[0].content[0].type, sent.messages[0].content[0].source.media_type], ['record_invoice', 'image', 'image/jpeg']);
  assert.match(sent.messages[0].content.at(-1).text, /Produce Co/);
  assert.deepEqual(r.invoice, { vendor: 'Produce Co', invoiceNumber: 'A-9', invoiceDate: '2026-10-07', lines: [{ description: 'BASIL', quantity: 2, unit: 'CS', pack: '1 LB', unitPrice: 12, total: 24 }], total: 24 });
  assert.deepEqual(r.usage, { input: 5000, output: 400 });
  const failing = (async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) })) as any;
  await assert.rejects(readInvoice([{ mediaType: 'image/jpeg', data: Buffer.from('x') }], { apiKey: 'bad', fetch: failing }), /invalid x-api-key/);
  assert.deepEqual(cleanRead({ vendor: 'X', invoiceDate: 'Oct 7', lines: [] }), { vendor: 'X', lines: [] });
});

const base = (over: Partial<MatchInput> = {}): MatchInput => ({
  read: { vendor: 'PRODUCE CO.', invoiceNumber: 'A-9', invoiceDate: '2026-10-07', lines: [
    { code: '1001', description: 'BASIL FRESH', quantity: 2, unit: 'CS', pack: '1 LB', unitPrice: 12, total: 24 },
    { description: 'TOMATOES ROMA', quantity: 1, unit: 'CS', pack: '25 LB', unitPrice: 30, total: 30 },
    { description: 'MOZZ FRESH', quantity: 3, unit: 'LB', unitPrice: 5, total: 16 },
    { description: 'MYSTERY ITEM', quantity: 1, total: 4, unsure: true },
  ], total: 80 },
  vendors: [{ key: 'v-produce', name: 'Produce Co' }],
  history: [{ vendorKey: 'v-produce', code: '1001', description: 'BASIL 1LB', productId: 'p-basil', perQuantity: 1, unitPrice: 11, date: '2026-09-01' }],
  learned: new Map(),
  products: [{ id: 'p-basil', name: 'Basil, Fresh', baseUnit: 'lb' }, { id: 'p-tom', name: 'Tomatoes, Roma', baseUnit: 'lb' }, { id: 'p-mozz', name: 'Mozzarella, Fresh', baseUnit: 'lb' }],
  baseOf: (_id, unit) => (unit === 'lb' ? 1 : unit === 'oz' ? 1 / 16 : undefined),
  priceNow: (id) => ({ 'p-basil': 11, 'p-tom': 1.1, 'p-mozz': 5 } as Record<string, number>)[id],
  invoices: [],
  ...over,
});

test('lines matched by history, pack, name and unit; checks flagged', () => {
  const m = matchInvoice(base());
  assert.deepEqual(m.vendor, { key: 'v-produce', name: 'Produce Co', how: 'known' });
  const [basil, tom, mozz, mystery] = m.lines;
  assert.deepEqual([basil!.how, basil!.productId, basil!.baseQuantity, basil!.perBase, basil!.flags], ['history', 'p-basil', 2, 12, []]);
  assert.deepEqual([tom!.how, tom!.productId, tom!.perFrom, tom!.baseQuantity, tom!.perBase], ['guess', 'p-tom', 'pack', 25, 1.2]);
  // Mozzarella: by name, weighed by the pound; 3 × $5 isn't $16.
  assert.deepEqual([mozz!.productId, mozz!.perFrom, mozz!.baseQuantity, mozz!.flags], ['p-mozz', 'unit', 3, ['math']]);
  assert.deepEqual([mystery!.how, mystery!.flags], ['none', ['unsure', 'noProduct']]);
  assert.equal(m.totalDifference, 6); // 80 printed, 74 in lines
  // A learned answer wins over history, and a jump in price is flagged.
  const learned = matchInvoice(base({ learned: new Map([['v-produce|#1001', { productId: 'p-basil', per: 0.5 }]]) }));
  assert.deepEqual([learned.lines[0]!.how, learned.lines[0]!.baseQuantity, learned.lines[0]!.perBase, learned.lines[0]!.flags], ['learned', 1, 24, ['priceJump']]);
});

test('an invoice MarginEdge already has is spotted', () => {
  const m = matchInvoice(base({ invoices: [{ externalId: 'me-1', source: 'marginedge', vendorKey: 'v-produce', number: 'A9', date: '2026-10-07', total: 80 }] }));
  assert.deepEqual(m.duplicateOf, { externalId: 'me-1', number: 'A9', date: '2026-10-07', source: 'marginedge' });
  assert.equal(matchInvoice(base({ read: { ...base().read, vendor: 'Someone New' } })).vendor.how, 'new');
});

test('a page sent again: lines already saved are marked; hand corrections flagged', () => {
  const read = { ...base().read, lines: [{ ...base().read.lines[0]!, handwritten: 'qty 3 → 2' }, base().read.lines[1]!] };
  const m = matchInvoice(base({ read, invoices: [{ externalId: 'inv-1', source: 'app', vendorKey: 'v-produce', number: 'A-9', total: 80, lines: [{ description: 'Basil fresh', total: 24 }] }] }));
  assert.equal(m.duplicateOf?.source, 'app');
  assert.deepEqual(m.lines.map((l) => l.flags), [['handwritten', 'alreadyIn'], []]);
});
