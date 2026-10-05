/**
 * Starts the app: connects to the database, applies any new migrations, serves HTTP.
 *
 * Environment:
 *   DATABASE_URL   PostgreSQL connection string (Render sets it from the database)
 *   PORT           set by Render
 *   SETUP_TOKEN    optional; allows creating the first owner once, then can be removed
 *   NODE_ENV       'production' on Render (secure cookies)
 *   SQUARE_ACCESS_TOKEN   read-only use; 'later' or unset = not connected yet
 *   SQUARE_LOCATION_ID    only needed when the Square account has several locations
 *   MARGINEDGE_API_KEY    read-only use; 'later' or unset = not connected yet
 *   MARGINEDGE_UNIT_ID    only needed when the key covers several restaurants
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { connectPg, migrate } from './db.ts';
import { createApp } from './app.ts';
import { startScheduler } from './scheduler.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const db = await connectPg(url);
const applied = await migrate(db, fileURLToPath(new URL('../../db/migrations', import.meta.url)));
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
// Only one copy of the app runs, so a sync still marked running at startup was cut off by a restart.
await db.query("UPDATE sync_runs SET status = 'failed', finished_at = now(), detail = '{\"error\": \"Interrupted by an app restart. Press Sync now to run it again.\"}' WHERE status = 'running'");

const sync = {
  square: { token: process.env.SQUARE_ACCESS_TOKEN, locationId: process.env.SQUARE_LOCATION_ID || undefined, version: process.env.SQUARE_VERSION || undefined },
  marginedge: { key: process.env.MARGINEDGE_API_KEY, unitId: process.env.MARGINEDGE_UNIT_ID || undefined },
};
const handle = createApp({ db, setupToken: process.env.SETUP_TOKEN || undefined, secureCookies: process.env.NODE_ENV === 'production', sync });
const stopScheduler = startScheduler(db, sync);
const port = Number(process.env.PORT ?? 3000);
const server = createServer(handle);
server.listen(port, () => console.log(`Listening on ${port}`));

const stop = () => (stopScheduler(), server.close(() => db.close().then(() => process.exit(0))));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
