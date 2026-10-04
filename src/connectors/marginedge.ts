/**
 * Reads a MarginEdge export (from scripts/marginedge-export.mjs) into our own neutral shapes:
 * vendors, products, vendor items with pack sizes, invoices with lines, and price history.
 *
 * It also runs the invoice self-checks from the design: each line's quantity × unit price
 * should equal its line total, and the lines plus charges should add up to the invoice
 * total. Lines that fail, and units we don't recognise, become flags for review instead of
 * silently entering costs.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStandardUnit, normalizeUnit, type Quantity } from '../core/units.ts';

// ---------------------------------------------------------------- MarginEdge shapes (export files)

export interface MeProduct {
  companyConceptProductId: string;
  productName: string;
  reportByUnit?: string;
  latestPrice?: number;
  centralProductId?: string;
  taxExempt?: boolean;
  categories?: { categoryId: string; percentAllocation?: number }[];
}

export interface MeVendor {
  vendorId: string;
  vendorName: string;
  centralVendorId?: string;
}

export interface MePackaging {
  packagingId: string;
  packagingName?: string;
  quantity?: number;
  unit?: string;
}

export interface MeVendorItem {
  vendorItemCode: string;
  vendorId: string;
  companyConceptProductId?: string;
  productName?: string;
  packagings?: MePackaging[];
}

export interface MeLineItem {
  vendorItemCode?: string;
  vendorItemName?: string;
  quantity?: number;
  unitPrice?: number;
  linePrice?: number;
  companyConceptProductId?: string;
  categoryId?: string;
  packagingId?: string;
}

export interface MeInvoice {
  orderId: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  createdDate?: string;
  vendorId?: string;
  vendorName?: string;
  orderTotal?: number;
  tax?: number;
  deliveryCharges?: number;
  otherCharges?: number;
  creditAmount?: number;
  isCredit?: boolean;
  status?: string;
  lineItems?: MeLineItem[];
  detailError?: string;
}

export interface MeCategory {
  categoryId: string;
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
  /** Our unit name, or undefined when MarginEdge's unit isn't recognised. */
  baseUnit?: string;
  rawUnit?: string;
  category?: string;
}

export interface ImportedPack {
  externalId: string;
  name?: string;
  /** What one purchased unit contains, e.g. 50 lb. Undefined when the unit isn't recognised. */
  contents?: Quantity;
  rawUnit?: string;
  rawQuantity?: number;
}

export interface ImportedVendorItem {
  vendorExternalId: string;
  code: string;
  /** The vendor's own wording, from invoice lines. */
  descriptions: string[];
  productExternalId?: string;
  packs: ImportedPack[];
}

export interface ImportedInvoiceLine {
  lineNumber: number;
  vendorItemCode?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  productExternalId?: string;
  packExternalId?: string;
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
  /** What that purchased unit contains. */
  per: Quantity;
}

export type ImportFlag =
  | { type: 'lineMath'; invoiceExternalId: string; lineNumber: number; description: string; expected: number; actual: number }
  | { type: 'invoiceTotal'; invoiceExternalId: string; invoiceNumber?: string; vendorName?: string; difference: number }
  | { type: 'unknownUnit'; where: 'product' | 'pack'; externalId: string; name: string; rawUnit: string }
  | { type: 'noPackSize'; invoiceExternalId: string; lineNumber: number; description: string }
  | { type: 'missingDetail'; invoiceExternalId: string; reason: string };

export interface ImportResult {
  vendors: ImportedVendor[];
  products: ImportedProduct[];
  vendorItems: ImportedVendorItem[];
  invoices: ImportedInvoice[];
  prices: PricePoint[];
  flags: ImportFlag[];
}

// ---------------------------------------------------------------- units

