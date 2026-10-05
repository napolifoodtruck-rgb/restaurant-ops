/**
 * Starts the app: connects to the database, applies any new migrations, serves HTTP.
 *
 * Environment:
 *   DATABASE_URL   PostgreSQL connection string (Render sets it from the database)
 *   PORT           set by Render
 *   SETUP_TOKEN    optional; allows creating the first owner once, then can be removed
 *   NODE_ENV       'production' on Render (secure cookies)
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { connectPg, migrate } from './db.ts';
import { createApp } from './app.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const db = await connectPg(url);
const applied = await migrate(db, fileURLToPath(new URL('../../db/migrations', import.meta.url)));
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const handle = createApp({ db, setupToken: process.env.SETUP_TOKEN || undefined, secureCookies: process.env.NODE_ENV === 'production' });
const port = Number(process.env.PORT ?? 3000);
const server = createServer(handle);
server.listen(port, () => console.log(`Listening on ${port}`));

const stop = () => server.close(() => db.close().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
