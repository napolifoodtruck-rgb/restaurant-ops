/**
 * Reads an invoice from photos (or a PDF) with Claude, through Anthropic's Messages API: the
 * pages go in with the vendors we know, and what comes back is filled into one tool call, so the
 * answer is always the same shape. Nothing else is sent: no prices, no sales, no staff.
 *
 * The key is ANTHROPIC_API_KEY (Render's settings); the model is Sonnet unless set otherwise.
 */

export interface ReadLine {
  /** The vendor's item code, when the invoice shows one. */
  code?: string;
  description: string;
  /** How many of the unit sold were delivered (negative for a credit or return). */
  quantity: number;
  /** What one of `quantity` is on the invoice: "CS", "LB", "EA", "BAG"... */
  unit?: string;
  /** Pack as printed: "6/5 LB", "4/1 GAL", "25 LB". */
  pack?: string;
  unitPrice?: number;
  total: number;
  /** True when the reader wasn't sure of a number on this line. */
  unsure?: boolean;
  /** A handwritten change applied to this line, in a few words ("shorted 1 cs", "qty 2 → 1"). */
  handwritten?: string;
  /** What it is, as an ingredient list would name it: no brand, no size ("Star anise, whole"). */
  item?: string;
  /** Food, a drink, or supplies: for a new ingredient. */
  kind?: 'food' | 'wine' | 'beer' | 'liquor' | 'na' | 'other';
}

export interface ReadInvoice {
  vendor: string;
  invoiceNumber?: string;
  /** YYYY-MM-DD */
  invoiceDate?: string;
  lines: ReadLine[];
  tax?: number;
  delivery?: number;
  otherCharges?: number;
  total?: number;
  /** Anything a manager should know: a handwritten change, a missing page, a smudge. */
  notes?: string;
}

import { askWithTool, DEFAULT_MODEL, ReaderError } from './claude.ts';

export interface ReadPage { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | 'text/plain'; data: Buffer }

export interface ReaderOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Vendors we already know, so the name comes back the way we write it. */
  vendors?: string[];
  /** Anthropic's API unless set (a stand-in for trying it out locally). */
  baseUrl?: string;
}

export { DEFAULT_MODEL, ReaderError } from './claude.ts';

/** How a line's ingredient is named and sorted: the same rule whether it came in a photo, a PDF or an email. */
const ITEM_NAME_RULE = 'The pure ingredient name: the plain thing first, then at most a word or two that matters ("Cinnamon, sticks", "Star anise, whole", "Salt, sea", "Mozzarella, fresh", "Towels, paper M-fold"). Never a brand, size, pack, count, grade or marketing word ("Regal", "Acopa", "Bulk", "Fine", "7 oz", "6/Case", "Premium").';
const KIND_RULE = 'food; wine, beer, liquor or na (non-alcoholic drink); other for supplies, packaging, cleaning, equipment.';
const KINDS = ['food', 'wine', 'beer', 'liquor', 'na', 'other'] as const;

const TOOL = {
  name: 'record_invoice',
  description: 'Record everything printed on this supplier invoice, exactly as printed.',
  input_schema: {
    type: 'object',
    required: ['vendor', 'lines'],
    properties: {
      vendor: { type: 'string', description: 'The supplier that issued the invoice. If it is one of the known vendors, use that exact name.' },
      invoiceNumber: { type: 'string' },
      invoiceDate: { type: 'string', description: 'Delivery or invoice date, YYYY-MM-DD.' },
      lines: {
        type: 'array',
        description: 'Every product line, in order. Not subtotals, tax, delivery or deposit summary rows.',
        items: {
          type: 'object',
          required: ['description', 'quantity', 'total'],
          properties: {
            code: { type: 'string', description: "The supplier's item number, if printed." },
            description: { type: 'string', description: 'The item description as printed.' },
            quantity: { type: 'number', description: 'Quantity shipped/delivered (not ordered). Negative for credits and returns.' },
            unit: { type: 'string', description: 'Unit the quantity is in, as printed (CS, LB, EA, BAG, GAL...).' },
            pack: { type: 'string', description: 'Pack or size as printed, e.g. "6/5 LB", "4/1 GAL", "25 LB", "12/750ML".' },
            unitPrice: { type: 'number' },
            total: { type: 'number', description: 'Extended price for the line. Negative for credits.' },
            unsure: { type: 'boolean', description: 'True if any number on this line was hard to read.' },
            item: { type: 'string', description: ITEM_NAME_RULE },
            kind: { type: 'string', enum: [...KINDS], description: KIND_RULE },
            handwritten: { type: 'string', description: 'If a handwritten mark changes this line (crossed out, shorted, a new quantity or price), what it says in a few words, e.g. "shorted 1 cs" or "qty 2 → 1". The quantity and total fields then hold the corrected numbers. Leave out when nothing is handwritten.' },
          },
        },
      },
      tax: { type: 'number' },
      delivery: { type: 'number', description: 'Delivery, fuel or freight charges.' },
      otherCharges: { type: 'number', description: 'Other charges such as deposits or fees, summed.' },
      total: { type: 'number', description: 'Invoice total due.' },
      notes: { type: 'string', description: 'Handwritten changes, crossed-out lines, missing pages, anything unclear.' },
    },
  },
} as const;

