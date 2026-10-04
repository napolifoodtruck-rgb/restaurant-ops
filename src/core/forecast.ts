/**
 * Sales forecasts by day of the week.
 *
 * The forecast for a menu item on a given day is its average sales on the same weekday
 * over recent weeks, counting only days the restaurant was open. Specials run for a
 * couple of days at a time, so they're forecast only on days they're available, from the
 * days they were actually on the menu. Tomorrow's reservations can nudge the result up
 * or down through an adjustment factor.
 */

export interface DailyItemSales {
  /** Business date, YYYY-MM-DD. */
  date: string;
  catalogId: string;
  quantity: number;
}

export interface ForecastOptions {
  /** How many past same-weekdays to average. Default 6. */
  weeks?: number;
  /** Menu items that are specials. */
  specials?: ReadonlySet<string>;
  /** Specials on the menu on the target date. Specials not listed here forecast to zero. */
  specialsAvailable?: ReadonlySet<string>;
  /**
   * Multiplier for the whole day, e.g. from reservations: 1.2 when tomorrow's booked
   * covers run 20% above a typical same weekday. Default 1.
   */
  adjustment?: number;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expected portions per menu item on the target date. */
export function forecastDay(history: DailyItemSales[], targetDate: string, options: ForecastOptions = {}): Map<string, number> {
  const weeks = options.weeks ?? 6;
  const adjustment = options.adjustment ?? 1;
  const specials = options.specials ?? new Set<string>();
  const available = options.specialsAvailable ?? new Set<string>();

  // The same weekday on each of the previous `weeks` weeks.
  const window = new Set<string>();
  for (let week = 1; week <= weeks; week++) window.add(addDays(targetDate, -7 * week));

  // Sales per item per date within the window; any sale means the restaurant was open.
  const openDays = new Set<string>();
  const byItem = new Map<string, Map<string, number>>();
  for (const sale of history) {
    if (!window.has(sale.date) || sale.quantity <= 0) continue;
    openDays.add(sale.date);
    const days = byItem.get(sale.catalogId) ?? new Map<string, number>();
    days.set(sale.date, (days.get(sale.date) ?? 0) + sale.quantity);
    byItem.set(sale.catalogId, days);
  }

  const forecast = new Map<string, number>();
  for (const [catalogId, days] of byItem) {
    let average: number;
    if (specials.has(catalogId)) {
      if (!available.has(catalogId)) continue;
      // Only the days it was on the menu count.
      average = sum(days.values()) / days.size;
    } else {
      average = openDays.size > 0 ? sum(days.values()) / openDays.size : 0;
    }
    forecast.set(catalogId, average * adjustment);
  }
  return forecast;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
