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
import { dimensionOf, tryConvert, type ItemConversions, type Quantity } from '../core/units.ts';
import { gramsPerEachFrom, mergeConversions, parseReportUnit, readPack, sizeInItemName, typicalDensity } from './marginedgeUnits.ts';

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
  /** Purchased units on the line, for blending prices by what was bought. */
  quantity: number;
  /** Base units in one purchased unit, when the price can't tell it (a $0 garden harvest). */
  perBase?: number;
  /** How the pack size was worked out ('manager': told by a manager). */
  source: 'manager' | 'pack' | 'calibrated' | 'itemName' | 'productUnit';
}

export type ImportFlag =
  | { type: 'lineMath'; invoiceExternalId: string; lineNumber: number; description: string; expected: number; actual: number }
  | { type: 'invoiceTotal'; invoiceExternalId: string; invoiceNumber?: string; vendorName?: string; difference: number }
  | { type: 'unknownUnit'; productExternalId: string; name: string; rawUnit: string }
  | { type: 'priceUnclear'; invoiceExternalId: string; lineNumber: number; vendorName?: string; description: string; productExternalId: string; price: number; impliedPerUnit?: number; referencePerUnit?: number; unit?: string }
  | { type: 'missingDetail'; invoiceExternalId: string; reason: string }
  | { type: 'mergeUnit'; productExternalId: string; into: string; unit: string };

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

/**
 * What managers have told the system, applied every time the export is read, so answers
 * survive a re-import instead of being typed into MarginEdge.
 */
export interface ImportAnswers {
  /** "Case of 6 × 16 oz jars": what one purchased unit of an item holds. Vendor optional. */
  packs?: { vendorId?: string; description: string; per: Quantity }[];
  /** Facts about a product's units ("a jar is 16 oz"). They win over what was inferred. */
  conversions?: Record<string, ItemConversions>;
  /**
   * One ingredient bought under several products (two brands of mozzarella, the same 00
   * flour from two vendors): their purchases and prices become one product's.
   */
  merges?: { into: string; from: string[] }[];
}

