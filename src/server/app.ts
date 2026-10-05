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
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Db } from './db.ts';
import { HttpError, body, cookie, cookies, send, str } from './http.ts';
import {
  ACCESS, atLeast, canAdminister, deviceFor, hashSecret, tokenHash, newToken, passwordProblem, pinProblem, sessionFor, signInWithPassword, signInWithPin, signOut,
  type SignedIn, type SignInResult,
} from './auth.ts';
import { localDateHour, marginEdgeApiFrom, runSync, squareApiFrom, type SyncSettings } from './scheduler.ts';
import { BOOK_KEYS, PRODUCT_ANSWERS, answerProblem, bookProblem, getModel, loadBook, saveBook, withAnswer, withProductAnswer, type Answer } from './model.ts';
import { marginsView, menuView } from './views.ts';
import { prepRoutes } from './prep.ts';
import { planRoutes } from './plans.ts';
import { todayView } from './today.ts';

export interface AppConfig {
  db: Db;
  /** Allows /api/setup while no restaurant exists. Unset = setup closed. */
  setupToken?: string;
  /** Secure cookies (true everywhere but local development). */
  secureCookies: boolean;
  sync?: SyncSettings;
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

const WEB_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const WEB_DIR = new URL('../../web/', import.meta.url);
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(config: AppConfig) {
  const { db, secureCookies } = config;

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

    const web = WEB_FILES[path];
    if (method === 'GET' && web) {
      const content = await readFile(new URL(web.file, WEB_DIR));
      res.writeHead(200, { 'content-type': web.type, 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      res.end(content);
      return;
    }

    if (method === 'GET' && path === '/api/setup') {
      const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM restaurants');
      return send(res, 200, { open: Boolean(config.setupToken) && Number(rows[0]?.n) === 0 });
    }

    if (method === 'GET' && path === '/api/staff') {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Managers only.');
      const admin = canAdminister(who);
      const { rows } = await db.query<{ id: string; display_name: string; job_title: string | null; access: string; has_pin: boolean; email: string | null; has_password: boolean; invite_until: Date | null }>(
        `SELECT s.id, s.display_name, s.job_title, s.access, s.pin_hash IS NOT NULL AS has_pin, s.email, s.password_hash IS NOT NULL AS has_password,
                (SELECT max(i.expires_at) FROM invites i WHERE i.staff_id = s.id AND i.used_at IS NULL AND i.expires_at > now()) AS invite_until
           FROM staff s WHERE s.restaurant_id = $1 AND s.active
          ORDER BY CASE s.access WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, s.display_name`,
        [who.restaurantId],
      );
      return send(res, 200, {
        canSetAccess: admin,
        staff: rows.map((r) => ({
          id: r.id, name: r.display_name, jobTitle: r.job_title, access: r.access, hasPin: r.has_pin,
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

    if (path.startsWith('/api/') && ['/api/sync', '/api/book', '/api/book/import', '/api/margins', '/api/menu', '/api/answers'].includes(path) || path.startsWith('/api/sync/')) {
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
        return send(res, 200, marginsView(await getModel(db, who.restaurantId, now, range)));
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
        if (b.type === 'link' && !(await getModel(db, who.restaurantId, await today())).recipes.some((r) => r.name === b.recipe)) throw new HttpError(400, 'No recipe card by that name.');
        await saveBook(db, who.restaurantId, 'linkAnswers', withAnswer(current, b as unknown as Exclude<Answer, { type: 'conversion' | 'price' }>), who.staffId);
        return send(res, 200, { ok: true });
      }

      if (method === 'GET' && path === '/api/menu') {
        return send(res, 200, menuView(await getModel(db, who.restaurantId, await today())));
      }
    }

    if (path.startsWith('/api/plans')) {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      if (await planRoutes(db, req, res, path, method, who, localDateHour(tz).date)) return;
    }

    if (method === 'GET' && path === '/api/today') {
      const who = await signedIn(req);
      const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [who.restaurantId])).rows[0]?.timezone ?? 'America/New_York';
      const local = localDateHour(tz);
      // Staff on a station's iPad see that station; managers see the whole kitchen.
      const device = atLeast(who.roleLevel, 'manager') ? undefined : await deviceFor(db, cookies(req)[DEVICE_COOKIE]);
      return send(res, 200, await todayView(db, who, local.date, local.hour, device?.restaurantId === who.restaurantId ? device.stationId ?? undefined : undefined));
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
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong on our side.' });
    }
  };
}
