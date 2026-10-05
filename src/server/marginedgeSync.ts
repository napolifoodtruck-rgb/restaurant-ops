/**
 * Nightly copy from MarginEdge: products, vendors, pack sizes and invoices. The first sync
 * goes back 6 months; later ones fetch the last 45 days again and keep the rest.
 */

import type { Db } from './db.ts';
import type { MarginEdgeApi } from '../connectors/marginedgeApi.ts';
import type { MarginEdgeExport } from '../connectors/marginedge.ts';

const PARTS = ['categories', 'products', 'vendors', 'vendorItems', 'invoices'] as const;

export async function storedMarginEdge(db: Db, restaurantId: string): Promise<MarginEdgeExport | undefined> {
  const { rows } = await db.query<{ part: (typeof PARTS)[number]; data: any }>('SELECT part, data FROM marginedge_data WHERE restaurant_id = $1', [restaurantId]);
  if (rows.length < PARTS.length) return undefined;
  const out: any = {};
  for (const r of rows) out[r.part] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  return out as MarginEdgeExport;
}

function minusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface MarginEdgeSyncResult { unit: string; from: string; to: string; invoices: number; products: number; vendorItems: number; requests: number }

export async function runMarginEdgeSync(db: Db, api: MarginEdgeApi, restaurantId: string, options: { today: string; unitId?: string; months?: number }): Promise<MarginEdgeSyncResult> {
  const run = await db.query<{ id: string }>("INSERT INTO sync_runs (restaurant_id, source) VALUES ($1, 'marginedge') RETURNING id", [restaurantId]);
  const runId = run.rows[0]!.id;
  try {
    const units = await api.restaurantUnits();
    const unit = options.unitId ? units.find((u) => u.id === options.unitId) : units.length === 1 ? units[0] : undefined;
    if (!unit) throw new Error(units.length ? `This MarginEdge key covers ${units.length} restaurants (${units.map((u) => `${u.name}: ${u.id}`).join(', ')}). Set MARGINEDGE_UNIT_ID to pick one.` : 'This MarginEdge key has no restaurants attached.');
    const previous = await storedMarginEdge(db, restaurantId);
    const from = minusDays(options.today, Math.round((options.months ?? 6) * 30.5));
    // Progress shows on the Settings card while a long first sync runs.
    let lastWrite = 0;
    const onProgress = (step: string) => {
      if (Date.now() - lastWrite < 5000) return;
      lastWrite = Date.now();
      db.query('UPDATE sync_runs SET detail = $1 WHERE id = $2', [JSON.stringify({ progress: step }), runId]).catch(() => {});
    };
    const data = await api.unit(unit.id, { from, to: options.today, onProgress, ...(previous ? { previous, refreshFrom: minusDays(options.today, 45) } : {}) });
    for (const part of PARTS) {
      await db.query(
        `INSERT INTO marginedge_data (restaurant_id, part, data, synced_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (restaurant_id, part) DO UPDATE SET data = EXCLUDED.data, synced_at = now()`,
        [restaurantId, part, JSON.stringify(data[part])],
      );
    }
    const result = { unit: unit.name, from, to: options.today, invoices: data.invoices.length, products: data.products.length, vendorItems: data.vendorItems.length, requests: api.requests };
    await db.query("UPDATE sync_runs SET status = 'ok', finished_at = now(), detail = $1 WHERE id = $2", [JSON.stringify(result), runId]);
    return result;
  } catch (err) {
    await db.query("UPDATE sync_runs SET status = 'failed', finished_at = now(), detail = $1 WHERE id = $2", [JSON.stringify({ error: (err as Error).message }), runId]);
    throw err;
  }
}
