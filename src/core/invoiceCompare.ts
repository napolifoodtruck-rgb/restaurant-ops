/**
 * The same invoice read two ways (ours, checked by a manager, and MarginEdge's), line by line:
 * paired by ingredient, then by total; each pair the same, a different quantity, a different
 * total, or on one side only. Lines MarginEdge didn't tie to an ingredient (supplies, fees)
 * aren't scored.
 */
import type { ImportedInvoice, ImportedProduct, PricePoint } from '../connectors/marginedge.ts';
import { tryConvert } from './units.ts';

export interface OurLine { productId?: string; description: string; quantity: number; unit: string; total: number }
export interface ComparedLine {
  match: 'same' | 'quantity' | 'total' | 'onlyOurs' | 'onlyTheirs';
  productId?: string;
  description: string;
  ours?: { quantity: number; unit: string; total: number };
  theirs?: { quantity?: number; unit?: string; total: number };
}
export interface Comparison { lines: ComparedLine[]; oursTotal: number; theirsTotal: number; totalsMatch: boolean }

const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * tolerance);

export function compareInvoices(ours: readonly OurLine[], theirs: ImportedInvoice, pointOf: Map<string, PricePoint>, products: Map<string, ImportedProduct>): Comparison {
  const left = [...ours];
  const lines: ComparedLine[] = [];
  for (const l of theirs.lines) {
    if (!l.productExternalId) continue;
    const p = products.get(l.productExternalId);
    const pt = pointOf.get(`${theirs.externalId}|${l.lineNumber}`);
    const base = p?.baseUnit && pt ? tryConvert({ amount: pt.per.amount * l.quantity, unit: pt.per.unit }, p.baseUnit, p.conversions) : undefined;
    const theirSide = { ...(base !== undefined ? { quantity: Math.round(base * 1000) / 1000, unit: p!.baseUnit! } : {}), total: l.lineTotal };
    // Ours for the same ingredient, the closest total first.
    const candidates = left.filter((o) => o.productId === l.productExternalId).sort((a, b) => Math.abs(a.total - l.lineTotal) - Math.abs(b.total - l.lineTotal));
    const o = candidates[0];
    if (!o) { lines.push({ match: 'onlyTheirs', productId: l.productExternalId, description: l.description, theirs: theirSide }); continue; }
    left.splice(left.indexOf(o), 1);
    const ourBase = p?.baseUnit ? tryConvert({ amount: o.quantity, unit: o.unit }, p.baseUnit, p.conversions) : undefined;
    const sameTotal = close(o.total, l.lineTotal, 0.01);
    const sameQty = base === undefined || ourBase === undefined || close(ourBase, base, 0.02);
    lines.push({ match: sameTotal && sameQty ? 'same' : !sameTotal ? 'total' : 'quantity', productId: l.productExternalId, description: l.description,
      ours: { quantity: Math.round((ourBase ?? o.quantity) * 1000) / 1000, unit: p?.baseUnit ?? o.unit, total: o.total }, theirs: theirSide });
  }
  for (const o of left) lines.push({ match: 'onlyOurs', ...(o.productId ? { productId: o.productId } : {}), description: o.description, ours: { quantity: o.quantity, unit: o.unit, total: o.total } });
  const oursTotal = Math.round(ours.reduce((a, l) => a + l.total, 0) * 100) / 100;
  const theirsTotal = Math.round(theirs.lines.filter((l) => l.productExternalId).reduce((a, l) => a + l.lineTotal, 0) * 100) / 100;
  return { lines, oursTotal, theirsTotal, totalsMatch: close(oursTotal, theirsTotal, 0.005) };
}