/** Reads one invoice (one or more pages). Returns what was read, and the tokens used. */
export async function readInvoice(pages: readonly ReadPage[], opts: ReaderOptions): Promise<{ invoice: ReadInvoice; usage: { input: number; output: number }; model: string }> {
  if (!pages.length) throw new ReaderError('No pages.');
  const model = opts.model ?? DEFAULT_MODEL;
  const prompt = [
    `This is a supplier invoice for a restaurant${pages.length > 1 ? `, ${pages.length} pages in order` : ''}. Record it with record_invoice.`,
    'Copy numbers exactly as printed; do not correct or compute them. Use the quantity actually shipped or delivered.',
    'If a line\'s printed total includes tax (a per-line tax column), record that line\'s total before tax (unit price × quantity) and the tax once, in tax.',
    'Include every product line, credits and returns as negative lines. Leave out subtotal, tax, delivery and deposit summary rows from lines (put them in their own fields).',
    'Handwritten corrections (a crossed-out quantity, "short 1", a refused item) change the line only when they are clear: then record the corrected quantity and total and say what changed in handwritten. If a mark is unclear, keep the printed numbers, set unsure, and describe the mark in notes.',
    'If two images show the same page, record its lines once and say so in notes. If a page seems to be missing (page 1 of 2 with no page 2, totals carried forward), say so in notes.',
    opts.vendors?.length ? `Known vendors (use the exact name if it is one of these): ${opts.vendors.join('; ')}.` : '',
  ].filter(Boolean).join('\n');
  const answer = await askWithTool(pages, prompt, TOOL, { ...opts, maxTokens: 8000 }, 'The invoice reader');
  return { invoice: cleanRead(answer.input), usage: answer.usage, model };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined);

/** What came back, tidied: numbers as numbers, blanks dropped, a date only if it's a date. */
export function cleanRead(input: any): ReadInvoice {
  const lines: ReadLine[] = (Array.isArray(input?.lines) ? input.lines : []).map((l: any) => {
    const quantity = num(l?.quantity), total = num(l?.total), description = str(l?.description);
    if (quantity === undefined || total === undefined || !description) return undefined;
    const line: ReadLine = { description, quantity, total };
    const code = str(l.code), unit = str(l.unit), pack = str(l.pack), unitPrice = num(l.unitPrice);
    if (code) line.code = code;
    if (unit) line.unit = unit;
    if (pack) line.pack = pack;
    if (unitPrice !== undefined) line.unitPrice = unitPrice;
    if (l.unsure === true) line.unsure = true;
    if (str(l.handwritten)) line.handwritten = str(l.handwritten)!;
    if (str(l.item)) line.item = str(l.item)!.slice(0, 80);
    if (KINDS.includes(l.kind)) line.kind = l.kind;
    return line;
  }).filter(Boolean);
  const date = str(input?.invoiceDate);
  const out: ReadInvoice = { vendor: str(input?.vendor) ?? '', lines };
  if (str(input?.invoiceNumber)) out.invoiceNumber = str(input.invoiceNumber)!;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.invoiceDate = date;
  for (const k of ['tax', 'delivery', 'otherCharges', 'total'] as const) { const v = num(input?.[k]); if (v !== undefined) out[k] = v; }
  if (str(input?.notes)) out.notes = str(input.notes)!;
  return foldLineTax(out);
}

/**
 * Some invoices (WebstaurantStore's) print each line's total with its tax already in, then the tax
 * again below. When every line is its price × quantity plus a share of the tax, and those shares
 * come to the tax, the lines are taken before tax, so the tax counts once.
 */
export function foldLineTax(inv: ReadInvoice): ReadInvoice {
  const tax = inv.tax ?? 0;
  if (!(tax > 0) || !inv.lines.length || inv.lines.some((l) => l.unitPrice === undefined || l.quantity <= 0)) return inv;
  const cents = (v: number) => Math.round(v * 100) / 100;
  const extra = inv.lines.map((l) => cents(l.total - l.unitPrice! * l.quantity));
  if (extra.some((e) => e < 0) || Math.abs(extra.reduce((a, e) => a + e, 0) - tax) > 0.02) return inv;
  return { ...inv, lines: inv.lines.map((l) => ({ ...l, total: cents(l.unitPrice! * l.quantity) })),
    notes: [inv.notes, 'Line totals included tax: counted before tax.'].filter(Boolean).join(' ') };
}

