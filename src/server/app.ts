/**
 * The web app: a small JSON API on node:http. Screens come later; this is what they call.
 *
 *   GET  /, /app.js, /app.css     the web app (web/)
 *   GET  /health                 for Render's health check
 *   GET  /api/setup              whether first-time setup is open
 *   POST /api/setup              first owner and restaurant, once, with SETUP_TOKEN
 *   POST /api/login/password     { email, password }
 *   POST /api/devices            { name, stationId? } (manager or up): enroll this iPad
 *   GET  /api/devices            the kitchen iPads and their stations (manager or up)
 *   POST /api/devices/:id        { name?, stationId?, revoke? } (manager or up)
 *   GET  /api/devices/staff      names for the PIN screen (enrolled iPad only)
 *   POST /api/login/pin          { staffId, pin } (enrolled iPad only)
 *   POST /api/logout
 *   GET  /api/me                 who's signed in, and this iPad's station if it has one
 *   POST /api/staff/:id/pin      { pin } yourself; a manager for staff; an admin for anyone but the owner
 *   GET  /api/staff              the team with access, PINs and email sign-in (manager or up)
 *   POST /api/staff/:id/access   { access: staff|manager|admin } (owner or admin; never the owner)
 *   POST /api/staff/:id/area     { area: kitchen|bar|both } yourself, or an admin for anyone
 *   GET|POST /api/areas          which categories are kitchen and which bar: see areas.ts
 *   POST /api/staff/:id/invite   { email } (owner or admin): a one-time link to set a password
 *   GET  /api/invites/:token     whose invite this is
 *   POST /api/invites/:token     { password }: set it and sign in
 *   GET  /api/sync               last syncs and what's connected (manager or up)
 *   POST /api/sync/:source       start a Square or MarginEdge sync now (manager or up)
 *   GET  /api/book               which parts of the kitchen book are loaded (manager or up)
 *   POST /api/book/import        load recipe cards and answers from a kitchen-book file (manager or up)
 *   GET  /api/margins            margins by category, last 90 days or ?from=&to= (manager or up)
 *   GET  /api/menu               the menu from sales, what came off, to-dos (manager or up)
 *   POST /api/answers            answer a menu question: link, new dish, not food, dismiss (manager or up)
 *   /api/prep/…                  station prep lists: see prep.ts
 *   /api/plans/…                 dishes coming to the menu: see plans.ts
 *   GET  /api/today              what needs someone today: see today.ts
 *   /api/cards/…                 recipe cards, written in the app, and bar drafts: see cards.ts
 *   GET  /api/recipes[/:name]    the recipe book, for anyone signed in: see recipes.ts
 *   /api/orders/…                vendor orders: drafted, approved by a manager, then sent: see orders.ts
 *   /api/online/…                online ordering: what's sold online, pickup windows (manager or up): see online.ts
 *   GET  /order, /order.js, /order.css   the customers' ordering page (public)
 *   /api/order/…                 customers ordering online: menu, checkout, payment (public): see onlineCheckout.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Db } from './db.ts';
import { inTurn } from './turns.ts';
import { modifierRoutes } from './modifierRoutes.ts';
import { HttpError, body, cookie, cookies, send, str } from './http.ts';
import {
  ACCESS, atLeast, canAdminister, deviceFor, hashSecret, tokenHash, newToken, passwordProblem, pinProblem, sessionFor, signInWithPassword, signInWithPin, signOut,
  type SignedIn, type SignInResult,
} from './auth.ts';
import { localDateHour, marginEdgeApiFrom, runSync, squareApiFrom, type SyncSettings } from './scheduler.ts';
import { posName } from '../core/menuLinks.ts';
import { BOOK_KEYS, PRODUCT_ANSWERS, answerProblem, bookProblem, getModel, loadBook, saveBook, withAnswer, withoutAnswer, recentAnswers, withProductAnswer, type Answer } from './model.ts';
import { marginsView, menuView, posItemOf } from './views.ts';
import { prepRoutes } from './prep.ts';
import { planRoutes } from './plans.ts';
import { SNOOZE_MORNING, todayView } from './today.ts';
import { cardRoutes } from './cards.ts';
import { orderRoutes } from './orders.ts';
import { onlineRoutes } from './online.ts';
import { checkoutRoutes, type CheckoutSettings } from './onlineCheckout.ts';
import { reportRoutes } from './reports.ts';
import { costRoutes } from './costs.ts';
import { ideaRoutes } from './ideas.ts';
import { unitRoutes } from './units.ts';
import { recipeRoutes } from './recipes.ts';
import { areaFor, areaRoutes, loadAreas } from './areas.ts';

export interface AppConfig {
  db: Db;
  /** Allows /api/setup while no restaurant exists. Unset = setup closed. */
  setupToken?: string;
  /** Secure cookies (true everywhere but local development). */
  secureCookies: boolean;
  sync?: SyncSettings;
  /** Square for online orders: unset = the ordering page shows but doesn't take orders. */
  checkout?: CheckoutSettings;
}

const SESSION_COOKIE = 'ops_session';
const INVITE_DAYS = 7;
const DEVICE_COOKIE = 'ops_device';
function signInReply(res: ServerResponse, result: SignInResult, secure: boolean): void {
  if (!result.ok) {
    send(res, result.reason === 'locked' ? 423 : 401, result.reason === 'locked'
      ? { error: 'Too many wrong tries. Try again in a few minutes.', lockedUntil: result.lockedUntil }
      : { error: 'That didn’t match.' });
    return;
  }
  send(res, 200, { me: result.who }, { 'set-cookie': cookie(SESSION_COOKIE, result.token, result.expiresAt, secure) });
}

