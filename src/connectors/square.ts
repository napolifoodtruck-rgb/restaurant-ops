/**
 * Square: the menu from the Catalog API and item sales from the Reporting API, turned
 * into the neutral shapes the core works with. A Toast connector would produce the same.
 */

import { nameKey, posName, type PosMenuItem } from '../core/menuLinks.ts';
import type { MarginSaleLine } from '../core/margins.ts';
import type { ModifierSaleLine } from '../core/modifiers.ts';

// ---------------------------------------------------------------- catalog

interface SquareMoney {
  amount?: number | string;
  currency?: string;
}

export interface SquareCatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    is_archived?: boolean;
    category_id?: string;
    categories?: { id: string }[];
    reporting_category?: { id: string };
    variations?: {
      id: string;
      is_deleted?: boolean;
      item_variation_data?: { name?: string; price_money?: SquareMoney };
    }[];
  };
}

const dollars = (money?: SquareMoney): number | undefined => (money?.amount === undefined ? undefined : Number(money.amount) / 100);

/** A $0 button named "Shift" (e.g. "Margherita Shift") is a staff meal. */
export function isStaffMeal(name: string, price: number | undefined): boolean {
  return price === 0 && /\bshift\b/i.test(name);
}

/** One menu item per variation, since sales are reported per variation. */
export function squareMenuItems(objects: readonly SquareCatalogObject[], categoryNames: Readonly<Record<string, string>> = {}): PosMenuItem[] {
  const out: PosMenuItem[] = [];
  for (const object of objects) {
    const data = object.item_data;
    if (object.type !== 'ITEM' || object.is_deleted || !data?.name) continue;
    const categoryId = data.reporting_category?.id ?? data.categories?.[0]?.id ?? data.category_id;
    const variations = (data.variations ?? []).filter((v) => !v.is_deleted);
    for (const variation of variations) {
      const price = dollars(variation.item_variation_data?.price_money);
      const variationName = variations.length > 1 ? variation.item_variation_data?.name : undefined;
      out.push({
        catalogId: variation.id,
        itemId: object.id,
        itemName: data.name,
        ...(variationName ? { variationName } : {}),
        ...(categoryId ? { category: categoryNames[categoryId] ?? categoryId } : {}),
        ...(price !== undefined ? { price } : {}),
        ...(isStaffMeal(data.name, price) ? { staffMeal: true } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- sales

/** A row of a Reporting API ItemSales query grouped by variation id, item name, variation name and category. */
export type SquareItemSalesRow = Record<string, string | number | null | undefined>;

const field = (row: SquareItemSalesRow, name: string) => row[`ItemSales.${name}`];
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
/** The day of a row, when the query was grouped by day (timeDimensions granularity "day"). */
const dayOf = (row: SquareItemSalesRow): string | undefined => {
  const value = field(row, 'reporting_day.day') ?? field(row, 'reporting_day');
  return value ? String(value).slice(0, 10) : undefined;
};

/**
 * Turns ItemSales rows into sale lines. Each row keeps the name it sold under, so a
 * renamed item shows up as the same id under two names.
 * Request: measures items_sold_count and item_net_sales; dimensions item_variation_id,
 * item_name, item_variation_name, category_name. Grouped by day (reporting_day, granularity
 * "day"), each line carries its date, so seasonal recipe versions are costed by the day sold.
 */
export function squareItemSales(rows: readonly SquareItemSalesRow[], menu: readonly PosMenuItem[] = []): MarginSaleLine[] {
  const current = new Map(menu.map((m) => [m.catalogId, m]));
  const out: MarginSaleLine[] = [];
  for (const row of rows) {
    const itemName = String(field(row, 'item_name') ?? '').trim();
    const variationName = String(field(row, 'item_variation_name') ?? '').trim();
    const catalogId = String(field(row, 'item_variation_id') ?? '');
    const name = itemName ? posName({ itemName, variationName }) : '(no item name)';
    // Today's price belongs to today's name: a sale under an old name may have been another dish.
    const now = current.get(catalogId);
    const listPrice = now && nameKey(posName(now)) === nameKey(name) ? now.price : undefined;
    out.push({
      catalogId,
      name,
      quantity: num(field(row, 'items_sold_count')),
      netSales: num(field(row, 'item_net_sales')),
      ...(field(row, 'category_name') ? { category: String(field(row, 'category_name')) } : {}),
      ...(listPrice !== undefined ? { listPrice } : {}),
      ...(dayOf(row) ? { date: dayOf(row) } : {}),
      ...(row['special'] ? { special: true } : {}),
    });
  }
  return out;
}

/**
 * Turns ItemSales rows grouped by item and modifier into modifier sale lines.
 * Request: measures modifier_net_quantity and gross_sales (the modifiers' own sales);
 * dimensions item_variation_id, item_name, item_variation_name, modifier_name, modifier_list_name.
 */
export function squareModifierSales(rows: readonly SquareItemSalesRow[]): ModifierSaleLine[] {
  const out: ModifierSaleLine[] = [];
  for (const row of rows) {
    const modifierName = String(field(row, 'modifier_name') ?? '').trim();
    const quantity = num(field(row, 'modifier_net_quantity'));
    if (!modifierName || quantity <= 0) continue;
    const listName = field(row, 'modifier_list_name');
    const sales = num(field(row, 'gross_sales'));
    const itemName = String(field(row, 'item_name') ?? '').trim();
    const variationName = String(field(row, 'item_variation_name') ?? '').trim();
    out.push({
      catalogId: String(field(row, 'item_variation_id') ?? ''),
      itemName: posName({ itemName, variationName }),
      // Square's quantities come back as 7400.000000491738; uses are whole.
      quantity: Math.round(quantity * 1000) / 1000,
      sales,
      modifier: { name: modifierName, ...(listName ? { listName: String(listName) } : {}), price: Math.round((sales / quantity) * 100) / 100 },
      ...(dayOf(row) ? { date: dayOf(row) } : {}),
    });
  }
  return out;
}
