/**
 * An invoice read from a photo, turned into lines a manager can check: which ingredient each line
 * is, how much of it came in (in the ingredient's own unit), and anything that doesn't add up.
 *
 * Which ingredient, in order:
 *   learned   a manager confirmed this vendor's line before (vendor_item_matches)
 *   history   the same vendor's item code or description on a past MarginEdge invoice
 *   guess     the closest ingredient by name, for the manager to confirm
 * How much: what one "quantity" held last time (learned or history), else the pack printed on the
 * line ("6/5 LB" is 30 lb), else the unit itself when it's a weight or volume (catch weight).
 *
 * Pure: the caller supplies the vendors, history, products and prices.
 */
import type { ReadInvoice, ReadLine } from '../connectors/claudeInvoices.ts';
import { nameLikeness } from './ingredientChecks.ts';
import { dimensionOf, normalizeUnit } from './units.ts';

export interface KnownVendor { key: string; name: string }
export interface PastLine { vendorKey: string; code?: string; description: string; productId: string; perQuantity: number; unitPrice: number; date: string }
export interface Learned { productId: string; per: number }
export interface MatchProduct { id: string; name: string; baseUnit: string }
export interface PastInvoice { externalId: string; vendorKey?: string; number?: string; date?: string; total: number }

export interface MatchInput {
  read: ReadInvoice;
  vendors: KnownVendor[];
  history: PastLine[];
  /** By `${vendor name, lower-cased}|${itemKey}`. */
  learned: Map<string, Learned>;
  products: MatchProduct[];
  /** Base units in one of `unit` for a product, or undefined when they don't convert. */
  baseOf: (productId: string, unit: string) => number | undefined;
  /** Today's price per base unit, for spotting a jump. */
  priceNow: (productId: string) => number | undefined;
  /** Invoices already in (MarginEdge's), so the same one isn't counted twice. */
  invoices: PastInvoice[];
}

export type LineFlag = 'unsure' | 'math' | 'noProduct' | 'noAmount' | 'priceJump' | 'credit';

export interface MatchedLine {
  read: ReadLine;
  itemKey: string;
  how: 'learned' | 'history' | 'guess' | 'none';
  productId?: string;
  /** Other likely ingredients, best first, when it's a guess. */
  candidates?: { id: string; name: string }[];
  /** Base units in one of the line's quantity, and how that was worked out. */
  perQuantity?: number;
  perFrom?: 'learned' | 'history' | 'pack' | 'unit';
  /** Base units that came in: quantity × perQuantity. */
  baseQuantity?: number;
  baseUnit?: string;
  /** What the line works out to per base unit, against today's price. */
  perBase?: number;
  was?: number;
  flags: LineFlag[];
}

export interface MatchedInvoice {
  vendor: { key?: string; name: string; how: 'known' | 'new' };
  date?: string;
  number?: string;
  lines: MatchedLine[];
  /** Lines plus tax, delivery and charges, against the printed total (when there is one). */
  totalDifference?: number;
  /** MarginEdge already has this invoice: saved as a check, it doesn't count twice. */
  duplicateOf?: { externalId: string; number?: string; date?: string; source: 'marginedge' | 'app' };
}

/** A vendor's line, as a key: its item code when printed, else its description, tidied. */
export const itemKey = (l: Pick<ReadLine, 'code' | 'description'>) => (l.code ? `#${l.code.toLowerCase().replace(/\s+/g, '')}` : l.description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
export const vendorKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|co|corp|ltd|company|the)\b/g, '').replace(/\s+/g, ' ').trim();

