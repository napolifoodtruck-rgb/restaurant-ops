/**
 * MarginEdge's read-only public API: the same calls as scripts/marginedge-export.mjs, made
 * from the server. Returns data in the export's shape, which importMarginEdge() reads.
 *
 * Invoices are fetched per month window, then each one's detail. Later syncs fetch only the
 * recent weeks again (MarginEdge keeps editing invoices for a while after upload) and keep
 * older ones as they were; pack sizes are fetched only for vendor items not seen before.
 */

import type { MarginEdgeExport } from './marginedge.ts';

export type MeFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<any>; text(): Promise<string> }>;

export interface MarginEdgeApiOptions {
  fetch?: MeFetch;
  baseUrl?: string;
  requestsPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class MarginEdgeApi {
  readonly #key: string;
  readonly #fetch: MeFetch;
  readonly #base: string;
  readonly #gap: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  #last = 0;
  requests = 0;

  constructor(key: string, options: MarginEdgeApiOptions = {}) {
    this.#key = key;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as MeFetch);
    this.#base = options.baseUrl ?? 'https://api.marginedge.com/public';
    this.#gap = 1000 / (options.requestsPerSecond ?? 4);
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<any> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const wait = this.#last + this.#gap - this.#now().getTime();
      if (wait > 0) await this.#sleep(wait);
      this.#last = this.#now().getTime();
      this.requests++;
      let res;
      try {
        res = await this.#fetch(url.toString(), { headers: { 'x-api-key': this.#key, accept: 'application/json' } });
      } catch (err) {
        if (attempt >= 5) throw new Error(`MarginEdge: network error on ${path}: ${(err as Error).message}`);
        await this.#sleep(2000 * attempt);
        continue;
      }
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.#sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error('MarginEdge refused the API key. Check MARGINEDGE_API_KEY in Render.');
      const body = await res.text().catch(() => '');
      throw new Error(`MarginEdge returned ${res.status} for ${path}: ${body.slice(0, 200)}`);
    }
  }

  async getAll(path: string, list: string, query: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const items: any[] = [];
    let nextPage: string | undefined;
    do {
      const page = await this.get(path, { ...query, nextPage });
      items.push(...(page[list] ?? []));
      nextPage = page.nextPage || undefined;
    } while (nextPage);
    return items;
  }

  async restaurantUnits(): Promise<{ id: string; name: string }[]> {
    const data = await this.get('/restaurantUnits');
    return (data.restaurants ?? []).map((r: any) => ({ id: String(r.id), name: String(r.name) }));
  }

  /**
   * Everything for one restaurant. With `previous`, invoices dated before `refreshFrom` are
   * kept from it and only newer ones fetched; pack sizes already known are kept.
   */
  async unit(unitId: string, options: { from: string; to: string; previous?: MarginEdgeExport; refreshFrom?: string }): Promise<MarginEdgeExport> {
    const restaurantUnitId = unitId;
    const categories = await this.getAll('/categories', 'categories', { restaurantUnitId });
    const products = await this.getAll('/products', 'products', { restaurantUnitId });
    const vendors = await this.getAll('/vendors', 'vendors', { restaurantUnitId });

    const knownPacks = new Map((options.previous?.vendorItems ?? []).filter((v: any) => v.packagings).map((v: any) => [`${v.vendorId}|${v.vendorItemCode}`, v.packagings]));
    const vendorItems: any[] = [];
    for (const vendor of vendors) vendorItems.push(...(await this.getAll(`/vendors/${encodeURIComponent(vendor.vendorId)}/vendorItems`, 'vendorItems', { restaurantUnitId })));
    for (const item of vendorItems) {
      if (!item.vendorItemCode) continue;
      const known = knownPacks.get(`${item.vendorId}|${item.vendorItemCode}`);
      if (known) { item.packagings = known; continue; }
      try {
        item.packagings = await this.getAll(`/vendors/${encodeURIComponent(item.vendorId)}/vendorItems/${encodeURIComponent(item.vendorItemCode)}/packaging`, 'packagings', { restaurantUnitId });
      } catch (err) {
        item.packagingsError = (err as Error).message;
      }
    }

    const fetchFrom = options.previous && options.refreshFrom ? options.refreshFrom : options.from;
    const kept = (options.previous?.invoices ?? []).filter((inv: any) => {
      const d = String(inv.invoiceDate ?? inv.createdDate ?? '').slice(0, 10);
      return d && d >= options.from && d < fetchFrom;
    });
    const fresh: any[] = [];
    for (const window of monthWindows(fetchFrom, options.to)) {
      for (const summary of await this.getAll('/orders', 'orders', { restaurantUnitId, ...window })) {
        try {
          fresh.push({ ...summary, ...(await this.get(`/orders/${encodeURIComponent(summary.orderId)}`, { restaurantUnitId })) });
        } catch (err) {
          fresh.push({ ...summary, detailError: (err as Error).message });
        }
      }
    }
    // An invoice can move dates when MarginEdge corrects it: the fresh copy wins.
    const freshIds = new Set(fresh.map((i) => String(i.orderId)));
    const invoices = [...kept.filter((i: any) => !freshIds.has(String(i.orderId))), ...fresh];
    return { categories, products, vendors, vendorItems, invoices } as MarginEdgeExport;
  }
}

/** Month-long windows covering from..to (inclusive), oldest first. */
export function monthWindows(from: string, to: string): { startDate: string; endDate: string }[] {
  const out: { startDate: string; endDate: string }[] = [];
  let end = new Date(`${to}T00:00:00Z`);
  const start = new Date(`${from}T00:00:00Z`);
  while (end >= start) {
    const ws = new Date(end);
    ws.setUTCMonth(ws.getUTCMonth() - 1);
    ws.setUTCDate(ws.getUTCDate() + 1);
    const windowStart = ws < start ? start : ws;
    out.unshift({ startDate: windowStart.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });
    end = new Date(windowStart);
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return out;
}