export function importMarginEdge(data: MarginEdgeExport, answers: ImportAnswers = {}): ImportResult {
  const flags: ImportFlag[] = [];
  const categories = new Map(data.categories.map((c) => [String(c.categoryId), c]));

  // Packs, keyed by their id, with the product they belong to.
  const packs = new Map<string, { productId?: string; reading: ReturnType<typeof readPack> }>();
  const taught = new Map<string, ItemConversions>();
  // When a product's packs disagree (the vendor went from a 250 ml to a 750 ml bottle of saba),
  // the pack bought most recently says what a "bottle" is today.
  const lastBought = new Map<string, string>();
  for (const invoice of data.invoices) {
    const date = invoice.invoiceDate ?? invoice.createdDate ?? '';
    for (const line of invoice.lineItems ?? []) {
      if (line.packagingId === null || line.packagingId === undefined) continue;
      const key = String(line.packagingId);
      if ((lastBought.get(key) ?? '') < date) lastBought.set(key, date);
    }
  }
  const allPacks = data.vendorItems.flatMap((item) => (item.packagings ?? []).map((pack) => ({ productId: id(item.companyConceptProductId), pack })));
  allPacks.sort((a, b) => (lastBought.get(String(b.pack.packagingId)) ?? '').localeCompare(lastBought.get(String(a.pack.packagingId)) ?? ''));
  // Every size each pack unit has had, per product: MarginEdge's price may still be per the old one.
  const pastSizes = new Map<string, Quantity[]>();
  for (const { productId, pack } of allPacks) {
    const reading = readPack(pack);
    packs.set(String(pack.packagingId), { productId, reading });
    if (!productId) continue;
    taught.set(productId, mergeConversions(taught.get(productId) ?? {}, reading.teaches));
    for (const [unit, size] of Object.entries(reading.teaches.customUnits ?? {})) {
      const key = `${productId}|${unit}`;
      pastSizes.set(key, [...(pastSizes.get(key) ?? []), size]);
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

  // Typical densities where nothing better is known (syrups, vinegar, oils, dairy).
  for (const product of products.values()) {
    if (product.conversions.gramsPerMl === undefined) {
      const density = typicalDensity(product.name);
      if (density) product.conversions = mergeConversions(product.conversions, { gramsPerMl: density });
    }
  }
  // Managers' answers win over anything inferred.
  for (const [productId, told] of Object.entries(answers.conversions ?? {})) {
    const product = products.get(productId);
    if (product) product.conversions = mergeConversions(told, product.conversions);
  }

  const packFor = (line: MeLineItem) => (line.packagingId !== null && line.packagingId !== undefined ? packs.get(String(line.packagingId)) : undefined);
  const lineKey = (vendorId: Id | undefined, description: string) => `${id(vendorId) ?? '?'}|${description.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const answeredPacks = new Map((answers.packs ?? []).map((a) => [lineKey(a.vendorId, a.description), a.per]));
  const answeredPack = (vendorId: Id | undefined, description: string) => answeredPacks.get(lineKey(vendorId, description)) ?? answeredPacks.get(lineKey(undefined, description));
  const allLines = data.invoices.flatMap((invoice) =>
    (invoice.lineItems ?? []).map((line) => ({ invoice, line, date: invoice.invoiceDate ?? invoice.createdDate ?? '', description: line.vendorItemName?.trim() || line.vendorItemCode || '' })),
  );

  // Item weights from names, for products counted by the piece or bag: "Spinach, Baby 4lb (bag)".
  // Only when the price confirms the line is one product unit (the same bag MarginEdge prices).
  for (const { line, description } of allLines) {
    const product = products.get(id(line.companyConceptProductId) ?? '');
    if (!product?.baseUnit || !product.referencePrice || packFor(line)) continue;
    const ratio = money(line.unitPrice) / product.referencePrice;
    if (ratio < 0.8 || ratio > 1.25) continue;
    const size = sizeInItemName(description);
    if (!size || dimensionOf(size.unit) !== 'mass') continue;
    if (product.baseUnit === 'each') {
      if (product.conversions.gramsPerEach === undefined) product.conversions = mergeConversions(product.conversions, { gramsPerEach: gramsPerEachFrom(size) });
    } else if (!dimensionOf(product.baseUnit) && !product.conversions.customUnits?.[product.baseUnit]) {
      product.conversions = mergeConversions(product.conversions, { customUnits: { [product.baseUnit]: size } });
    }
  }

  // Calibration: MarginEdge's latest price comes from the product's most recent purchase. If that
  // purchase's price is a clean multiple of it (a $7.50 bunch against $15/lb), MarginEdge knows a
  // pack size we don't: 0.5 lb. Apply it to every purchase of that item from that vendor.
  const learnedPacks = new Map<string, Quantity>();
  const latestLine = new Map<string, (typeof allLines)[number]>();
  for (const entry of allLines) {
    const productId = id(entry.line.companyConceptProductId);
    if (!productId || entry.invoice.isCredit || !(money(entry.line.unitPrice) > 0)) continue;
    const current = latestLine.get(productId);
    if (!current || entry.date >= current.date) latestLine.set(productId, entry);
  }
  for (const [productId, entry] of latestLine) {
    const product = products.get(productId);
    if (!product?.baseUnit || !product.referencePrice || packFor(entry.line)) continue;
    const ratio = niceRatio(money(entry.line.unitPrice) / product.referencePrice);
    if (ratio !== undefined && Math.abs(ratio - 1) > 0.03) {
      learnedPacks.set(lineKey(entry.invoice.vendorId, entry.description), { amount: ratio, unit: product.baseUnit });
    }
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
        const point = pricePoint(product, line, description, unitPrice, invoice.vendorId);
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
            quantity,
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

  // Merges: one ingredient bought under several products.
  for (const merge of answers.merges ?? []) {
    const into = products.get(merge.into);
    if (!into?.baseUnit) continue;
    for (const fromId of merge.from) {
      const from = products.get(fromId);
      if (!from || fromId === merge.into) continue;
      into.conversions = mergeConversions(into.conversions, from.conversions);
      products.delete(fromId);
      for (const invoice of invoices) for (const line of invoice.lines) if (line.productExternalId === fromId) line.productExternalId = merge.into;
      for (const [i, point] of prices.entries()) {
        if (point.productExternalId !== fromId) continue;
        const inBase = tryConvert(point.per, into.baseUnit, into.conversions);
        if (!inBase) {
          flags.push({ type: 'mergeUnit', productExternalId: fromId, into: merge.into, unit: point.per.unit });
          continue;
        }
        prices[i] = { ...point, productExternalId: merge.into, perBaseUnit: point.price / inBase };
      }
    }
  }

  prices.sort((a, b) => a.date.localeCompare(b.date));
  return {
    vendors: data.vendors.map((v) => ({ externalId: String(v.vendorId), name: v.vendorName.trim() })),
    products: [...products.values()],
    invoices,
    prices: prices.filter((p) => products.has(p.productExternalId)),
    flags,
  };

  /**
   * Works out what one purchased unit holds, trying the most specific source first: the pack
   * record, a pack size calibrated against MarginEdge's price, a size in the item's name, then
   * one product unit. The first reading that converts and lands near MarginEdge's own price is used.
   */
  function pricePoint(product: ImportedProduct, line: MeLineItem, description: string, unitPrice: number, vendorId: Id | undefined):
    | { ok: true; per: Quantity; perBaseUnit: number; source: PricePoint['source'] }
    | { ok: false; impliedPerUnit?: number } {
    const baseUnit = product.baseUnit!;
    const told = answeredPack(vendorId, description);
    if (told) {
      // A manager said what this holds: no second-guessing against MarginEdge's price.
      const inBase = tryConvert(told, baseUnit, product.conversions);
      if (inBase && inBase > 0) return { ok: true, per: told, perBaseUnit: unitPrice / inBase, source: 'manager' };
    }
    const tries: { per: Quantity; source: PricePoint['source'] }[] = [];
    const pack = packFor(line);
    for (const per of pack?.reading.candidates ?? []) tries.push({ per, source: 'pack' });
    if (!pack) {
      const learned = learnedPacks.get(lineKey(vendorId, description));
      if (learned) tries.push({ per: learned, source: 'calibrated' });
      const fromName = sizeInItemName(description);
      if (fromName) tries.push({ per: fromName, source: 'itemName' });
      tries.push({ per: { amount: 1, unit: baseUnit }, source: 'productUnit' });
    }

    let firstImplied: number | undefined;
    for (const attempt of tries) {
      const inBase = tryConvert(attempt.per, baseUnit, product.conversions);
      if (!inBase || !(inBase > 0)) continue;
      const perBaseUnit = unitPrice / inBase;
      firstImplied ??= perBaseUnit;
      if (plausible(product, perBaseUnit)) return { ok: true, per: attempt.per, perBaseUnit, source: attempt.source };
    }
    return { ok: false, impliedPerUnit: firstImplied };
  }

  /**
   * Whether a price per base unit is near MarginEdge's own. When the base unit's size has
   * changed (a 250 ml bottle, now 750 ml), MarginEdge's price may be per the old size, so
   * each past size is tried too.
   */
  function plausible(product: ImportedProduct, perBaseUnit: number): boolean {
    const reference = product.referencePrice;
    if (!reference) return true;
    const near = (ref: number) => perBaseUnit >= ref * PLAUSIBLE.low && perBaseUnit <= ref * PLAUSIBLE.high;
    if (near(reference)) return true;
    const baseUnit = product.baseUnit!;
    const current = product.conversions.customUnits?.[baseUnit];
    if (!current) return false;
    for (const past of pastSizes.get(`${product.externalId}|${baseUnit}`) ?? []) {
      const ratio = tryConvert(current, past.unit) ;
      if (ratio && past.amount > 0 && near(reference * (ratio / past.amount))) return true;
    }
    return false;
  }
}

/**
 * A ratio that is a clean pack size (within 2%): a whole number of units, or a half, third or
 * quarter below 2 (a quarter-pound bunch, a 1.5 lb bag). "2.75 bags" is not a pack size.
 */
function niceRatio(ratio: number): number | undefined {
  if (!(ratio >= 0.05) || !Number.isFinite(ratio)) return undefined;
  const divisors = ratio < 2 ? [1, 2, 3, 4] : [1];
  for (const divisor of divisors) {
    const scaled = ratio * divisor;
    const whole = Math.round(scaled);
    if (whole >= 1 && Math.abs(scaled - whole) / scaled < 0.02) return whole / divisor;
  }
  return undefined;
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
/**
 * Price per base unit blended over recent purchases, weighted by how much was bought: an
 * ingredient bought from two vendors costs what the mix you actually buy costs. Products
 * not bought in the window fall back to their latest purchase.
 */
/** Base units in one purchased unit: given, or worked out from the price. */
export const packBaseOf = (p: PricePoint): number => p.perBase ?? (p.perBaseUnit > 0 ? p.price / p.perBaseUnit : 0);

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

export function latestPrices(prices: PricePoint[]): Map<string, PricePoint> {
  const latest = new Map<string, PricePoint>();
  for (const point of prices) {
    const current = latest.get(point.productExternalId);
    if (!current || point.date >= current.date) latest.set(point.productExternalId, point);
  }
  return latest;
}
