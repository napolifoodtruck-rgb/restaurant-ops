/**
 * What the restaurant buys, in the app's own terms: suppliers, the products bought from them
 * (the ingredient list), invoices with their lines, and the price paid each time. Every way an
 * invoice comes in (a photo, typed in, the garden, an importer) ends up in these shapes, and
 * costing reads only these.
 *
 * Ids: a product's id is the ingredient id recipes point at; a supplier's and an invoice's are
 * stable keys the rest of the app can hold on to.
 */

import type { ItemConversions, Quantity } from './units.ts';

export interface Supplier {
  externalId: string;
  name: string;
}

export interface PurchasedProduct {
  externalId: string;
  name: string;
  /** The unit it's costed in, or undefined when its unit couldn't be read. */
  baseUnit?: string;
  rawUnit?: string;
  conversions: ItemConversions;
  category?: string;
  /** FOOD, WINE, BEER, LIQUOR, NA_BEVERAGES or OTHER (supplies, repairs...). */
  categoryType?: string;
  /** A last known price per one baseUnit, used as a sanity reference. */
  referencePrice?: number;
}

export interface SupplierInvoiceLine {
  lineNumber: number;
  vendorItemCode?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  productExternalId?: string;
  /** False when quantity × unit price doesn't match the line total. */
  mathChecks: boolean;
}

export interface SupplierInvoice {
  externalId: string;
  vendorExternalId?: string;
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  total: number;
  isCredit: boolean;
  lines: SupplierInvoiceLine[];
  /** Invoice total minus (lines + tax + delivery + other charges − credits). */
  unexplainedDifference: number;
  /** What's on it besides the lines. */
  charges?: { tax: number; delivery: number; other: number; credit: number };
}

export interface PricePoint {
  productExternalId: string;
  vendorExternalId?: string;
  invoiceExternalId: string;
  lineNumber: number;
  date: string;
  /** Price paid for one purchased unit. */
  price: number;
  /** What that purchased unit holds. */
  per: Quantity;
  /** Price per one of the product's base units. */
  perBaseUnit: number;
  /** Purchased units on the line, for blending prices by what was bought. */
  quantity: number;
  /** Base units in one purchased unit, when the price can't tell it (a $0 garden harvest). */
  perBase?: number;
  /** How the pack size was worked out ('manager': told by a manager). */
  source: 'manager' | 'pack' | 'calibrated' | 'itemName' | 'productUnit';
}

/** Everything bought: the ingredient list, suppliers, invoices and the prices they set. */
export interface Purchasing {
  vendors: Supplier[];
  products: PurchasedProduct[];
  invoices: SupplierInvoice[];
  prices: PricePoint[];
}

/** Base units in one purchased unit: given, or worked out from the price. */
export const packBaseOf = (p: PricePoint): number => p.perBase ?? (p.perBaseUnit > 0 ? p.price / p.perBaseUnit : 0);

/**
 * Price per base unit blended over recent purchases, weighted by how much was bought: an
 * ingredient bought from two vendors costs what the mix you actually buy costs. Products
 * not bought in the window fall back to their latest purchase.
 */
export function blendedPrices(prices: readonly PricePoint[], asOf: string, days = 60): Map<string, number> {
  const since = new Date(Date.parse(`${asOf.slice(0, 10)}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const spend = new Map<string, { money: number; base: number }>();
  const latest = new Map<string, PricePoint>();
  for (const p of prices) {
    if (p.date.slice(0, 10) > asOf.slice(0, 10)) continue;
    const current = latest.get(p.productExternalId);
    if (!current || p.date >= current.date) latest.set(p.productExternalId, p);
    // Free lines (the garden) count too: they bring the average down by what they supplied.
    if (p.date.slice(0, 10) <= since || !(packBaseOf(p) > 0) || p.perBaseUnit < 0) continue;
    const s = spend.get(p.productExternalId) ?? { money: 0, base: 0 };
    s.money += p.price * p.quantity;
    s.base += packBaseOf(p) * p.quantity;
    spend.set(p.productExternalId, s);
  }
  const out = new Map<string, number>();
  for (const [productId, point] of latest) {
    const s = spend.get(productId);
    out.set(productId, s && s.base > 0 ? s.money / s.base : point.perBaseUnit);
  }
  return out;
}

/** Latest price per product. */
export function latestPrices(prices: readonly PricePoint[]): Map<string, PricePoint> {
  const latest = new Map<string, PricePoint>();
  for (const point of prices) {
    const current = latest.get(point.productExternalId);
    if (!current || point.date >= current.date) latest.set(point.productExternalId, point);
  }
  return latest;
}
