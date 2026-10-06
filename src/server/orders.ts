/**
 * Orders over HTTP. Managers only. Nothing is ever sent from here: a manager approves an order,
 * then copies, emails or prints it and marks it sent.
 *
 *   GET  /api/orders?area=kitchen|bar|both        vendors: delivery days, next delivery, when the order's due, its status
 *   GET  /api/orders/vendor/:vendorId          the order for the next delivery (a fresh draft if there isn't one)
 *   POST /api/orders/vendor/:vendorId          { delivery, lines: [{ productId, packs, onHand? }], note? }  save the draft
 *   POST /api/orders/vendor/:vendorId/settings { weekdays?, cutoffDaysBefore?, cutoffTime?, method?, contact?, minimum?, active? }
 *   POST /api/orders/:id/approve               a manager approves (only a draft with lines)
 *   POST /api/orders/:id/sent                  marked sent, after approval
 *   POST /api/orders/:id/reopen                back to a draft (until it's sent)
 *   POST /api/orders/:id/cancel
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, type SignedIn } from './auth.ts';
import { getModel } from './model.ts';
import { localDateHour } from './scheduler.ts';
import { deliveryToOrderFor, estimateOnHand, inferDeliveryDays, nextDeliveries, orderDeadline, purchaseRates, recommendLine, weekdayWeights, type DeliverySchedule } from '../core/ordering.ts';
import { addDays } from '../core/forecast.ts';

interface SettingsRow { vendor_id: string; weekdays: number[] | string | null; cutoff_days_before: number | null; cutoff_time: string | null; method: string | null; contact: string | null; minimum: string | null; active: boolean; note: string | null }
interface OrderRow { id: string; vendor_id: string; vendor_name: string; delivery: string; status: string; lines: any; total: string | null; note: string | null; approved_at: Date | null; approved_name: string | null; sent_at: Date | null; sent_name: string | null; created_name: string | null; updated_at: Date }

const BAR_TYPES = new Set(['WINE', 'BEER', 'LIQUOR', 'NA_BEVERAGES']);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const money = (v: number) => Math.round(v * 100) / 100;
const arr = (v: unknown): number[] | null => (v === null || v === undefined ? null : (typeof v === 'string' ? v.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number) : (v as number[]).map(Number)));

/** Everything ordering needs from the invoices and sales, worked out once per request. */
async function orderingData(db: Db, who: SignedIn, today: string) {
  const model = await getModel(db, who.restaurantId, today);
  const settings = new Map((await db.query<SettingsRow>('SELECT * FROM vendor_settings WHERE restaurant_id = $1', [who.restaurantId])).rows.map((r) => [r.vendor_id, r]));
  const since = addDays(today, -120);
  const invoices = model.imported.invoices.filter((i) => i.vendorExternalId && i.invoiceDate && !i.isCredit && i.invoiceDate.slice(0, 10) > since);
  const learned = new Map(inferDeliveryDays(invoices.map((i) => ({ vendorId: i.vendorExternalId!, date: i.invoiceDate!.slice(0, 10) }))).map((s) => [s.vendorId, s]));
  const products = new Map(model.imported.products.map((p) => [p.externalId, p]));
  // Purchases in each product's base unit: the pack's size is its price over the price per base unit.
  const purchases = model.imported.prices.filter((p) => p.perBaseUnit > 0 && p.quantity > 0).map((p) => ({ ...p, packSize: p.price / p.perBaseUnit, date: p.date.slice(0, 10) }));
  const rates = purchaseRates(purchases.map((p) => ({ productId: p.productExternalId, date: p.date, amount: p.quantity * p.packSize })), today);
  const daily = (await db.query<{ day: string; net: string }>('SELECT day::text AS day, sum(net_sales) AS net FROM pos_item_sales_daily WHERE restaurant_id = $1 AND day >= $2 AND day < $3 GROUP BY day', [who.restaurantId, addDays(today, -56), today])).rows;
  const weights = weekdayWeights(daily.map((d) => ({ date: d.day, netSales: Number(d.net) })));
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const useOf = (productId: string) => { const r = rates.get(productId) ?? 0; return (d: string) => r * weights[weekday(d)]!; };
  const scheduleOf = (vendorId: string): DeliverySchedule | undefined => {
    const s = settings.get(vendorId), l = learned.get(vendorId);
    const confirmed = arr(s?.weekdays ?? null);
    const base: DeliverySchedule | undefined = confirmed?.length ? { vendorId, weekdays: confirmed, counts: l?.counts ?? [], deliveries: l?.deliveries ?? 0, source: 'confirmed' } : l;
    if (!base) return undefined;
    return { ...base, ...(s?.cutoff_days_before !== null && s?.cutoff_days_before !== undefined && s.cutoff_time ? { cutoff: { daysBefore: s.cutoff_days_before, time: s.cutoff_time } } : {}) };
  };
  return { model, settings, invoices, learned, products, purchases, rates, weights, useOf, scheduleOf };
}
type Data = Awaited<ReturnType<typeof orderingData>>;

