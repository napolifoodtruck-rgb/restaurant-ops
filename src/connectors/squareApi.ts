/**
 * Square's REST API, read-only. Only GET requests and the Reporting API's read-only query
 * endpoint are used; nothing here can change anything in Square.
 */

import type { SquareCatalogObject, SquareItemSalesRow } from './square.ts';

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export class SquareApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SquareApiOptions {
  fetch?: Fetch;
  baseUrl?: string;
  /** Square-Version header. Unset = the version set on the developer app. */
  version?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface SquareLocation { id: string; name: string; status: string; merchantId: string; timezone?: string }
export interface SquareTeamMember { id: string; name: string; email?: string; isOwner: boolean; jobTitles: string[] }

const READ_ONLY_POSTS = new Set(['/reporting/v1/load', '/v2/team-members/search', '/v2/orders/search']);

export class SquareApi {
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  readonly #version?: string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(token: string, options: SquareApiOptions = {}) {
    this.#token = token;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.#base = options.baseUrl ?? 'https://connect.squareup.com';
    this.#version = options.version;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    if (method === 'POST' && !READ_ONLY_POSTS.has(path)) throw new Error(`Refusing to POST to ${path}: this connector is read-only.`);
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (this.#version) headers['square-version'] = this.#version;
    if (body !== undefined) headers['content-type'] = 'application/json';
    for (let attempt = 1; ; attempt++) {
      const res = await this.#fetch(this.#base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (res.ok) return res.json();
      // Rate limits and Square's own hiccups: back off and try again a few times.
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await this.#sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      let detail = '';
      try {
        const data = await res.json();
        detail = (data.errors ?? []).map((e: any) => e.detail ?? e.code).join('; ') || data.error || '';
      } catch {}
      throw new SquareApiError(res.status, `Square ${method} ${path.split('?')[0]} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
  }

  async locations(): Promise<SquareLocation[]> {
    const data = await this.#request('GET', '/v2/locations');
    return (data.locations ?? []).map((l: any) => ({ id: l.id, name: l.name, status: l.status, merchantId: l.merchant_id, timezone: l.timezone }));
  }

  /** Items (with variations), categories and modifier lists. */
  async catalog(): Promise<SquareCatalogObject[]> {
    const out: SquareCatalogObject[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ types: 'ITEM,CATEGORY,MODIFIER_LIST,IMAGE' });
      if (cursor) q.set('cursor', cursor);
      const data = await this.#request('GET', `/v2/catalog/list?${q}`);
      out.push(...(data.objects ?? []));
      cursor = data.cursor || undefined;
    } while (cursor);
    return out;
  }

  /** Active team members at a location, with their job titles. */
  async teamMembers(locationId: string): Promise<SquareTeamMember[]> {
    const members: any[] = [];
    let cursor: string | undefined;
    do {
      const data = await this.#request('POST', '/v2/team-members/search', { query: { filter: { status: 'ACTIVE', location_ids: [locationId] } }, limit: 200, ...(cursor ? { cursor } : {}) });
      members.push(...(data.team_members ?? []));
      cursor = data.cursor || undefined;
    } while (cursor);
    const out: SquareTeamMember[] = [];
    for (const m of members) {
      let jobTitles: string[] = [];
      try {
        const wage = await this.#request('GET', `/v2/team-members/${encodeURIComponent(m.id)}/wage-setting`);
        jobTitles = [...new Set<string>((wage.wage_setting?.job_assignments ?? []).map((j: any) => String(j.job_title ?? '').trim()).filter(Boolean))];
      } catch (err) {
        if (!(err instanceof SquareApiError && err.status === 404)) throw err; // no wage setting: no job title
      }
      const family = String(m.family_name ?? '').trim();
      out.push({
        id: m.id,
        name: [String(m.given_name ?? '').trim(), family ? `${family[0]}.` : ''].filter(Boolean).join(' ') || 'Team member',
        ...(m.email_address ? { email: m.email_address } : {}),
        isOwner: Boolean(m.is_owner),
        jobTitles,
      });
    }
    return out;
  }

  /** A Reporting API query, all pages. Rows are keyed like "ItemSales.item_name". */
  async report(query: Record<string, unknown>, pageSize = 5000): Promise<SquareItemSalesRow[]> {
    const rows: SquareItemSalesRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      let data: any;
      // Reporting answers "Continue wait" while a query is still running.
      for (let waits = 0; ; waits++) {
        data = await this.#request('POST', '/reporting/v1/load', { query: { ...query, limit: pageSize, offset } });
        if (data?.error !== 'Continue wait') break;
        if (waits >= 30) throw new SquareApiError(504, 'Square reporting took too long to answer.');
        await this.#sleep(2000);
      }
      const page: SquareItemSalesRow[] = data?.data ?? data?.results?.[0]?.data ?? [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  /**
   * Orders still open, created in this window (ISO times): paid at the counter or online but never
   * marked done, or a tab left open. Square's item reports leave them out; its Net sales doesn't.
   */
  async openOrders(locationId: string, startAt: string, endAt: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const data = await this.#request('POST', '/v2/orders/search', {
        location_ids: [locationId], limit: 500, ...(cursor ? { cursor } : {}),
        query: { filter: { state_filter: { states: ['OPEN'] }, date_time_filter: { created_at: { start_at: startAt, end_at: endAt } } }, sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' } },
      });
      out.push(...(data.orders ?? []));
      cursor = data.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Item sales by day: what squareItemSales() reads. Quantity is net_quantity, the real amount:
   * items_sold_count counts each share of a split check as a whole item.
   */
  itemSalesByDay(locationId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['ItemSales.net_quantity', 'ItemSales.item_net_sales'],
      dimensions: ['ItemSales.item_variation_id', 'ItemSales.item_name', 'ItemSales.item_variation_name', 'ItemSales.category_name'],
      timeDimensions: [{ dimension: 'ItemSales.reporting_day', dateRange: [from, to], granularity: 'day' }],
      filters: [{ member: 'ItemSales.location_id', operator: 'equals', values: [locationId] }],
    });
  }

  /**
   * Orders, one row each: table, covers, the server it's attributed to, how and where it was placed,
   * net sales, tips and automatic gratuity. Every order, not only closed checks: a gelato at the
   * counter or an online pickup is paid but stays open until someone marks it done, and Square's own
   * Net sales counts it. Sales leave out automatic gratuity (service charges are really tips): Square's
   * Net sales less them.
   */
  ordersByDay(locationId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['Orders.net_sales_minus_auto_gratuity', 'Orders.cover_count', 'Orders.tips_amount', 'Orders.auto_gratuity_amount'],
      dimensions: ['Orders.order_id', 'Orders.table_name', 'Orders.fulfillment_method', 'Orders.order_source', 'Orders.team_member_attributed_to_id', 'Orders.team_member_attributed_to_name'],
      timeDimensions: [{ dimension: 'Orders.reporting_day', dateRange: [from, to], granularity: 'day' }],
      filters: [{ member: 'Orders.location_id', operator: 'equals', values: [locationId] }],
    });
  }

  /** Closed timecards clocked in on these days, clock times in the restaurant's time zone. */
  timecards(locationId: string, from: string, to: string, timezone: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['Labor.total_hours_worked', 'Labor.total_labor_cost'],
      dimensions: ['Labor.team_member_id', 'Labor.job_title', 'Labor.clockin_timestamp', 'Labor.clockout_timestamp', 'Labor.hourly_wage'],
      timeDimensions: [{ dimension: 'Labor.clockin_timestamp', dateRange: [from, to] }],
      segments: ['Labor.closed_shifts'],
      filters: [{ member: 'Labor.location_id', operator: 'equals', values: [locationId] }],
      timezone,
    });
  }

  /** Sales, orders and covers by day and local hour: every order, as ordersByDay. */
  salesByHour(locationId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['Orders.net_sales_minus_auto_gratuity', 'Orders.cover_count', 'Orders.count'],
      dimensions: ['Orders.local_hour'],
      timeDimensions: [{ dimension: 'Orders.reporting_day', dateRange: [from, to], granularity: 'day' }],
      filters: [{ member: 'Orders.location_id', operator: 'equals', values: [locationId] }],
    });
  }

  /** What was on each order: item, variation, category, quantity and net sales. */
  orderLinesByDay(locationId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['ItemSales.net_quantity', 'ItemSales.item_net_sales'],
      dimensions: ['ItemSales.order_id', 'ItemSales.item_variation_id', 'ItemSales.item_name', 'ItemSales.item_variation_name', 'ItemSales.category_name'],
      timeDimensions: [{ dimension: 'ItemSales.reporting_day', dateRange: [from, to], granularity: 'day' }],
      filters: [{ member: 'ItemSales.location_id', operator: 'equals', values: [locationId] }],
    });
  }

  /** Modifier sales by item and day: what squareModifierSales() reads. */
  modifierSalesByDay(locationId: string, from: string, to: string): Promise<SquareItemSalesRow[]> {
    return this.report({
      measures: ['ItemSales.modifier_net_quantity', 'ItemSales.gross_sales'],
      dimensions: ['ItemSales.item_variation_id', 'ItemSales.item_name', 'ItemSales.item_variation_name', 'ItemSales.modifier_name', 'ItemSales.modifier_list_name'],
      timeDimensions: [{ dimension: 'ItemSales.reporting_day', dateRange: [from, to], granularity: 'day' }],
      filters: [
        { member: 'ItemSales.location_id', operator: 'equals', values: [locationId] },
        { member: 'ItemSales.modifier_name', operator: 'set' },
      ],
    });
  }
}
