/**
 * Runs the Square sync once a night, after 4 am in the restaurant's own time zone, from
 * inside the web app (no separate cron service to pay for). Checks every 10 minutes; a
 * sync that already ran or is running today is left alone.
 */

import type { Db } from './db.ts';
import { SquareApi } from '../connectors/squareApi.ts';
import { runSquareSync } from './squareSync.ts';

export function localDateHour(timezone: string, now = new Date()): { date: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export interface SquareSettings { token?: string; locationId?: string; version?: string }

export function squareApiFrom(settings: SquareSettings): SquareApi | undefined {
  const token = settings.token?.trim();
  if (!token || token.toLowerCase() === 'later') return undefined;
  return new SquareApi(token, settings.version ? { version: settings.version } : {});
}

/** Syncs every restaurant that is due. Returns how many ran. */
export async function syncDue(db: Db, settings: SquareSettings, now = new Date(), runHour = 4): Promise<number> {
  const api = squareApiFrom(settings);
  if (!api) return 0;
  const { rows } = await db.query<{ id: string; timezone: string; last_started: string | null; last_status: string | null }>(
    `SELECT r.id, r.timezone, s.started_at AS last_started, s.status AS last_status
       FROM restaurants r
       LEFT JOIN LATERAL (SELECT started_at, status FROM sync_runs WHERE restaurant_id = r.id AND source = 'square' ORDER BY started_at DESC LIMIT 1) s ON true`,
  );
  let ran = 0;
  for (const r of rows) {
    const local = localDateHour(r.timezone, now);
    if (local.hour < runHour) continue;
    if (r.last_started) {
      const last = new Date(r.last_started);
      const lastLocal = localDateHour(r.timezone, last).date;
      const stale = now.getTime() - last.getTime() > 2 * 3_600_000;
      if (r.last_status === 'running' && !stale) continue;
      if (r.last_status === 'ok' && lastLocal === local.date) continue;
      // A failed run is retried, but not more than once an hour.
      if (r.last_status === 'failed' && now.getTime() - last.getTime() < 3_600_000) continue;
    }
    try {
      await runSquareSync(db, api, r.id, { today: local.date, ...(settings.locationId ? { locationId: settings.locationId } : {}) });
      ran++;
    } catch (err) {
      console.error(`Square sync failed for ${r.id}: ${(err as Error).message}`);
    }
  }
  return ran;
}

export function startScheduler(db: Db, settings: SquareSettings, everyMs = 10 * 60_000): () => void {
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
