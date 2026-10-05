/**
 * Runs the nightly syncs (Square, then MarginEdge) after 4 am in the restaurant's own time
 * zone, from inside the web app (no separate cron service to pay for). Checks every 10
 * minutes; a sync that already ran or is running today is left alone.
 */

import type { Db } from './db.ts';
import { SquareApi } from '../connectors/squareApi.ts';
import { MarginEdgeApi } from '../connectors/marginedgeApi.ts';
import { runSquareSync } from './squareSync.ts';
import { runMarginEdgeSync } from './marginedgeSync.ts';

export function localDateHour(timezone: string, now = new Date()): { date: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export interface SquareSettings { token?: string; locationId?: string; version?: string }
export interface MarginEdgeSettings { key?: string; unitId?: string }
export interface SyncSettings { square?: SquareSettings; marginedge?: MarginEdgeSettings }

const usable = (secret?: string) => {
  const s = secret?.trim();
  return s && s.toLowerCase() !== 'later' ? s : undefined;
};

export function squareApiFrom(settings: SquareSettings): SquareApi | undefined {
  const token = usable(settings.token);
  return token ? new SquareApi(token, settings.version ? { version: settings.version } : {}) : undefined;
}

export function marginEdgeApiFrom(settings: MarginEdgeSettings): MarginEdgeApi | undefined {
  const key = usable(settings.key);
  return key ? new MarginEdgeApi(key) : undefined;
}

type Source = 'square' | 'marginedge';

/** Runs one source's sync for a restaurant. Exported so "Sync now" uses the same path. */
export async function runSync(db: Db, source: Source, settings: SyncSettings, restaurantId: string, today: string): Promise<unknown> {
  if (source === 'square') {
    const api = squareApiFrom(settings.square ?? {});
    if (!api) throw new Error('Square isn’t connected.');
    return runSquareSync(db, api, restaurantId, { today, ...(settings.square?.locationId ? { locationId: settings.square.locationId } : {}) });
  }
  const api = marginEdgeApiFrom(settings.marginedge ?? {});
  if (!api) throw new Error('MarginEdge isn’t connected.');
  return runMarginEdgeSync(db, api, restaurantId, { today, ...(settings.marginedge?.unitId ? { unitId: settings.marginedge.unitId } : {}) });
}

/** Syncs every restaurant and source that is due. Returns how many ran. */
export async function syncDue(db: Db, settings: SyncSettings, now = new Date(), runHour = 4): Promise<number> {
  const sources: Source[] = [];
  if (squareApiFrom(settings.square ?? {})) sources.push('square');
  if (marginEdgeApiFrom(settings.marginedge ?? {})) sources.push('marginedge');
  let ran = 0;
  for (const source of sources) {
    const { rows } = await db.query<{ id: string; timezone: string; last_started: string | null; last_status: string | null }>(
      `SELECT r.id, r.timezone, s.started_at AS last_started, s.status AS last_status
         FROM restaurants r
         LEFT JOIN LATERAL (SELECT started_at, status FROM sync_runs WHERE restaurant_id = r.id AND source = $1 ORDER BY started_at DESC LIMIT 1) s ON true`,
      [source],
    );
    for (const r of rows) {
      const local = localDateHour(r.timezone, now);
      if (local.hour < runHour) continue;
      if (r.last_started) {
        const last = new Date(r.last_started);
        const age = now.getTime() - last.getTime();
        if (r.last_status === 'running' && age < 2 * 3_600_000) continue;
        if (r.last_status === 'ok' && localDateHour(r.timezone, last).date === local.date) continue;
        // A failed run is retried, but not more than once an hour.
        if (r.last_status === 'failed' && age < 3_600_000) continue;
      }
      try {
        await runSync(db, source, settings, r.id, local.date);
        ran++;
      } catch (err) {
        console.error(`${source} sync failed for ${r.id}: ${(err as Error).message}`);
      }
    }
  }
  return ran;
}

export function startScheduler(db: Db, settings: SyncSettings, everyMs = 10 * 60_000): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await syncDue(db, settings); } catch (err) { console.error(err); } finally { busy = false; }
  };
  const timer = setInterval(tick, everyMs);
  setTimeout(tick, 30_000);
  return () => clearInterval(timer);
}
