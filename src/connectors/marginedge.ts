/**
 * Reads a MarginEdge export (from scripts/marginedge-export.mjs) into our own neutral shapes:
 * vendors, products with units and conversions, vendor items with pack sizes, invoices
 * with lines, and price history.
 *
 * Invoice self-checks from the design:
 * - each line's quantity × unit price should equal its line total;
 * - the lines plus charges should add up to the invoice total;
 * - each price, turned into a price per product unit, should be in the same range as
 *   MarginEdge's own latest price for that product. A price far outside it usually means
 *   we read the pack size wrong, so it becomes a question instead of entering costs.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tryConvert, type ItemConversions, type Quantity } from '../core/units.ts';
import { mergeConversions, parseReportUnit, readPack, sizeInItemName } from './marginedgeUnits.ts';

// ---------------------------------------------------------------- MarginEdge shapes (export files)

type Id = string | number;

export interface MeProduct {
  companyConceptProductId: Id;
  productName: string;
  reportByUnit?: string;
  latestPrice?: number;
  categories?: { categoryId: Id; percentAllocation?: number }[];
}

export interface MeVendor {
  vendorId: Id;
  vendorName: string;
}

export interface MePackaging {
  packagingId: Id;
  packagingName?: string;
  quantity?: number;
  unit?: string;
}

export interface MeVendorItem {
  vendorItemCode: string;
  vendorId: Id;
  companyConceptProductId?: Id;
  productName?: string;
  packagings?: MePackaging[];
}

export interface MeLineItem {
  vendorItemCode?: string;
  vendorItemName?: string;
  quantity?: number;
  unitPrice?: number;
  linePrice?: number;
  companyConceptProductId?: Id;
  packagingId?: Id | null;
}

export interface MeInvoice {
  orderId: Id;
  invoiceNumber?: string;
  invoiceDate?: string;
  createdDate?: string;
  vendorId?: Id;
  vendorName?: string;
  orderTotal?: number;
  tax?: number;
  deliveryCharges?: number;
  otherCharges?: number;
  creditAmount?: number;
  isCredit?: boolean;
  lineItems?: MeLineItem[] | null;
  detailError?: string;
}

export interface MeCategory {
  categoryId: Id;
  categoryName: string;
  categoryType?: string;
}

export interface MarginEdgeExport {
  categories: MeCategory[];
  products: MeProduct[];
  vendors: MeVendor[];
  vendorItems: MeVendorItem[];
  invoices: MeInvoice[];
}

// ---------------------------------------------------------------- our shapes

export interface ImportedVendor {
  externalId: string;
  name: string;
}

export interface ImportedProduct {
  externalId: string;
  name: string;
  /** Our unit, or undefined when MarginEdge's unit couldn't be read. */
  baseUnit?: string;
  rawUnit?: string;
  conversions: ItemConversions;
  category?: string;
  /** FOOD, WINE, BEER, LIQUOR, NA_BEVERAGES or OTHER (supplies, repairs...). */
  categoryType?: string;
  /** MarginEdge's latest price per one baseUnit, used as a sanity reference. */
  referencePrice?: number;
}