const MARGINEDGE_UNITS: Record<string, string> = {
  POUND: 'lb', POUNDS: 'lb', LB: 'lb',
  OUNCE: 'oz', OUNCES: 'oz', OZ: 'oz',
  GRAM: 'g', GRAMS: 'g', KILOGRAM: 'kg', KILOGRAMS: 'kg',
  EACH: 'each', EA: 'each', PIECE: 'each', COUNT: 'each', DOZEN: 'dozen',
  FLUID_OUNCE: 'floz', 'FLUID OUNCE': 'floz', FL_OZ: 'floz', 'FL OZ': 'floz',
  CUP: 'cup', PINT: 'pt', QUART: 'qt', GALLON: 'gal',
  LITER: 'l', LITRE: 'l', MILLILITER: 'ml', MILLILITRE: 'ml',
  TEASPOON: 'tsp', TABLESPOON: 'tbsp',
};

/** Maps a MarginEdge unit name to ours, or undefined when we don't know it. */
export function mapUnit(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toUpperCase();
  const mapped = MARGINEDGE_UNITS[key] ?? MARGINEDGE_UNITS[key.replace(/S$/, '')];
  if (mapped) return mapped;
  const normalized = normalizeUnit(raw);
  return isStandardUnit(normalized) ? normalized : undefined;
}

// ---------------------------------------------------------------- import

