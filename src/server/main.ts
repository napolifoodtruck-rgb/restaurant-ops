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
 *   SQUARE_CHECKOUT_TOKEN        online orders: a token that can create orders and payments
 *   SQUARE_APPLICATION_ID        online orders: the Square app the card form belongs to
 *   SQUARE_CHECKOUT_LOCATION_ID  online orders: the location they're placed at
 *   SQUARE_ENVIRONMENT           'production' to take real payments; anything else is Square's sandbox
 *   RESEND_API_KEY               online orders: confirmation emails through Resend; unset = none sent. Also reads email coming in
 *   RESEND_WEBHOOK_SECRET        email coming in: the signing secret of Resend's "email received" webhook; unset = no inbox
 *   EMAIL_DOMAIN                 the domain invoices@ and reports@ are at (default napolicarrboro.com)
 *   ORDER_EMAIL_FROM             e.g. "Napoli <orders@napolicarrboro.com>" (domain verified in Resend)
 *   ORDER_EMAIL_REPLY_TO         optional: where customers' replies go
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
const checkout = {
  token: process.env.SQUARE_CHECKOUT_TOKEN,
  applicationId: process.env.SQUARE_APPLICATION_ID || undefined,
  locationId: process.env.SQUARE_CHECKOUT_LOCATION_ID || undefined,
  environment: process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' as const : 'sandbox' as const,
  version: process.env.SQUARE_VERSION || undefined,
  email: { apiKey: process.env.RESEND_API_KEY, from: process.env.ORDER_EMAIL_FROM || undefined, replyTo: process.env.ORDER_EMAIL_REPLY_TO || undefined },
};
// Email coming in (invoices@, reports@ at EMAIL_DOMAIN) through Resend's receiving webhook.
const inbox = { apiKey: process.env.RESEND_API_KEY || undefined, webhookSecret: process.env.RESEND_WEBHOOK_SECRET || undefined, domain: process.env.EMAIL_DOMAIN || 'napolicarrboro.com' };
const handle = createApp({ db, setupToken: process.env.SETUP_TOKEN || undefined, secureCookies: process.env.NODE_ENV === 'production', sync, checkout, inbox });
const stopScheduler = startScheduler(db, sync);
const port = Number(process.env.PORT ?? 3000);
const server = createServer(handle);
server.listen(port, () => console.log(`Listening on ${port}`));

const stop = () => (stopScheduler(), server.close(() => db.close().then(() => process.exit(0))));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