/** What a vendor sells you: each product's latest pack and price from that vendor. */
function catalogOf(data: Data, vendorId: string) {
  const latest = new Map<string, Data['purchases'][number]>();
  for (const p of data.purchases) if (p.vendorExternalId === vendorId && (latest.get(p.productExternalId)?.date ?? '') <= p.date) latest.set(p.productExternalId, p);
  return [...latest.values()].map((p) => {
    const product = data.products.get(p.productExternalId);
    const unit = product?.baseUnit ?? p.per.unit;
    const packSize = Math.round(p.packSize * 1000) / 1000;
    // What one pack holds as invoiced ("25 kg"), with the base amount when the units differ ("25 kg (55 lb)").
    const plural = (n: number, u: string) => (n === 1 || /^(lb|kg|g|oz|ml|l|floz|gal|qt|pt|each)$/.test(u) ? u : u.endsWith('s') ? u : `${u}s`);
    const asBought = `${+(+p.per.amount).toFixed(2)} ${plural(+p.per.amount, p.per.unit)}`;
    const packLabel = p.per.unit && p.per.unit !== unit ? `${asBought} (${fmt(packSize)} ${plural(packSize, unit)})` : `${+packSize.toFixed(2)} ${plural(packSize, unit)}`;
    return { productId: p.productExternalId, name: product?.name ?? p.productExternalId, unit, packSize, packLabel, packPrice: money(p.price), lastBought: p.date, type: product?.categoryType };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function vendorName(data: Data, vendorId: string) {
  return data.model.imported.vendors.find((v) => v.externalId === vendorId)?.name ?? data.invoices.find((i) => i.vendorExternalId === vendorId)?.vendorName ?? vendorId;
}

/** Which side orders from a vendor: the bar when most of the spend is wine, beer, liquor or drinks. */
function sideOf(data: Data, vendorId: string): 'kitchen' | 'bar' {
  let bar = 0, all = 0;
  for (const i of data.invoices.filter((x) => x.vendorExternalId === vendorId)) for (const l of i.lines) {
    all += Math.abs(l.lineTotal);
    if (BAR_TYPES.has(data.products.get(l.productExternalId ?? '')?.categoryType ?? '')) bar += Math.abs(l.lineTotal);
  }
  return all > 0 && bar / all > 0.5 ? 'bar' : 'kitchen';
}

/** A fresh draft: every product the vendor sells you that will run short before the delivery after this one. */
function draftLines(data: Data, vendorId: string, today: string, delivery: string, following: string, counts: Map<string, number> = new Map()) {
  return catalogOf(data, vendorId).map((c) => {
    const use = data.useOf(c.productId);
    const weekly = (data.rates.get(c.productId) ?? 0) * 7;
    // Estimated from the last few deliveries: what came in since each, less what's been used since.
    const bought = data.purchases.filter((p) => p.productExternalId === c.productId).sort((a, b) => b.date.localeCompare(a.date));
    const counted = counts.get(c.productId);
    let onHand = counted ?? 0;
    if (counted === undefined) {
      let sum = 0;
      for (const p of bought.slice(0, 3)) { sum += p.quantity * p.packSize; onHand = Math.max(onHand, estimateOnHand({ date: p.date, amount: sum }, use, today)); }
    }
    const line = weekly > 0 ? recommendLine({ productId: c.productId, onHand, onHandIsEstimate: counted === undefined, dailyUse: use, packSize: c.packSize, packName: c.packLabel, packPrice: c.packPrice }, today, delivery, following, { safety: 0.1, estimateSafety: 0.15 }) : undefined;
    return {
      ...c,
      weeklyUse: Math.round(weekly * 100) / 100,
      onHand: Math.round(onHand * 100) / 100,
      onHandEstimated: counted === undefined,
      suggested: line?.packs ?? 0,
      packs: line?.packs ?? 0,
      reason: weekly > 0
        ? `About ${fmt(weekly)} ${c.unit} a week lately${line ? `; ${fmt(line.coverNeeded)} ${c.unit} until ${dayName(following)}` : ''}, ${fmt(onHand)} ${c.unit} on hand${counted === undefined ? ' (estimated from recent deliveries)' : ' (counted)'}.`
        : `Not bought in the last 8 weeks.`,
    };
  });
}
const fmt = (n: number) => (n >= 10 ? String(Math.round(n)) : String(+n.toFixed(1)));
const dayName = (d: string) => `${DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;

async function orderFor(db: Db, who: SignedIn, vendorId: string, delivery: string) {
  return (await db.query<OrderRow>(
    `SELECT o.*, o.delivery::text AS delivery, a.display_name AS approved_name, s.display_name AS sent_name, c.display_name AS created_name
       FROM orders o LEFT JOIN staff a ON a.id = o.approved_by LEFT JOIN staff s ON s.id = o.sent_by LEFT JOIN staff c ON c.id = o.created_by
      WHERE o.restaurant_id = $1 AND o.vendor_id = $2 AND o.delivery = $3 AND o.status <> 'cancelled'`, [who.restaurantId, vendorId, delivery])).rows[0];
}

/** The vendors worth ordering from: delivery days learned or confirmed, and active. */
function vendorsView(data: Data, today: string, now: string) {
  const ids = new Set([...data.learned.keys(), ...[...data.settings.values()].filter((s) => arr(s.weekdays)?.length).map((s) => s.vendor_id)]);
  return [...ids].map((vendorId) => {
    const schedule = data.scheduleOf(vendorId)!;
    const s = data.settings.get(vendorId);
    const next = deliveryToOrderFor(schedule, today, now);
    const spend = data.invoices.filter((i) => i.vendorExternalId === vendorId && i.invoiceDate!.slice(0, 10) > addDays(today, -56)).reduce((a, i) => a + i.total, 0);
    return {
      vendorId, name: vendorName(data, vendorId), side: sideOf(data, vendorId),
      weekdays: schedule.weekdays, source: schedule.source, deliveries: schedule.deliveries,
      ...(schedule.cutoff ? { cutoff: schedule.cutoff } : {}),
      ...(next ? { next: next.delivery, ...(next.deadline ? { deadline: next.deadline } : {}) } : {}),
      method: s?.method ?? null, contact: s?.contact ?? null, minimum: s?.minimum ? Number(s.minimum) : null, active: s?.active ?? true,
      spendPerWeek: Math.round(spend / 8),
    };
  }).filter((v) => v.weekdays.length).sort((a, b) => Number(!a.active) - Number(!b.active) || (a.deadline?.date ?? a.next ?? '9').localeCompare(b.deadline?.date ?? b.next ?? '9') || b.spendPerWeek - a.spendPerWeek);
}

function orderView(o: OrderRow) {
  const lines = typeof o.lines === 'string' ? JSON.parse(o.lines) : o.lines;
  return { id: o.id, status: o.status, delivery: o.delivery, lines, total: o.total === null ? null : Number(o.total), note: o.note, createdBy: o.created_name, approvedBy: o.approved_name, approvedAt: o.approved_at, sentBy: o.sent_name, sentAt: o.sent_at, updatedAt: o.updated_at };
}

export async function orderRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, who: SignedIn): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/orders')) return false;
  if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
  const tz = (await db.query<{ timezone: string; name: string }>('SELECT timezone, name FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0];
  const local = localDateHour(tz?.timezone ?? 'America/New_York');
  const today = local.date;
  const nowParts = new Intl.DateTimeFormat('en-GB', { timeZone: tz?.timezone ?? 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/orders') {
    const data = await orderingData(db, who, today);
    const area = url.searchParams.get('area');
    // Kitchen, bar, or both together for the whole picture.
    const vendors = vendorsView(data, today, nowParts).filter((v) => !area || area === 'both' || v.side === area);
    const open = (await db.query<OrderRow & { delivery: string }>("SELECT id, vendor_id, delivery::text AS delivery, status, total, sent_at, approved_at FROM orders WHERE restaurant_id = $1 AND status <> 'cancelled' AND delivery >= $2", [who.restaurantId, addDays(today, -1)])).rows;
    const recent = (await db.query<OrderRow>(
      `SELECT o.*, o.delivery::text AS delivery, a.display_name AS approved_name, s.display_name AS sent_name, NULL AS created_name FROM orders o LEFT JOIN staff a ON a.id = o.approved_by LEFT JOIN staff s ON s.id = o.sent_by
        WHERE o.restaurant_id = $1 AND o.status IN ('approved', 'sent') ORDER BY o.delivery DESC, o.updated_at DESC LIMIT 20`, [who.restaurantId])).rows;
    return send(res, 200, {
      today,
      vendors: vendors.map((v) => {
        const o = open.find((x) => x.vendor_id === v.vendorId && x.delivery === v.next);
        return { ...v, ...(o ? { order: { id: o.id, status: o.status, total: o.total === null ? null : Number(o.total) } } : {}) };
      }),
      recent: recent.filter((o) => !area || vendors.some((v) => v.vendorId === o.vendor_id)).map((o) => ({ ...orderView(o), vendorId: o.vendor_id, vendorName: o.vendor_name })),
    }), true;
  }

  if ((m = path.match(/^\/api\/orders\/vendor\/([^/]+)$/)) && method === 'GET') {
    const vendorId = decodeURIComponent(m[1]!);
    const data = await orderingData(db, who, today);
    const schedule = data.scheduleOf(vendorId);
    if (!schedule) throw new HttpError(404, 'No delivery days for that vendor yet.');
    const asked = url.searchParams.get('delivery');
    const next = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? { delivery: asked, following: nextDeliveries(schedule, addDays(asked, 1), 1)[0], deadline: orderDeadline(schedule, asked) } : deliveryToOrderFor(schedule, today, nowParts);
    if (!next) throw new HttpError(404, 'No delivery coming up.');
    const following = next.following ?? addDays(next.delivery, schedule.typicalGap ?? 7);
    const saved = await orderFor(db, who, vendorId, next.delivery);
    const s = data.settings.get(vendorId);
    // A saved order keeps its lines; the rest of the vendor's products are there to add.
    const fresh = draftLines(data, vendorId, today, next.delivery, following, new Map(((saved ? orderView(saved).lines : []) as any[]).filter((l) => l.onHand !== undefined && !l.onHandEstimated).map((l) => [l.productId, Number(l.onHand)])));
    return send(res, 200, {
      vendor: {
        vendorId, name: vendorName(data, vendorId), side: sideOf(data, vendorId), weekdays: schedule.weekdays, learned: data.learned.get(vendorId)?.weekdays ?? [], source: schedule.source,
        ...(schedule.cutoff ? { cutoff: schedule.cutoff } : {}), method: s?.method ?? null, contact: s?.contact ?? null, minimum: s?.minimum ? Number(s.minimum) : null, active: s?.active ?? true, note: s?.note ?? null,
      },
      today, delivery: next.delivery, following, ...(next.deadline ? { deadline: next.deadline } : {}),
      upcoming: nextDeliveries(schedule, addDays(today, 1), 4),
      ...(saved ? { order: orderView(saved) } : {}),
      draft: fresh,
      restaurant: tz?.name ?? '',
    }), true;
  }

  if ((m = path.match(/^\/api\/orders\/vendor\/([^/]+)$/)) && method === 'POST') {
    const vendorId = decodeURIComponent(m[1]!);
    const b = await body(req, 256 * 1024);
    if (typeof b.delivery !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.delivery)) throw new HttpError(400, 'Which delivery?');
    const data = await orderingData(db, who, today);
    const catalog = new Map(catalogOf(data, vendorId).map((c) => [c.productId, c]));
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: any) => {
      const c = catalog.get(String(l.productId));
      if (!c) throw new HttpError(400, 'That product isn’t bought from this vendor.');
      const packs = Number(l.packs);
      if (!(packs >= 0) || !Number.isFinite(packs)) throw new HttpError(400, `How many ${c.packLabel} of ${c.name}?`);
      const onHand = l.onHand === null || l.onHand === undefined || l.onHand === '' ? undefined : Number(l.onHand);
      return { productId: c.productId, name: c.name, packs, packLabel: c.packLabel, packSize: c.packSize, unit: c.unit, packPrice: c.packPrice, ...(onHand !== undefined && onHand >= 0 ? { onHand, onHandEstimated: false } : {}), ...(l.suggested !== undefined ? { suggested: Number(l.suggested) } : {}) };
    });
    const total = money(lines.reduce((s: number, l: any) => s + l.packs * (l.packPrice ?? 0), 0));
    const existing = await orderFor(db, who, vendorId, b.delivery);
    if (existing && existing.status !== 'draft') throw new HttpError(409, existing.status === 'sent' ? 'This order was already sent.' : 'This order is approved. Reopen it to change it.');
    if (existing) await db.query('UPDATE orders SET lines = $1, total = $2, note = $3, updated_at = now() WHERE id = $4', [JSON.stringify(lines), total, typeof b.note === 'string' ? b.note : existing.note, existing.id]);
    else await db.query('INSERT INTO orders (restaurant_id, vendor_id, vendor_name, delivery, lines, total, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [who.restaurantId, vendorId, vendorName(data, vendorId), b.delivery, JSON.stringify(lines), total, typeof b.note === 'string' ? b.note : null, who.staffId]);
    return send(res, 200, { order: orderView((await orderFor(db, who, vendorId, b.delivery))!) }), true;
  }

  if ((m = path.match(/^\/api\/orders\/vendor\/([^/]+)\/settings$/)) && method === 'POST') {
    const vendorId = decodeURIComponent(m[1]!);
    const b = await body(req);
    const weekdays = Array.isArray(b.weekdays) ? (b.weekdays as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : null;
    const cutoffDays = b.cutoffDaysBefore === null || b.cutoffDaysBefore === undefined || b.cutoffDaysBefore === '' ? null : Number(b.cutoffDaysBefore);
    if (cutoffDays !== null && !(Number.isInteger(cutoffDays) && cutoffDays >= 0 && cutoffDays <= 7)) throw new HttpError(400, 'Order 0 to 7 days ahead.');
    const cutoffTime = typeof b.cutoffTime === 'string' && /^\d{2}:\d{2}$/.test(b.cutoffTime) ? b.cutoffTime : null;
    const methodName = typeof b.method === 'string' && ['email', 'text', 'phone', 'portal', 'rep', 'in person'].includes(b.method) ? b.method : null;
    const minimum = b.minimum === null || b.minimum === undefined || b.minimum === '' ? null : Number(b.minimum);
    await db.query(
      `INSERT INTO vendor_settings (restaurant_id, vendor_id, weekdays, cutoff_days_before, cutoff_time, method, contact, minimum, active, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (restaurant_id, vendor_id) DO UPDATE SET weekdays = EXCLUDED.weekdays, cutoff_days_before = EXCLUDED.cutoff_days_before, cutoff_time = EXCLUDED.cutoff_time,
         method = EXCLUDED.method, contact = EXCLUDED.contact, minimum = EXCLUDED.minimum, active = EXCLUDED.active, note = EXCLUDED.note, updated_at = now()`,
      [who.restaurantId, vendorId, weekdays && weekdays.length ? `{${[...new Set(weekdays)].sort().join(',')}}` : null, cutoffDays, cutoffTime, methodName,
        typeof b.contact === 'string' && b.contact.trim() ? b.contact.trim() : null, minimum !== null && minimum >= 0 ? minimum : null, b.active !== false, typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null]);
    return send(res, 200, { ok: true }), true;
  }

  if ((m = path.match(/^\/api\/orders\/([0-9a-f-]{36})\/(approve|sent|reopen|cancel)$/)) && method === 'POST') {
    const o = (await db.query<{ id: string; status: string; lines: any }>('SELECT id, status, lines FROM orders WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, m[1]])).rows[0];
    if (!o) throw new HttpError(404, 'No such order.');
    const lines = (typeof o.lines === 'string' ? JSON.parse(o.lines) : o.lines) as any[];
    const action = m[2];
    if (action === 'approve') {
      if (o.status !== 'draft') throw new HttpError(409, 'Only a draft can be approved.');
      if (!lines.some((l) => l.packs > 0)) throw new HttpError(400, 'Nothing to order.');
      await db.query("UPDATE orders SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2", [who.staffId, o.id]);
    } else if (action === 'sent') {
      // Never sent without approval.
      if (o.status !== 'approved') throw new HttpError(409, 'A manager approves an order before it’s sent.');
      await db.query("UPDATE orders SET status = 'sent', sent_by = $1, sent_at = now(), updated_at = now() WHERE id = $2", [who.staffId, o.id]);
    } else if (action === 'reopen') {
      if (o.status !== 'approved') throw new HttpError(409, o.status === 'sent' ? 'It was already sent; call the vendor to change it.' : 'It’s already a draft.');
      await db.query("UPDATE orders SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1", [o.id]);
    } else {
      if (o.status === 'sent') throw new HttpError(409, 'It was already sent; call the vendor to cancel it.');
      await db.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [o.id]);
    }
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

/** For Today: orders due soon that nobody has approved yet. */
export async function ordersDue(db: Db, who: SignedIn, today: string) {
  const data = await orderingData(db, who, today);
  const nowParts = '00:00';
  const vendors = vendorsView(data, today, nowParts).filter((v) => v.active && v.next && v.deliveries >= 6);
  const open = (await db.query<{ vendor_id: string; delivery: string; status: string }>("SELECT vendor_id, delivery::text AS delivery, status FROM orders WHERE restaurant_id = $1 AND status <> 'cancelled' AND delivery >= $2", [who.restaurantId, today])).rows;
  return vendors.filter((v) => {
    const o = open.find((x) => x.vendor_id === v.vendorId && x.delivery === v.next);
    if (o && o.status !== 'draft') return false;
    // Due within two days, or (with no cutoff set) delivering within three.
    return v.deadline ? v.deadline.date <= addDays(today, 1) : v.next! <= addDays(today, 3);
  }).map((v) => ({ ...v, draft: open.some((x) => x.vendor_id === v.vendorId && x.delivery === v.next) }));
}
