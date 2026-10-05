/**
 * The web app: a small JSON API on node:http. Screens come later; this is what they call.
 *
 *   GET  /health                 for Render's health check
 *   POST /api/setup              first owner and restaurant, once, with SETUP_TOKEN
 *   POST /api/login/password     { email, password }
 *   POST /api/devices            { name } (manager or up): enroll this iPad
 *   GET  /api/devices/staff      names for the PIN screen (enrolled iPad only)
 *   POST /api/login/pin          { staffId, pin } (enrolled iPad only)
 *   POST /api/logout
 *   GET  /api/me
 *   POST /api/staff/:id/pin      { pin } yourself, or a manager for anyone
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import {
  atLeast, deviceFor, hashSecret, newToken, passwordProblem, pinProblem, sessionFor, signInWithPassword, signInWithPin, signOut,
  type SignedIn, type SignInResult,
} from './auth.ts';

export interface AppConfig {
  db: Db;
  /** Allows /api/setup while no restaurant exists. Unset = setup closed. */
  setupToken?: string;
  /** Secure cookies (true everywhere but local development). */
  secureCookies: boolean;
}

const SESSION_COOKIE = 'ops_session';
const DEVICE_COOKIE = 'ops_device';
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, expires: Date, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, 'Bad JSON.');
}

function str(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `Missing ${key}.`);
  return v;
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}

function signInReply(res: ServerResponse, result: SignInResult, secure: boolean): void {
  if (!result.ok) {
    send(res, result.reason === 'locked' ? 423 : 401, result.reason === 'locked'
      ? { error: 'Too many wrong tries. Try again in a few minutes.', lockedUntil: result.lockedUntil }
      : { error: 'That didn’t match.' });
    return;
  }
  send(res, 200, { me: result.who }, { 'set-cookie': cookie(SESSION_COOKIE, result.token, result.expiresAt, secure) });
}

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
