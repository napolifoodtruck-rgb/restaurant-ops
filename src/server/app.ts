/**
 * The web app: a small JSON API on node:http. Screens come later; this is what they call.
 *
 *   GET  /, /app.js, /app.css     the web app (web/)
 *   GET  /health                 for Render's health check
 *   GET  /api/setup              whether first-time setup is open
 *   POST /api/setup              first owner and restaurant, once, with SETUP_TOKEN
 *   POST /api/login/password     { email, password }
 *   POST /api/devices            { name } (manager or up): enroll this iPad
 *   GET  /api/devices/staff      names for the PIN screen (enrolled iPad only)
 *   POST /api/login/pin          { staffId, pin } (enrolled iPad only)
 *   POST /api/logout
 *   GET  /api/me
 *   POST /api/staff/:id/pin      { pin } yourself, or a manager for anyone
 *   GET  /api/staff              the team with roles and whether each has a PIN (manager or up)
 *   GET  /api/sync               last syncs and what's connected (manager or up)
 *   POST /api/sync/:source       start a Square or MarginEdge sync now (manager or up)
 *   GET  /api/book               which parts of the kitchen book are loaded (manager or up)
 *   POST /api/book/import        load recipe cards and answers from a kitchen-book file (manager or up)
 *   GET  /api/margins            margins by category, last 90 days or ?from=&to= (manager or up)
 *   GET  /api/menu               the menu from sales, what came off, to-dos (manager or up)
 *   POST /api/answers            answer a menu question: link, new dish, not food, dismiss (manager or up)
 *   /api/prep/…                  station prep lists: see prep.ts
 *   /api/plans/…                 dishes coming to the menu: see plans.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Db } from './db.ts';
import { HttpError, body, cookie, cookies, send, str } from './http.ts';
import {
  atLeast, deviceFor, hashSecret, newToken, passwordProblem, pinProblem, sessionFor, signInWithPassword, signInWithPin, signOut,
  type SignedIn, type SignInResult,
} from './auth.ts';
import { localDateHour, marginEdgeApiFrom, runSync, squareApiFrom, type SyncSettings } from './scheduler.ts';
import { BOOK_KEYS, PRODUCT_ANSWERS, answerProblem, bookProblem, getModel, loadBook, saveBook, withAnswer, withProductAnswer, type Answer } from './model.ts';
import { marginsView, menuView } from './views.ts';
import { prepRoutes } from './prep.ts';
import { planRoutes } from './plans.ts';

export interface AppConfig {
  db: Db;
  /** Allows /api/setup while no restaurant exists. Unset = setup closed. */
  setupToken?: string;
  /** Secure cookies (true everywhere but local development). */
  secureCookies: boolean;
  sync?: SyncSettings;
}

const SESSION_COOKIE = 'ops_session';
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
      const { rows } = await db.query<{ id: string; display_name: string; job_title: string | null; role_level: string | null; has_pin: boolean; has_email: boolean }>(
        `SELECT s.id, s.display_name, s.job_title, j.role_level, s.pin_hash IS NOT NULL AS has_pin, s.email IS NOT NULL AS has_email
           FROM staff s LEFT JOIN job_title_permissions j ON j.restaurant_id = s.restaurant_id AND j.job_title = s.job_title
          WHERE s.restaurant_id = $1 AND s.active ORDER BY s.display_name`,
        [who.restaurantId],
      );
      return send(res, 200, { staff: rows.map((r) => ({ id: r.id, name: r.display_name, jobTitle: r.job_title, roleLevel: r.role_level ?? 'line', hasPin: r.has_pin, hasEmail: r.has_email })) });
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
      await db.query("INSERT INTO staff (restaurant_id, display_name, job_title, email, password_hash) VALUES ($1, $2, 'Owner', $3, $4)", [restaurantId, str(b, 'name'), str(b, 'email').trim(), hash]);
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
      return send(res, 200, { me: await signedIn(req) });
    }

    if (method === 'POST' && path === '/api/devices') {
      const who = await signedIn(req);
      if (!atLeast(who.roleLevel, 'manager')) throw new HttpError(403, 'Only a manager can set up an iPad.');
      const b = await body(req);
      const { token, hash } = newToken();
      const r = await db.query<{ id: string }>('INSERT INTO devices (restaurant_id, name, token_hash, enrolled_by) VALUES ($1, $2, $3, $4) RETURNING id', [who.restaurantId, str(b, 'name'), hash, who.staffId]);
      const tenYears = new Date(Date.now() + 10 * 365 * 86_400_000);
      return send(res, 201, { device: { id: r.rows[0]!.id, name: b.name } }, { 'set-cookie': cookie(DEVICE_COOKIE, token, tenYears, secureCookies) });
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
      const b = await body(req);
      const pin = str(b, 'pin');
      const problem = pinProblem(pin);
      if (problem) throw new HttpError(400, problem);
      const r = await db.query('UPDATE staff SET pin_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2 AND restaurant_id = $3 RETURNING id', [await hashSecret(pin), staffId, who.restaurantId]);
      if (!r.rows.length) throw new HttpError(404, 'No such person.');
      return send(res, 200, { ok: true });
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