/** "6/5 LB" → 30 lb; "4/1 GAL" → 4 gal; "12/750ML" → 9000 ml; "25 LB" → 25 lb; "50#" → 50 lb. */
export function parsePack(pack: string | undefined): { amount: number; unit: string } | undefined {
  if (!pack) return undefined;
  const p = pack.toLowerCase().replace(/#/g, ' lb').replace(/\s+/g, ' ').trim();
  const m = p.match(/^(?:(\d+(?:\.\d+)?)\s*(?:\/|x)\s*)?(\d+(?:\.\d+)?)\s*([a-z]+(?: ?oz)?)\b/);
  if (!m) return undefined;
  const unit = normalizeUnit(m[3]!.replace(/^(lbs?|pounds?)$/, 'lb').replace(/^(ltr?|liters?|litres?)$/, 'l').replace(/^fl ?oz$/, 'floz'));
  if (!dimensionOf(unit)) return undefined;
  return { amount: (m[1] ? Number(m[1]) : 1) * Number(m[2]), unit };
}

export function matchInvoice(input: MatchInput): MatchedInvoice {
  const { read } = input;
  // The vendor: one we know by name, else new.
  const vk = vendorKey(read.vendor);
  const known = input.vendors.map((v) => ({ v, score: vendorKey(v.name) === vk ? 1 : nameLikeness(v.name, read.vendor) })).sort((a, b) => b.score - a.score)[0];
  const vendor = known && known.score >= 0.5 ? { key: known.v.key, name: known.v.name, how: 'known' as const } : { name: read.vendor || 'Unknown vendor', how: 'new' as const };
  const vendorLearnKey = vendorKey(vendor.name);
  const past = vendor.key ? input.history.filter((h) => h.vendorKey === vendor.key).sort((a, b) => (a.date < b.date ? 1 : -1)) : [];
  const product = new Map(input.products.map((p) => [p.id, p]));

  const lines = read.lines.map((l): MatchedLine => {
    const key = itemKey(l);
    const flags: LineFlag[] = [];
    if (l.unsure) flags.push('unsure');
    if (l.quantity < 0 || l.total < 0) flags.push('credit');
    if (l.unitPrice !== undefined && Math.abs(l.unitPrice * l.quantity - l.total) > Math.max(0.05, Math.abs(l.total) * 0.01)) flags.push('math');
    let how: MatchedLine['how'] = 'none', productId: string | undefined, perQuantity: number | undefined, perFrom: MatchedLine['perFrom'];
    let candidates: MatchedLine['candidates'];
    const learned = input.learned.get(`${vendorLearnKey}|${key}`);
    const seen = past.find((h) => (l.code && h.code && itemKey(h) === key) || itemKey({ description: h.description }) === itemKey({ description: l.description }));
    if (learned && product.has(learned.productId)) { how = 'learned'; productId = learned.productId; perQuantity = learned.per; perFrom = 'learned'; }
    else if (seen && product.has(seen.productId)) { how = 'history'; productId = seen.productId; perQuantity = seen.perQuantity; perFrom = 'history'; }
    else {
      const ranked = input.products.map((p) => ({ p, s: nameLikeness(l.description, p.name) })).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 4);
      if (ranked.length) { how = 'guess'; productId = ranked[0]!.p.id; candidates = ranked.map((x) => ({ id: x.p.id, name: x.p.name })); }
    }
    // How much one quantity holds, when it isn't known yet: the pack, else the unit itself.
    if (productId && perQuantity === undefined) {
      const pack = parsePack(l.pack);
      const fromPack = pack ? input.baseOf(productId, pack.unit) : undefined;
      if (pack && fromPack !== undefined) { perQuantity = pack.amount * fromPack; perFrom = 'pack'; }
      else if (l.unit) { const u = input.baseOf(productId, normalizeUnit(l.unit.toLowerCase().replace(/^(lbs?|#|pounds?)$/, 'lb'))); if (u !== undefined) { perQuantity = u; perFrom = 'unit'; } }
    }
    const out: MatchedLine = { read: l, itemKey: key, how, flags };
    if (productId) {
      out.productId = productId;
      out.baseUnit = product.get(productId)!.baseUnit;
      if (candidates) out.candidates = candidates;
    } else flags.push('noProduct');
    if (perQuantity !== undefined && perQuantity > 0) {
      out.perQuantity = perQuantity; out.perFrom = perFrom!;
      out.baseQuantity = Math.round(l.quantity * perQuantity * 1000) / 1000;
      if (out.baseQuantity !== 0) out.perBase = Math.round((l.total / out.baseQuantity) * 10000) / 10000;
      const was = productId ? input.priceNow(productId) : undefined;
      if (was !== undefined && was > 0 && out.perBase !== undefined && out.perBase > 0) {
        out.was = Math.round(was * 10000) / 10000;
        if (Math.abs(out.perBase - was) / was > 0.25) flags.push('priceJump');
      }
    } else if (productId) flags.push('noAmount');
    return out;
  });

  const result: MatchedInvoice = { vendor, lines };
  if (read.invoiceDate) result.date = read.invoiceDate;
  if (read.invoiceNumber) result.number = read.invoiceNumber;
  if (read.total !== undefined) {
    const sum = read.lines.reduce((a, l) => a + l.total, 0) + (read.tax ?? 0) + (read.delivery ?? 0) + (read.otherCharges ?? 0);
    result.totalDifference = Math.round((read.total - sum) * 100) / 100;
  }
  // The same invoice already in: same vendor and number, or same vendor, day and total.
  const num = (n?: string) => (n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dup = vendor.key ? input.invoices.find((i) => i.vendorKey === vendor.key && ((read.invoiceNumber && num(i.number) && num(i.number) === num(read.invoiceNumber))
    || (read.invoiceDate && i.date === read.invoiceDate && read.total !== undefined && Math.abs(i.total - read.total) < 0.01))) : undefined;
  if (dup) result.duplicateOf = { externalId: dup.externalId, ...(dup.number ? { number: dup.number } : {}), ...(dup.date ? { date: dup.date } : {}), source: dup.externalId.startsWith('app:') ? 'app' : 'marginedge' };
  return result;
}