export interface ImportedInvoiceLine {
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

export interface ImportedInvoice {
  externalId: string;
  vendorExternalId?: string;
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  total: number;
  isCredit: boolean;
  lines: ImportedInvoiceLine[];
  /** Invoice total minus (lines + tax + delivery + other charges − credits). */
  unexplainedDifference: number;
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
  /** How the pack size was worked out. */
  source: 'pack' | 'itemName' | 'productUnit';
}

export type ImportFlag =
  | { type: 'lineMath'; invoiceExternalId: string; lineNumber: number; description: string; expected: number; actual: number }
  | { type: 'invoiceTotal'; invoiceExternalId: string; invoiceNumber?: string; vendorName?: string; difference: number }
  | { type: 'unknownUnit'; productExternalId: string; name: string; rawUnit: string }
  | { type: 'priceUnclear'; invoiceExternalId: string; lineNumber: number; vendorName?: string; description: string; productExternalId: string; price: number; impliedPerUnit?: number; referencePerUnit?: number; unit?: string }
  | { type: 'missingDetail'; invoiceExternalId: string; reason: string };

export interface ImportResult {
  vendors: ImportedVendor[];
  products: ImportedProduct[];
  invoices: ImportedInvoice[];
  prices: PricePoint[];
  flags: ImportFlag[];
}

// ---------------------------------------------------------------- import

const id = (value: Id | null | undefined) => (value === null || value === undefined ? undefined : String(value));
const money = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** A price per unit this far from MarginEdge's own figure is treated as a misread pack size. */
const PLAUSIBLE = { low: 0.4, high: 2.5 };

function lineMathChecks(quantity: number, unitPrice: number, lineTotal: number): boolean {
  return Math.abs(quantity * unitPrice - lineTotal) <= Math.max(0.02, Math.abs(lineTotal) * 0.005);
}

export function importMarginEdge(data: MarginEdgeExport): ImportResult {
  const flags: ImportFlag[] = [];
  const categories = new Map(data.categories.map((c) => [String(c.categoryId), c]));

  // Packs, keyed by their id, with the product they belong to.
  const packs = new Map<string, { productId?: string; reading: ReturnType<typeof readPack> }>();
  const taught = new Map<string, ItemConversions>();
  for (const item of data.vendorItems) {
    const productId = id(item.companyConceptProductId);
    for (const pack of item.packagings ?? []) {
      const reading = readPack(pack);
      packs.set(String(pack.packagingId), { productId, reading });
      if (productId) taught.set(productId, mergeConversions(taught.get(productId) ?? {}, reading.teaches));
    }
  }

  const products = new Map<string, ImportedProduct>();
  for (const p of data.products) {
    const externalId = String(p.companyConceptProductId);
    const report = parseReportUnit(p.reportByUnit);
    if (!report.baseUnit && p.reportByUnit && p.reportByUnit.trim()) {
      flags.push({ type: 'unknownUnit', productExternalId: externalId, name: p.productName.trim(), rawUnit: p.reportByUnit });
    }
    // The product's own unit definition wins over what packs suggest.
    const conversions = mergeConversions(report.conversions, taught.get(externalId) ?? {});
    const mainCategory = [...(p.categories ?? [])].sort((a, b) => (b.percentAllocation ?? 0) - (a.percentAllocation ?? 0))[0];
    const category = mainCategory ? categories.get(String(mainCategory.categoryId)) : undefined;
    products.set(externalId, {
      externalId,
      name: p.productName.trim(),
      baseUnit: report.baseUnit,
      rawUnit: p.reportByUnit,
      conversions,
      category: category?.categoryName,
      categoryType: category?.categoryType,
      referencePrice: p.latestPrice && report.baseUnit ? p.latestPrice / report.priceCovers : undefined,
    });
  }

  const invoices: ImportedInvoice[] = [];
  const prices: PricePoint[] = [];

  for (const invoice of data.invoices) {
    const invoiceId = String(invoice.orderId);
    if (invoice.detailError || !invoice.lineItems) {
      flags.push({ type: 'missingDetail', invoiceExternalId: invoiceId, reason: invoice.detailError ?? 'no line items in export' });
      continue;
    }
    const invoiceDate = invoice.invoiceDate ?? invoice.createdDate;

    const lines: ImportedInvoiceLine[] = invoice.lineItems.map((line, index) => {
      const lineNumber = index + 1;
      const quantity = money(line.quantity);
      const unitPrice = money(line.unitPrice);
      const lineTotal = money(line.linePrice);
      const description = line.vendorItemName?.trim() || line.vendorItemCode || `line ${lineNumber}`;
      const productId = id(line.companyConceptProductId);
      const mathChecks = lineMathChecks(quantity, unitPrice, lineTotal);
      if (!mathChecks) {
        flags.push({ type: 'lineMath', invoiceExternalId: invoiceId, lineNumber, description, expected: round2(quantity * unitPrice), actual: lineTotal });
      }

      const product = productId ? products.get(productId) : undefined;
      if (product?.baseUnit && mathChecks && unitPrice > 0 && invoiceDate && !invoice.isCredit) {
        const point = pricePoint(product, line, description, unitPrice);
        if (point.ok) {
          prices.push({
            productExternalId: product.externalId,
            vendorExternalId: id(invoice.vendorId),
            invoiceExternalId: invoiceId,
            lineNumber,
            date: invoiceDate,
            price: unitPrice,
            per: point.per,
            perBaseUnit: point.perBaseUnit,
            source: point.source,
          });
        } else {
          flags.push({
            type: 'priceUnclear', invoiceExternalId: invoiceId, lineNumber, vendorName: invoice.vendorName, description,
            productExternalId: product.externalId, price: unitPrice, impliedPerUnit: point.impliedPerUnit,
            referencePerUnit: product.referencePrice, unit: product.baseUnit,
          });
        }
      }

      return { lineNumber, vendorItemCode: line.vendorItemCode || undefined, description, quantity, unitPrice, lineTotal, productExternalId: productId, mathChecks };
    });

    const linesTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const explained = linesTotal + money(invoice.tax) + money(invoice.deliveryCharges) + money(invoice.otherCharges) - money(invoice.creditAmount);
    const total = money(invoice.orderTotal);
    const unexplainedDifference = round2(total - explained);
    if (Math.abs(unexplainedDifference) > 1 && Math.abs(unexplainedDifference) > Math.abs(total) * 0.01) {
      flags.push({ type: 'invoiceTotal', invoiceExternalId: invoiceId, invoiceNumber: invoice.invoiceNumber, vendorName: invoice.vendorName, difference: unexplainedDifference });
    }

    invoices.push({
      externalId: invoiceId,
      vendorExternalId: id(invoice.vendorId),
      vendorName: invoice.vendorName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate,
      total,
      isCredit: invoice.isCredit ?? false,
      lines,
      unexplainedDifference,
    });
  }

  prices.sort((a, b) => a.date.localeCompare(b.date));
  return {
    vendors: data.vendors.map((v) => ({ externalId: String(v.vendorId), name: v.vendorName.trim() })),
    products: [...products.values()],
    invoices,
    prices,
    flags,
  };

  /**
   * Works out what one purchased unit holds, trying the most specific source first:
   * the pack record, a size in the item's name, then one product unit. The first reading
   * that converts and lands near MarginEdge's own price is used.
   */
  function pricePoint(product: ImportedProduct, line: MeLineItem, description: string, unitPrice: number):
    | { ok: true; per: Quantity; perBaseUnit: number; source: PricePoint['source'] }
    | { ok: false; impliedPerUnit?: number } {
    const baseUnit = product.baseUnit!;
    const tries: { per: Quantity; source: PricePoint['source'] }[] = [];
    const pack = line.packagingId !== null && line.packagingId !== undefined ? packs.get(String(line.packagingId)) : undefined;
    for (const per of pack?.reading.candidates ?? []) tries.push({ per, source: 'pack' });
    const fromName = pack ? undefined : sizeInItemName(description);
    if (fromName) tries.push({ per: fromName, source: 'itemName' });
    if (!pack) tries.push({ per: { amount: 1, unit: baseUnit }, source: 'productUnit' });

    let firstImplied: number | undefined;
    for (const attempt of tries) {
      const inBase = tryConvert(attempt.per, baseUnit, product.conversions);
      if (!inBase || !(inBase > 0)) continue;
      const perBaseUnit = unitPrice / inBase;
      firstImplied ??= perBaseUnit;
      const reference = product.referencePrice;
      if (!reference || (perBaseUnit >= reference * PLAUSIBLE.low && perBaseUnit <= reference * PLAUSIBLE.high)) {
        return { ok: true, per: attempt.per, perBaseUnit, source: attempt.source };
      }
    }
    return { ok: false, impliedPerUnit: firstImplied };
  }
}

/** Reads one restaurant's export folder (the files the export script writes). */
export async function readMarginEdgeExport(folder: string): Promise<MarginEdgeExport> {
  const load = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(folder, name), 'utf8')) as T;
  return {
    categories: await load<MeCategory[]>('categories.json'),
    products: await load<MeProduct[]>('products.json'),
    vendors: await load<MeVendor[]>('vendors.json'),
    vendorItems: await load<MeVendorItem[]>('vendor-items.json'),
    invoices: await load<MeInvoice[]>('invoices.json'),
  };
}

/** Latest price per product, for costing recipes. */
export function latestPrices(prices: PricePoint[]): Map<string, PricePoint> {
  const latest = new Map<string, PricePoint>();
  for (const point of prices) {
    const current = latest.get(point.productExternalId);
    if (!current || point.date >= current.date) latest.set(point.productExternalId, point);
  }
  return latest;
}