const money = (value: number | undefined) => (Number.isFinite(value) ? (value as number) : 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** quantity × unit price must match the line total within a cent or half a percent. */
function lineMathChecks(quantity: number, unitPrice: number, lineTotal: number): boolean {
  const expected = quantity * unitPrice;
  return Math.abs(expected - lineTotal) <= Math.max(0.02, Math.abs(lineTotal) * 0.005);
}

export function importMarginEdge(data: MarginEdgeExport): ImportResult {
  const flags: ImportFlag[] = [];
  const categoryNames = new Map(data.categories.map((c) => [c.categoryId, c.categoryName]));

  const vendors: ImportedVendor[] = data.vendors.map((v) => ({ externalId: v.vendorId, name: v.vendorName }));

  const products: ImportedProduct[] = data.products.map((p) => {
    const baseUnit = mapUnit(p.reportByUnit);
    if (!baseUnit && p.reportByUnit) {
      flags.push({ type: 'unknownUnit', where: 'product', externalId: p.companyConceptProductId, name: p.productName, rawUnit: p.reportByUnit });
    }
    const mainCategory = [...(p.categories ?? [])].sort((a, b) => (b.percentAllocation ?? 0) - (a.percentAllocation ?? 0))[0];
    return {
      externalId: p.companyConceptProductId,
      name: p.productName,
      baseUnit,
      rawUnit: p.reportByUnit,
      category: mainCategory ? categoryNames.get(mainCategory.categoryId) : undefined,
    };
  });

  // Vendor items, keyed by vendor + code; packs keyed by id for invoice lines.
  const itemKey = (vendorId: string | undefined, code: string | undefined) => `${vendorId ?? '?'}|${code ?? '?'}`;
  const vendorItems = new Map<string, ImportedVendorItem>();
  const packs = new Map<string, ImportedPack>();

  for (const item of data.vendorItems) {
    const imported: ImportedVendorItem = {
      vendorExternalId: item.vendorId,
      code: item.vendorItemCode,
      descriptions: [],
      productExternalId: item.companyConceptProductId,
      packs: [],
    };
    for (const pack of item.packagings ?? []) {
      const unit = mapUnit(pack.unit);
      const contents = unit && pack.quantity && pack.quantity > 0 ? { amount: pack.quantity, unit } : undefined;
      if (!unit && pack.unit) {
        flags.push({ type: 'unknownUnit', where: 'pack', externalId: pack.packagingId, name: `${item.productName ?? item.vendorItemCode} (${pack.packagingName ?? 'pack'})`, rawUnit: pack.unit });
      }
      const importedPack: ImportedPack = { externalId: pack.packagingId, name: pack.packagingName, contents, rawUnit: pack.unit, rawQuantity: pack.quantity };
      imported.packs.push(importedPack);
      packs.set(pack.packagingId, importedPack);
    }
    vendorItems.set(itemKey(item.vendorId, item.vendorItemCode), imported);
  }

  const invoices: ImportedInvoice[] = [];
  const prices: PricePoint[] = [];

  for (const invoice of data.invoices) {
    if (invoice.detailError || !invoice.lineItems) {
      flags.push({ type: 'missingDetail', invoiceExternalId: invoice.orderId, reason: invoice.detailError ?? 'no line items in export' });
      continue;
    }
    const invoiceDate = invoice.invoiceDate ?? invoice.createdDate;

    const lines: ImportedInvoiceLine[] = invoice.lineItems.map((line, index) => {
      const lineNumber = index + 1;
      const quantity = money(line.quantity);
      const unitPrice = money(line.unitPrice);
      const lineTotal = money(line.linePrice);
      const description = line.vendorItemName?.trim() || line.vendorItemCode || `line ${lineNumber}`;
      const mathChecks = lineMathChecks(quantity, unitPrice, lineTotal);
      if (!mathChecks) {
        flags.push({ type: 'lineMath', invoiceExternalId: invoice.orderId, lineNumber, description, expected: round2(quantity * unitPrice), actual: lineTotal });
      }

      // Remember the vendor's wording for this item; it's what matching learns from.
      const item = vendorItems.get(itemKey(invoice.vendorId, line.vendorItemCode));
      if (item && line.vendorItemName && !item.descriptions.includes(line.vendorItemName)) item.descriptions.push(line.vendorItemName);

      // A price point needs a product, a sane line and a known pack size.
      if (line.companyConceptProductId && mathChecks && unitPrice > 0 && invoiceDate && !invoice.isCredit) {
        const pack = line.packagingId ? packs.get(line.packagingId) : undefined;
        if (pack?.contents) {
          prices.push({
            productExternalId: line.companyConceptProductId,
            vendorExternalId: invoice.vendorId,
            invoiceExternalId: invoice.orderId,
            lineNumber,
            date: invoiceDate,
            price: unitPrice,
            per: pack.contents,
          });
        } else {
          flags.push({ type: 'noPackSize', invoiceExternalId: invoice.orderId, lineNumber, description });
        }
      }

      return {
        lineNumber,
        vendorItemCode: line.vendorItemCode,
        description,
        quantity,
        unitPrice,
        lineTotal,
        productExternalId: line.companyConceptProductId,
        packExternalId: line.packagingId,
        mathChecks,
      };
    });

    const linesTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const explained = linesTotal + money(invoice.tax) + money(invoice.deliveryCharges) + money(invoice.otherCharges) - money(invoice.creditAmount);
    const total = money(invoice.orderTotal);
    const unexplainedDifference = round2(total - explained);
    // Small rounding is normal; flag gaps over $1 that are also over 1% of the invoice.
    if (Math.abs(unexplainedDifference) > 1 && Math.abs(unexplainedDifference) > Math.abs(total) * 0.01) {
      flags.push({ type: 'invoiceTotal', invoiceExternalId: invoice.orderId, invoiceNumber: invoice.invoiceNumber, vendorName: invoice.vendorName, difference: unexplainedDifference });
    }

    invoices.push({
      externalId: invoice.orderId,
      vendorExternalId: invoice.vendorId,
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
  return { vendors, products, vendorItems: [...vendorItems.values()], invoices, prices, flags };
}

/** Reads one restaurant's folder from the export (e.g. marginedge-export-2026-10-04/unit-123). */
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

/** Latest price per product, for seeding the recipe book's costs. */
export function latestPrices(prices: PricePoint[]): Map<string, PricePoint> {
  const latest = new Map<string, PricePoint>();
  for (const point of prices) {
    const current = latest.get(point.productExternalId);
    if (!current || point.date >= current.date) latest.set(point.productExternalId, point);
  }
  return latest;
}