/** Routes that rewrite the kitchen book (recipe cards, answers, menu status). */
const bookWrites = (path: string) => ['/api/book', '/api/book/import', '/api/answers', '/api/answers/undo', '/api/menu/status', '/api/menu/price-variation', '/api/modifiers/answer'].includes(path)
  || (path.startsWith('/api/cards') && path !== '/api/cards/preview');

const WEB_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
// The customers' ordering page: public, and the only page Square's card form runs on.
const ORDER_FILES: Record<string, { file: string; type: string }> = {
  '/order': { file: 'order.html', type: 'text/html; charset=utf-8' },
  '/order.js': { file: 'order.js', type: 'text/javascript; charset=utf-8' },
  '/order.css': { file: 'order.css', type: 'text/css; charset=utf-8' },
};
const WEB_DIR = new URL('../../web/', import.meta.url);
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.s3.amazonaws.com https://*.s3.us-west-2.amazonaws.com https://*.squarecdn.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Square's Web Payments SDK loads from its CDN and puts the card fields in its own frames. The new
// website may show the page in a frame of its own.
const SQUARE_JS = 'https://web.squarecdn.com https://sandbox.web.squarecdn.com';
const ORDER_CSP = `default-src 'self'; script-src 'self' ${SQUARE_JS}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${SQUARE_JS}; font-src https://fonts.gstatic.com https://*.squarecdn.com; img-src 'self' data: https://*.s3.amazonaws.com https://*.s3.us-west-2.amazonaws.com https://*.squarecdn.com; frame-src https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com; connect-src 'self' https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com; frame-ancestors 'self' https://napolicarrboro.com https://*.napolicarrboro.com; base-uri 'none'; form-action 'self'`;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(config: AppConfig) {
  const { db, secureCookies } = config;

  const orderRoute = checkoutRoutes(db, config.checkout);

  async function signedIn(req: IncomingMessage): Promise<SignedIn> {
    const who = await sessionFor(db, cookies(req)[SESSION_COOKIE]);
    if (!who) throw new HttpError(401, 'Sign in first.');
    return who;
  }

  async function enrolledDevice(req: IncomingMessage) {
    const device = await deviceFor(db, cookies(req)[DEVICE_COOKIE]);
    if (!device) throw new HttpError(403, 'This iPad isn’t set up yet. A manager can set it up.');
    return device;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // Cookies are SameSite=Lax; JSON-only bodies also keep plain cross-site form posts out.
      const origin = req.headers.origin;
      if (origin && req.headers.host) {
        let host: string | undefined;
        try { host = new URL(origin).host; } catch {}
        if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request.');
      }
    }

    const orderPage = ORDER_FILES[path];
    if (method === 'GET' && orderPage) {
      const content = await readFile(new URL(orderPage.file, WEB_DIR));
      res.writeHead(200, { 'content-type': orderPage.type, 'cache-control': 'no-cache', 'content-security-policy': ORDER_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      res.end(content);
      return;
    }
    if (path.startsWith('/api/order/') && await orderRoute(req, res, path)) return;

    // What the home screen shows: the restaurant's name under its icon, opening full screen.
    if (method === 'GET' && path === '/manifest.webmanifest') {
      const r = (await db.query<{ name: string; has_icon: boolean }>('SELECT name, icon IS NOT NULL AS has_icon FROM restaurants LIMIT 1')).rows[0];
      const name = r?.name ?? 'Kitchen';
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ name, short_name: name.length > 12 ? name.split(/\s+/)[0] : name, start_url: '/', scope: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000',
        ...(r?.has_icon ? { icons: [{ src: '/brand/icon', sizes: '512x512', type: 'image/png', purpose: 'any' }] } : {}) }));
      return;
    }
    if (method === 'GET' && path === '/brand/icon') {
      const r = (await db.query<{ icon: string | null }>('SELECT encode(icon, \'base64\') AS icon FROM restaurants LIMIT 1')).rows[0];
      if (!r?.icon) throw new HttpError(404, 'No icon.');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from(r.icon, 'base64'));
      return;
    }
    if (method === 'POST' && path === '/api/brand/icon') {
      const who = await signedIn(req);
      if (!canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator changes the icon.');
      const b = await body(req, 2 * 1024 * 1024);
      const m = typeof b.dataUrl === 'string' ? b.dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) : null;
      if (!m || m[1]!.length > 1_000_000) throw new HttpError(400, 'A PNG icon, under 750 KB.');
      await db.query('UPDATE restaurants SET icon = decode($1, \'base64\'), icon_updated_at = now() WHERE id = $2', [m[1], who.restaurantId]);
      return send(res, 200, { ok: true });
    }

    const web = WEB_FILES[path];
    if (method === 'GET' && web) {
      let content: Buffer | string = await readFile(new URL(web.file, WEB_DIR));
      // The page carries the restaurant's name, so the home screen names it right.
      if (web.file === 'index.html') {
        const name = (await db.query<{ name: string }>('SELECT name FROM restaurants LIMIT 1')).rows[0]?.name ?? 'Kitchen';
        content = content.toString('utf8').replaceAll('{{NAME}}', name.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!)));
      }
      res.writeHead(200, { 'content-type': web.type, 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      res.end(content);
      return;
    }

    // The restaurant's own look. Public: the sign-in screens show it. (One restaurant per app for now.)
    if (method === 'GET' && path === '/api/brand') {
      const r = (await db.query<{ name: string; has_logo: boolean; logo_updated_at: Date | null; icon_fresh: boolean }>('SELECT name, logo IS NOT NULL AS has_logo, logo_updated_at, (icon IS NOT NULL AND icon_updated_at >= coalesce(logo_updated_at, icon_updated_at)) AS icon_fresh FROM restaurants LIMIT 1')).rows[0];
      return send(res, 200, r ? { name: r.name, logo: r.has_logo ? `/brand/logo?v=${r.logo_updated_at ? new Date(r.logo_updated_at).getTime() : 0}` : null, iconFresh: r.icon_fresh } : { name: null, logo: null });
    }
    if (method === 'GET' && path === '/brand/logo') {
      const r = (await db.query<{ logo: string | null; logo_type: string | null }>('SELECT encode(logo, \'base64\') AS logo, logo_type FROM restaurants LIMIT 1')).rows[0];
      if (!r?.logo || !r.logo_type) throw new HttpError(404, 'No logo.');
      res.writeHead(200, { 'content-type': r.logo_type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from(r.logo, 'base64'));
      return;
    }
    if (method === 'POST' && path === '/api/brand/logo') {
      const who = await signedIn(req);
      if (!canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator changes the logo.');
      const b = await body(req, 3 * 1024 * 1024);
      if (b.dataUrl === null) {
        await db.query('UPDATE restaurants SET logo = NULL, logo_type = NULL, logo_updated_at = now() WHERE id = $1', [who.restaurantId]);
        return send(res, 200, { ok: true });
      }
      const m = typeof b.dataUrl === 'string' ? b.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
      if (!m) throw new HttpError(400, 'Use a PNG, JPEG or WebP image.');
      if (m[2]!.length > 2_000_000) throw new HttpError(400, 'Use an image under 1.5 MB.');
      await db.query('UPDATE restaurants SET logo = decode($1, \'base64\'), logo_type = $2, logo_updated_at = now() WHERE id = $3', [m[2], m[1], who.restaurantId]);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/api/setup') {
      const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM restaurants');
      return send(res, 200, { open: Boolean(config.setupToken) && Number(rows[0]?.n) === 0 });
    }

    if (method === 'GET' && path === '/api/staff') {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
      const admin = canAdminister(who);
      const { rows } = await db.query<{ id: string; display_name: string; job_title: string | null; access: string; area: string; has_pin: boolean; email: string | null; has_password: boolean; invite_until: Date | null }>(
        `SELECT s.id, s.display_name, s.job_title, s.access, s.area, s.pin_hash IS NOT NULL AS has_pin, s.email, s.password_hash IS NOT NULL AS has_password,
                (SELECT max(i.expires_at) FROM invites i WHERE i.staff_id = s.id AND i.used_at IS NULL AND i.expires_at > now()) AS invite_until
           FROM staff s WHERE s.restaurant_id = $1 AND s.active
          ORDER BY CASE s.access WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, s.display_name`,
        [who.restaurantId],
      );
      return send(res, 200, {
        canSetAccess: admin,
        staff: rows.map((r) => ({
          id: r.id, name: r.display_name, jobTitle: r.job_title, access: r.access, area: r.area, hasPin: r.has_pin,
          // Email sign-in: set up (password chosen), invited (link out, not used yet) or neither.
          emailSignIn: r.access === 'staff' ? null : r.has_password ? 'on' : r.invite_until ? 'invited' : 'off',
          ...(admin && r.access !== 'staff' && r.email ? { email: r.email } : {}),
          ...(r.invite_until ? { inviteUntil: r.invite_until } : {}),
        })),
      });
    }

    const invitePath = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{20,100})$/);
    if (invitePath) {
      const { rows } = await db.query<{ staff_id: string; email: string | null; display_name: string; restaurant_name: string; used_at: Date | null; expires_at: Date; access: string }>(
        `SELECT i.staff_id, s.email, s.display_name, r.name AS restaurant_name, i.used_at, i.expires_at, s.access
           FROM invites i JOIN staff s ON s.id = i.staff_id AND s.restaurant_id = i.restaurant_id AND s.active JOIN restaurants r ON r.id = i.restaurant_id
          WHERE i.token_hash = $1`, [tokenHash(invitePath[1]!)]);
      const invite = rows[0];
      if (!invite || !invite.email || invite.access === 'staff') throw new HttpError(404, 'This link isn’t valid. Ask whoever sent it for a new one.');
      if (invite.used_at) throw new HttpError(410, 'This link was already used. Sign in with your email and password, or ask for a new link.');
      if (new Date(invite.expires_at) <= new Date()) throw new HttpError(410, 'This link has expired. Ask whoever sent it for a new one.');
      if (method === 'GET') return send(res, 200, { name: invite.display_name, email: invite.email, restaurantName: invite.restaurant_name });
      if (method === 'POST') {
        const b = await body(req);
        const password = str(b, 'password');
        const problem = passwordProblem(password);
        if (problem) throw new HttpError(400, problem);
        // Used once: the update only succeeds while the invite is still open.
        const used = await db.query('UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING token_hash', [tokenHash(invitePath[1]!)]);
        if (!used.rows.length) throw new HttpError(410, 'This link was already used.');
        await db.query('UPDATE staff SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2', [await hashSecret(password), invite.staff_id]);
        // A new password signs out the old one everywhere.
        await db.query("DELETE FROM sessions WHERE staff_id = $1 AND method = 'password'", [invite.staff_id]);
        await db.query('DELETE FROM invites WHERE staff_id = $1 AND used_at IS NULL', [invite.staff_id]);
        return signInReply(res, await signInWithPassword(db, invite.email, password), secureCookies);
      }
    }

    if (method === 'GET' && path === '/health') {
      await db.query('SELECT 1');
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/setup') {
      const b = await body(req);
      if (!config.setupToken || !sameSecret(str(b, 'token'), config.setupToken)) throw new HttpError(403, 'Setup is closed.');
      const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM restaurants');
      if (Number(rows[0]?.n) > 0) throw new HttpError(409, 'Already set up.');
      const password = str(b, 'password');
      const problem = passwordProblem(password);
      if (problem) throw new HttpError(400, problem);
      const hash = await hashSecret(password);
      const r = await db.query<{ id: string }>('INSERT INTO restaurants (name, timezone) VALUES ($1, $2) RETURNING id', [str(b, 'restaurantName'), typeof b.timezone === 'string' ? b.timezone : 'America/New_York']);
      const restaurantId = r.rows[0]!.id;
      await db.query("INSERT INTO job_title_permissions (restaurant_id, job_title, role_level) VALUES ($1, 'Owner', 'owner')", [restaurantId]);
      await db.query("INSERT INTO staff (restaurant_id, display_name, job_title, email, password_hash, access) VALUES ($1, $2, 'Owner', $3, $4, 'owner')", [restaurantId, str(b, 'name'), str(b, 'email').trim(), hash]);
      return signInReply(res, await signInWithPassword(db, str(b, 'email'), password), secureCookies);
    }

    if (method === 'POST' && path === '/api/login/password') {
      const b = await body(req);
      return signInReply(res, await signInWithPassword(db, str(b, 'email'), str(b, 'password')), secureCookies);
    }

    if (method === 'POST' && path === '/api/login/pin') {
      const device = await enrolledDevice(req);
      const b = await body(req);
      return signInReply(res, await signInWithPin(db, device, str(b, 'staffId'), str(b, 'pin')), secureCookies);
    }

    if (method === 'POST' && path === '/api/logout') {
      await signOut(db, cookies(req)[SESSION_COOKIE]);
      return send(res, 200, { ok: true }, { 'set-cookie': cookie(SESSION_COOKIE, '', new Date(0), secureCookies) });
    }

    if (method === 'GET' && path === '/api/me') {
      const me = await signedIn(req);
      const device = await deviceFor(db, cookies(req)[DEVICE_COOKIE]);
      const here = device && device.restaurantId === me.restaurantId ? device : undefined;
      const station = here?.stationId ? (await db.query<{ name: string }>('SELECT name FROM stations WHERE id = $1 AND active', [here.stationId])).rows[0] : undefined;
      return send(res, 200, { me, ...(here ? { device: { id: here.id, name: here.name, ...(station ? { stationId: here.stationId, station: station.name } : {}) } } : {}) });
    }

    const stationOf = async (restaurantId: string, b: Record<string, unknown>): Promise<string | null> => {
      if (b.stationId === undefined || b.stationId === null || b.stationId === '') return null;
      const r = await db.query('SELECT 1 FROM stations WHERE restaurant_id = $1 AND id = $2', [restaurantId, String(b.stationId)]);
      if (!r.rows.length) throw new HttpError(400, 'No such station.');
      return String(b.stationId);
    };

    if (method === 'POST' && path === '/api/devices') {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Only a manager can set up an iPad.');
      const b = await body(req);
      const name = str(b, 'name').trim();
      if (!name) throw new HttpError(400, 'Name this iPad.');
      const stationId = await stationOf(who.restaurantId, b);
      const { token, hash } = newToken();
      const r = await db.query<{ id: string }>('INSERT INTO devices (restaurant_id, name, token_hash, enrolled_by, station_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [who.restaurantId, name, hash, who.staffId, stationId]);
      const tenYears = new Date(Date.now() + 10 * 365 * 86_400_000);
      return send(res, 201, { device: { id: r.rows[0]!.id, name, stationId } }, { 'set-cookie': cookie(DEVICE_COOKIE, token, tenYears, secureCookies) });
    }

    if (method === 'GET' && path === '/api/devices') {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
      const here = await deviceFor(db, cookies(req)[DEVICE_COOKIE]);
      const devices = (await db.query<{ id: string; name: string; station_id: string | null; last_seen_at: Date | null }>(
        'SELECT id, name, station_id, last_seen_at FROM devices WHERE restaurant_id = $1 AND revoked_at IS NULL ORDER BY name', [who.restaurantId])).rows;
      const stations = (await db.query<{ id: string; name: string }>('SELECT id, name FROM stations WHERE restaurant_id = $1 AND active ORDER BY sort_order', [who.restaurantId])).rows;
      return send(res, 200, { stations, devices: devices.map((d) => ({ id: d.id, name: d.name, stationId: d.station_id, lastSeen: d.last_seen_at, thisOne: d.id === here?.id })) });
    }

    const devicePath = path.match(/^\/api\/devices\/([0-9a-f-]{36})$/);
    if (method === 'POST' && devicePath) {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Only a manager can change an iPad.');
      const b = await body(req);
      const id = devicePath[1];
      if (b.revoke === true) {
        await db.query('UPDATE devices SET revoked_at = now() WHERE restaurant_id = $1 AND id = $2', [who.restaurantId, id]);
        await db.query('DELETE FROM sessions WHERE device_id = $1', [id]);
        return send(res, 200, { ok: true });
      }
      if ('stationId' in b) await db.query('UPDATE devices SET station_id = $1 WHERE restaurant_id = $2 AND id = $3', [await stationOf(who.restaurantId, b), who.restaurantId, id]);
      if (typeof b.name === 'string' && b.name.trim()) await db.query('UPDATE devices SET name = $1 WHERE restaurant_id = $2 AND id = $3', [b.name.trim(), who.restaurantId, id]);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/api/devices/staff') {
      const device = await enrolledDevice(req);
      const { rows } = await db.query<{ id: string; display_name: string; has_pin: boolean }>(
        'SELECT id, display_name, pin_hash IS NOT NULL AS has_pin FROM staff WHERE restaurant_id = $1 AND active ORDER BY display_name',
        [device.restaurantId],
      );
      return send(res, 200, { device: device.name, staff: rows.map((r) => ({ id: r.id, name: r.display_name, hasPin: r.has_pin })) });
    }

    const pinPath = path.match(/^\/api\/staff\/([0-9a-f-]{36})\/pin$/);
    if (method === 'POST' && pinPath) {
      const who = await signedIn(req);
      const staffId = pinPath[1]!;
      if (staffId !== who.staffId && !atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Only a manager can set someone else’s PIN.');
      if (staffId !== who.staffId) {
        // Managers set staff PINs; administrators anyone's but the owner's.
        const target = (await db.query<{ access: string }>('SELECT access FROM staff WHERE id = $1 AND restaurant_id = $2', [staffId, who.restaurantId])).rows[0];
        if (target?.access === 'owner' && who.access !== 'owner') throw new HttpError(403, 'Only the account owner sets their own PIN.');
        if (target && target.access !== 'staff' && !canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator sets a manager’s PIN.');
      }
      const b = await body(req);
      const pin = str(b, 'pin');
      const problem = pinProblem(pin);
      if (problem) throw new HttpError(400, problem);
      const r = await db.query('UPDATE staff SET pin_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2 AND restaurant_id = $3 RETURNING id', [await hashSecret(pin), staffId, who.restaurantId]);
      if (!r.rows.length) throw new HttpError(404, 'No such person.');
      return send(res, 200, { ok: true });
    }

    const accessPath = path.match(/^\/api\/staff\/([0-9a-f-]{36})\/access$/);
    if (method === 'POST' && accessPath) {
      const who = await signedIn(req);
      if (!canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator sets access.');
      if (accessPath[1] === who.staffId) throw new HttpError(400, 'Someone else has to change your own access.');
      const b = await body(req);
      if (!ACCESS.includes(b.access as never) || b.access === 'owner') throw new HttpError(400, 'Staff, manager or administrator.');
      const r = await db.query("UPDATE staff SET access = $1 WHERE id = $2 AND restaurant_id = $3 AND access <> 'owner' RETURNING id", [b.access, accessPath[1], who.restaurantId]);
      if (!r.rows.length) throw new HttpError(404, 'No such person, or it’s the account owner.');
      if (b.access === 'staff') {
        // Back to staff: no more email sign-in. Their PIN still works on kitchen iPads.
        await db.query('UPDATE staff SET password_hash = NULL WHERE id = $1', [accessPath[1]]);
        await db.query("DELETE FROM sessions WHERE staff_id = $1 AND method = 'password'", [accessPath[1]]);
        await db.query('DELETE FROM invites WHERE staff_id = $1', [accessPath[1]]);
      }
      return send(res, 200, { ok: true });
    }

    const areaPath = path.match(/^\/api\/staff\/([0-9a-f-]{36})\/area$/);
    if (method === 'POST' && areaPath) {
      const who = await signedIn(req);
      if (areaPath[1] !== who.staffId && !canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator sets where someone works.');
      const b = await body(req);
      if (!['kitchen', 'bar', 'both'].includes(String(b.area))) throw new HttpError(400, 'Kitchen, bar or both.');
      const r = await db.query('UPDATE staff SET area = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING id', [b.area, areaPath[1], who.restaurantId]);
      if (!r.rows.length) throw new HttpError(404, 'No such person.');
      return send(res, 200, { ok: true });
    }

    if (path === '/api/areas') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await areaRoutes(db, req, res, path, method, who, localDateHour(tz).date)) return;
    }

    const invitePost = path.match(/^\/api\/staff\/([0-9a-f-]{36})\/invite$/);
    if (method === 'POST' && invitePost) {
      const who = await signedIn(req);
      if (!canAdminister(who)) throw new HttpError(403, 'Only the account owner or an administrator invites people.');
      const target = (await db.query<{ access: string }>('SELECT access FROM staff WHERE id = $1 AND restaurant_id = $2 AND active', [invitePost[1], who.restaurantId])).rows[0];
      if (!target) throw new HttpError(404, 'No such person.');
      if (target.access === 'owner') throw new HttpError(400, 'The account owner already signs in with email.');
      if (target.access === 'staff') throw new HttpError(400, 'Email sign-in is for managers. Make them a manager first.');
      const b = await body(req);
      const email = str(b, 'email').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That doesn’t look like an email address.');
      const taken = await db.query('SELECT 1 FROM staff WHERE lower(email) = lower($1) AND id <> $2', [email, invitePost[1]]);
      if (taken.rows.length) throw new HttpError(409, 'Someone else already signs in with that email.');
      await db.query('UPDATE staff SET email = $1 WHERE id = $2', [email, invitePost[1]]);
      // One open link at a time: a new invite replaces the last (and doubles as a password reset).
      await db.query('DELETE FROM invites WHERE staff_id = $1 AND used_at IS NULL', [invitePost[1]]);
      const { token, hash } = newToken();
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
      await db.query('INSERT INTO invites (token_hash, restaurant_id, staff_id, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)', [hash, who.restaurantId, invitePost[1], who.staffId, expiresAt]);
      return send(res, 201, { path: `/#invite=${token}`, expiresAt, email });
    }

    if (path.startsWith('/api/') && ['/api/sync', '/api/book', '/api/book/import', '/api/margins', '/api/menu', '/api/menu/price-variation', '/api/menu/status', '/api/answers', '/api/answers/recent', '/api/answers/undo'].includes(path) || path.startsWith('/api/sync/')) {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
      const today = async () => localDateHour((await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York').date;

      if (method === 'GET' && path === '/api/sync') {
        const { rows } = await db.query('SELECT source, started_at, finished_at, status, detail FROM sync_runs WHERE restaurant_id = $1 ORDER BY started_at DESC LIMIT 30', [who.restaurantId]);
        return send(res, 200, { connected: { square: Boolean(squareApiFrom(config.sync?.square ?? {})), marginedge: Boolean(marginEdgeApiFrom(config.sync?.marginedge ?? {})) }, runs: rows });
      }

      const syncPath = path.match(/^\/api\/sync\/(square|marginedge)$/);
      if (method === 'POST' && syncPath) {
        const source = syncPath[1] as 'square' | 'marginedge';
        const connected = source === 'square' ? squareApiFrom(config.sync?.square ?? {}) : marginEdgeApiFrom(config.sync?.marginedge ?? {});
        if (!connected) throw new HttpError(409, `${source === 'square' ? 'Square' : 'MarginEdge'} isn’t connected yet: add its key in Render.`);
        const running = await db.query("SELECT 1 FROM sync_runs WHERE restaurant_id = $1 AND source = $2 AND status = 'running' AND started_at > now() - interval '2 hours'", [who.restaurantId, source]);
        if (running.rows.length) throw new HttpError(409, 'That sync is already running.');
        // Runs in the background; GET /api/sync shows how it went.
        runSync(db, source, config.sync ?? {}, who.restaurantId, await today()).catch((err) => console.error(`${source} sync failed: ${(err as Error).message}`));
        return send(res, 202, { started: true });
      }

      if (method === 'GET' && path === '/api/book') {
        const { rows } = await db.query<{ key: string; updated_at: string; size: string }>('SELECT key, updated_at, length(value::text) AS size FROM kitchen_book WHERE restaurant_id = $1', [who.restaurantId]);
        return send(res, 200, { parts: rows });
      }

      if (method === 'POST' && path === '/api/book/import') {
        const b = await body(req, 5 * 1024 * 1024);
        if (b.format !== 'kitchen-book') throw new HttpError(400, 'That isn’t a kitchen-book file.');
        const found = BOOK_KEYS.filter((k) => b[k] !== undefined);
        if (!found.length) throw new HttpError(400, 'The file has nothing to load.');
        for (const k of found) {
          const problem = bookProblem(k, b[k]);
          if (problem) throw new HttpError(400, problem);
        }
        for (const k of found) await saveBook(db, who.restaurantId, k, b[k], who.staffId);
        return send(res, 200, { loaded: found, recipeCards: Array.isArray(b.recipeCards) ? b.recipeCards.length : undefined });
      }

      if (method === 'GET' && path === '/api/margins') {
        const now = await today();
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        let range: { from: string; to: string } | undefined;
        if (from || to) {
          const day = /^\d{4}-\d{2}-\d{2}$/;
          if (!from || !to || !day.test(from) || !day.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new HttpError(400, 'Dates are YYYY-MM-DD, both from and to.');
          if (from > to) throw new HttpError(400, 'The start date is after the end date.');
          if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw new HttpError(400, 'Pick a period of 400 days or less.');
          range = { from, to: to > now ? now : to };
        }
        const area = areaFor(who, url.searchParams.get('area'));
        return send(res, 200, marginsView(await getModel(db, who.restaurantId, now, range), { area, areaOf: await loadAreas(db, who.restaurantId) }));
      }

      if (method === 'POST' && path === '/api/answers') {
        const b = await body(req);
        const problem = answerProblem(b);
        if (problem) throw new HttpError(400, problem);
        if (PRODUCT_ANSWERS.has(String(b.type))) {
          const book = await loadBook(db, who.restaurantId);
          let next;
          try {
            next = withProductAnswer(book.importAnswers ?? {}, b as any, await today());
          } catch (err) {
            throw new HttpError(400, `That unit doesn’t work here: ${(err as Error).message}`);
          }
          await saveBook(db, who.restaurantId, 'importAnswers', next, who.staffId);
          return send(res, 200, { ok: true });
        }
        const current = (await loadBook(db, who.restaurantId)).linkAnswers ?? { confirm: [], newDish: [] };
        if (b.type === 'link' && !(await getModel(db, who.restaurantId, await today())).recipes.some((r) => r.name === b.recipe)) throw new HttpError(400, 'No recipe by that name.');
        await saveBook(db, who.restaurantId, 'linkAnswers', withAnswer(current, b as unknown as Exclude<Answer, { type: 'conversion' | 'price' }>, { at: new Date().toISOString(), by: who.staffId }), who.staffId);
        return send(res, 200, { ok: true });
      }

      // Answers given, newest first, each one able to be taken back (the question then asks again).
      if (method === 'GET' && path === '/api/answers/recent') {
        const links = (await loadBook(db, who.restaurantId)).linkAnswers ?? { confirm: [], newDish: [] };
        const { rows } = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM staff WHERE restaurant_id = $1', [who.restaurantId]);
        const names = new Map(rows.map((r) => [r.id, r.display_name]));
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 500);
        const all = recentAnswers(links);
        return send(res, 200, { total: all.length, answers: all.slice(0, limit).map((a) => ({ ...a, ...(a.by ? { by: names.get(a.by) ?? 'someone' } : {}) })) });
      }

      if (method === 'POST' && path === '/api/answers/undo') {
        const b = await body(req);
        const t = b.target as Record<string, unknown> | undefined;
        const target = typeof t?.dedupeKey === 'string' ? { dedupeKey: t.dedupeKey }
          : typeof t?.menuRecipe === 'string' ? { menuRecipe: t.menuRecipe }
          : typeof t?.catalogId === 'string' && typeof t?.itemName === 'string' ? { catalogId: t.catalogId, itemName: t.itemName, ...(typeof t.variationName === 'string' ? { variationName: t.variationName } : {}), ...(typeof t.from === 'string' ? { from: t.from } : {}) }
          : undefined;
        if (!target) throw new HttpError(400, 'Which answer?');
        const current = (await loadBook(db, who.restaurantId)).linkAnswers ?? { confirm: [], newDish: [] };
        const next = withoutAnswer(current, target);
        const count = (l: typeof current) => l.confirm.length + l.newDish.length + (l.notFood?.length ?? 0) + (l.dismissed?.length ?? 0) + (l.menuStatus?.length ?? 0);
        if (count(next) === count(current)) throw new HttpError(404, 'That answer isn’t there any more.');
        await saveBook(db, who.restaurantId, 'linkAnswers', next, who.staffId);
        return send(res, 200, { ok: true });
      }

      if (method === 'GET' && path === '/api/menu') {
        const area = areaFor(who, url.searchParams.get('area'));
        const model = await getModel(db, who.restaurantId, await today());
        const areaOf = await loadAreas(db, who.restaurantId);
        // Discount-looking buttons kept as their own item, and buttons folded by hand: each can be put back.
        const links = (await loadBook(db, who.restaurantId)).linkAnswers ?? { confirm: [], newDish: [] };
        const byId = new Map(model.menuItems.map((m) => [m.catalogId, m]));
        const named = (id: string) => { const m = byId.get(id); return m ? posName(m) : undefined; };
        const inSide = (id: string) => { const c = byId.get(id)?.category; return !c || areaOf(c) === area; };
        const priceKept = [
          ...(links.priceSplit ?? []).filter(inSide).flatMap((id) => (named(id) ? [{ catalogId: id, name: named(id)!, kind: 'split' }] : [])),
          ...(links.priceMerge ?? []).filter((x) => inSide(x.catalogId)).flatMap((x) => (named(x.catalogId) && named(x.into) ? [{ catalogId: x.catalogId, name: named(x.catalogId)!, into: named(x.into)!, kind: 'merge' }] : [])),
        ];
        // "On since": the numbers stay on the last 90 days, but a dish already selling when they start
        // gets its real first day from the order history (about 13 months).
        const view = menuView(model, { area, areaOf });
        const firsts = new Map((await db.query<{ item_name: string; first: string }>('SELECT item_name, min(day)::text AS first FROM pos_order_lines WHERE restaurant_id = $1 GROUP BY item_name', [who.restaurantId])).rows.map((r) => [r.item_name, r.first]));
        const historyFrom = (await db.query<{ first: string | null }>('SELECT min(day)::text AS first FROM pos_orders WHERE restaurant_id = $1', [who.restaurantId])).rows[0]?.first ?? undefined;
        if (historyFrom) {
          const posItem = posItemOf(model);
          const namesOf = new Map<string, Set<string>>();
          for (const sp of model.spans) {
            const id = model.lookup(sp.catalogId, sp.name, sp.last)?.recipeId;
            if (id) namesOf.set(id, (namesOf.get(id) ?? new Set()).add(posItem(sp.catalogId, sp.name).itemName));
          }
          for (const x of view.current as (Record<string, unknown> & { since: string })[]) {
            if (x.since > model.from) continue;
            const names = typeof x.menuKey === 'string' && namesOf.has(x.menuKey) ? [...namesOf.get(x.menuKey)!] : x.pos ? [(x.pos as { itemName: string }).itemName] : [];
            const first = names.map((n) => firsts.get(n)).filter((d): d is string => Boolean(d)).sort()[0];
            if (!first) continue;
            // Selling from the first days of the history: it was on before the history starts.
            if (first <= new Date(Date.parse(`${historyFrom}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)) Object.assign(x, { onBefore: historyFrom });
            else Object.assign(x, { onSince: first });
          }
        }
        return send(res, 200, { ...view, priceKept });
      }

      // What's on the menu, in a manager's words: came off (on a day), still on, or put back on. One answer per dish.
      if (method === 'POST' && path === '/api/menu/status') {
        const b = await body(req);
        const list = (Array.isArray(b.items) ? b.items : [b]) as Record<string, unknown>[];
        const day = /^\d{4}-\d{2}-\d{2}$/;
        const now = await today();
        const items = list.map((x) => ({ recipeId: String(x.menuKey ?? ''), status: x.status as 'off' | 'on' | 'stillOn', date: typeof x.date === 'string' && day.test(x.date) ? x.date : now, ...(typeof x.name === 'string' ? { name: x.name.slice(0, 200) } : {}) }));
        if (!items.length || items.some((x) => !x.recipeId || !['off', 'on', 'stillOn'].includes(x.status))) throw new HttpError(400, 'Which dish, and off, on or still on?');
        if (items.some((x) => x.date > now)) throw new HttpError(400, 'That day hasn’t come yet.');
        const links = (await loadBook(db, who.restaurantId)).linkAnswers ?? { confirm: [], newDish: [] };
        const at = new Date().toISOString();
        const keys = new Set(items.map((x) => x.recipeId));
        await saveBook(db, who.restaurantId, 'linkAnswers', { ...links, menuStatus: [...(links.menuStatus ?? []).filter((m) => !keys.has(m.recipeId)), ...items.map((x) => ({ ...x, at, by: who.staffId }))] }, who.staffId);
        return send(res, 200, { ok: true, saved: items.length });
      }

      // Same drink, different price: keep a discount button apart, fold one in by hand, or put either back.
      if (method === 'POST' && path === '/api/menu/price-variation') {
        const b = await body(req);
        const id = typeof b.catalogId === 'string' ? b.catalogId : '';
        if (!id) throw new HttpError(400, 'Which button?');
        const book = await loadBook(db, who.restaurantId);
        const links = book.linkAnswers ?? { confirm: [], newDish: [] };
        const split = (links.priceSplit ?? []).filter((x) => x !== id);
        const merge = (links.priceMerge ?? []).filter((x) => x.catalogId !== id);
        if (b.action === 'split') split.push(id);
        else if (b.action === 'merge') {
          if (typeof b.into !== 'string' || !b.into || b.into === id) throw new HttpError(400, 'Same drink as which?');
          merge.push({ catalogId: id, into: b.into });
        } else if (b.action !== 'reset') throw new HttpError(400, 'Split, merge or reset.');
        await saveBook(db, who.restaurantId, 'linkAnswers', { ...links, priceSplit: split, priceMerge: merge }, who.staffId);
        return send(res, 200, { ok: true });
      }
    }

    if (path.startsWith('/api/plans')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await planRoutes(db, req, res, path, method, who, localDateHour(tz).date)) return;
    }

    if (path.startsWith('/api/recipes') && method === 'GET') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await recipeRoutes(db, res, url, who, localDateHour(tz).date)) return;
    }

    if (path.startsWith('/api/costs/') && method === 'GET') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await costRoutes(db, res, url, who, localDateHour(tz).date)) return;
    }

    if (path.startsWith('/api/units')) {
      const who = await signedIn(req);
      if (await unitRoutes(db, req, res, path, who)) return;
    }

    if (path.startsWith('/api/ideas')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await ideaRoutes(db, req, res, url, who, localDateHour(tz).date, tz)) return;
    }

    if (path.startsWith('/api/reports') && method === 'GET') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await reportRoutes(db, res, url, who, localDateHour(tz).date)) return;
    }

    if (path.startsWith('/api/orders')) {
      const who = await signedIn(req);
      if (await orderRoutes(db, req, res, url, method, who)) return;
    }

    if (path.startsWith('/api/online/')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await onlineRoutes(db, req, res, path, url, who, tz)) return;
    }

    if (path === '/api/modifiers' || path === '/api/modifiers/answer') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await modifierRoutes(db, req, res, url, method, who, localDateHour(tz).date)) return;
    }

    if (path.startsWith('/api/cards')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await cardRoutes(db, req, res, url, method, who, localDateHour(tz).date)) return;
    }

    if (method === 'GET' && path === '/api/today') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      const local = localDateHour(tz);
      // Staff on a station's iPad see that station; managers see the whole kitchen.
      const device = atLeast(who.roleLevel, 'manager') ? undefined : await deviceFor(db, cookies(req)[DEVICE_COOKIE]);
      return send(res, 200, await todayView(db, who, local.date, local.hour, device?.restaurantId === who.restaurantId ? device.stationId ?? undefined : undefined));
    }

    // Set Today's lines aside for a while (just for this person), or bring them back.
    if (method === 'POST' && path === '/api/today/snooze') {
      const who = await signedIn(req);
      const b = await body(req);
      const keys = Array.isArray(b.keys) ? b.keys.filter((k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 300) : [];
      if (!keys.length || keys.length > 200) throw new HttpError(400, 'Say which lines to snooze.');
      if (b.wake === true) {
        await db.query('DELETE FROM today_snoozes WHERE restaurant_id = $1 AND staff_id = $2 AND item_key IN (SELECT jsonb_array_elements_text($3::jsonb))', [who.restaurantId, who.staffId, JSON.stringify(keys)]);
        return send(res, 200, { ok: true });
      }
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      const local = localDateHour(tz);
      const hours = Number(b.hours);
      const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : undefined;
      let until: string;
      if (b.hours !== undefined) {
        if (!(hours >= 1 && hours <= 12)) throw new HttpError(400, 'Snooze for 1 to 12 hours.');
        until = (await db.query<{ t: string }>("SELECT (now() + make_interval(hours => $1::int))::text AS t", [Math.round(hours)])).rows[0]!.t;
      } else if (day) {
        const later = (await db.query<{ ok: boolean }>("SELECT $1::date > $2::date AND $1::date <= $2::date + 14 AS ok", [day, local.date])).rows[0]!.ok;
        if (!later) throw new HttpError(400, 'Snooze until a day in the next two weeks.');
        until = (await db.query<{ t: string }>(`SELECT (($1::date + time '${SNOOZE_MORNING}') AT TIME ZONE $2)::text AS t`, [day, tz])).rows[0]!.t;
      } else throw new HttpError(400, 'Say how long to snooze for.');
      await db.query('DELETE FROM today_snoozes WHERE restaurant_id = $1 AND until < now()', [who.restaurantId]);
      await db.query(`INSERT INTO today_snoozes (restaurant_id, staff_id, item_key, until)
        SELECT DISTINCT $1::uuid, $2::uuid, k, $4::timestamptz FROM jsonb_array_elements_text($3::jsonb) AS k
        ON CONFLICT (restaurant_id, staff_id, item_key) DO UPDATE SET until = EXCLUDED.until, snoozed_at = now()`, [who.restaurantId, who.staffId, JSON.stringify(keys), until]);
      return send(res, 200, { ok: true, until: new Date(until).toISOString() });
    }

    if (path.startsWith('/api/prep')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await prepRoutes(db, req, res, path, method, who, localDateHour(tz).date)) return;
    }

    throw new HttpError(404, 'Not found.');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Saves that read the kitchen book, change it and write it back take turns: two taps a moment
      // apart (taking two dishes off the menu) used to both read the same book, and the second write
      // lost the first change. One app server, so one queue does it (several would need a database lock).
      const path = (req.url ?? '').split('?')[0]!;
      if (req.method === 'POST' && bookWrites(path)) await inTurn('book', () => route(req, res));
      else await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.details ?? {}) });
      // A short reference, shown on screen and in the log, so a screenshot finds the log line.
      const ref = Math.random().toString(36).slice(2, 7).toUpperCase();
      console.error(`[error ${ref}] ${req.method} ${(req.url ?? '').split('?')[0]}`, err);
      send(res, 500, { error: `Something went wrong on our side (ref ${ref}). Nothing on your screen was lost: try again in a moment.`, ref });
    }
  };
}
