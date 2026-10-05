/**
 * Sign-ins.
 *
 * Kitchen: a manager enrolls each iPad once; on an enrolled iPad a cook taps their name and
 * enters a 4–6 digit PIN. Managers and owners can also sign in anywhere with email and
 * password. After 5 wrong tries an account locks for 5 minutes.
 *
 * Secrets are scrypt hashes; session and device tokens are random and stored only as
 * SHA-256 hashes, so nothing in the database can be replayed.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.ts';
import type { RoleLevel } from '../core/stationPrep.ts';

const scrypt = promisify(scryptCb) as (secret: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 32;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  const parts = stored?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(secret, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 5;
export const PIN_SESSION_HOURS = 14;
export const PASSWORD_SESSION_DAYS = 30;

export function pinProblem(pin: string): string | undefined {
  if (!/^\d{4,6}$/.test(pin)) return 'A PIN is 4 to 6 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Pick a PIN that isn’t one digit repeated.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Pick a PIN that isn’t a run like 1234.';
  return undefined;
}

export function passwordProblem(password: string): string | undefined {
  if (password.length < 10) return 'Use at least 10 characters.';
  return undefined;
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SignedIn {
  staffId: string;
  restaurantId: string;
  name: string;
  jobTitle: string | null;
  roleLevel: RoleLevel;
  method: 'pin' | 'password';
}

export type SignInResult = { ok: true; token: string; expiresAt: Date; who: SignedIn } | { ok: false; reason: 'wrong' | 'locked'; lockedUntil?: Date };

interface StaffRow {
  id: string;
  restaurant_id: string;
  display_name: string;
  job_title: string | null;
  pin_hash: string | null;
  password_hash: string | null;
  failed_logins: number;
  locked_until: Date | null;
  role_level: RoleLevel | null;
}

const STAFF_SELECT = `SELECT s.id, s.restaurant_id, s.display_name, s.job_title, s.pin_hash, s.password_hash, s.failed_logins, s.locked_until, j.role_level
  FROM staff s LEFT JOIN job_title_permissions j ON j.restaurant_id = s.restaurant_id AND j.job_title = s.job_title`;

async function attempt(db: Db, row: StaffRow | undefined, secret: string, method: 'pin' | 'password', deviceId: string | null, now: Date): Promise<SignInResult> {
  if (!row) {
    await verifySecret(secret, await DUMMY); // same time whether or not the account exists
    return { ok: false, reason: 'wrong' };
  }
  if (row.locked_until && new Date(row.locked_until) > now) return { ok: false, reason: 'locked', lockedUntil: new Date(row.locked_until) };
  const good = await verifySecret(secret, method === 'pin' ? row.pin_hash : row.password_hash);
  if (!good) {
    const failed = row.failed_logins + 1;
    const lockedUntil = failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;
    await db.query('UPDATE staff SET failed_logins = $1, locked_until = $2 WHERE id = $3', [lockedUntil ? 0 : failed, lockedUntil, row.id]);
    return lockedUntil ? { ok: false, reason: 'locked', lockedUntil } : { ok: false, reason: 'wrong' };
  }
  await db.query('UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + (method === 'pin' ? PIN_SESSION_HOURS * 3_600_000 : PASSWORD_SESSION_DAYS * 86_400_000));
  await db.query('INSERT INTO sessions (token_hash, restaurant_id, staff_id, device_id, method, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [hash, row.restaurant_id, row.id, deviceId, method, expiresAt]);
  return { ok: true, token, expiresAt, who: { staffId: row.id, restaurantId: row.restaurant_id, name: row.display_name, jobTitle: row.job_title, roleLevel: row.role_level ?? 'line', method } };
}
const DUMMY = hashSecret('not-a-real-secret');

export async function signInWithPin(db: Db, device: { id: string; restaurantId: string }, staffId: string, pin: string, now = new Date()): Promise<SignInResult> {
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE s.restaurant_id = $1 AND s.id = $2 AND s.active`, [device.restaurantId, staffId]);
  return attempt(db, rows[0], pin, 'pin', device.id, now);
}

export async function signInWithPassword(db: Db, email: string, password: string, now = new Date()): Promise<SignInResult> {
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE lower(s.email) = lower($1) AND s.active`, [email.trim()]);
  return attempt(db, rows[0], password, 'password', null, now);
}

export async function sessionFor(db: Db, token: string | undefined, now = new Date()): Promise<SignedIn | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<StaffRow & { method: 'pin' | 'password' }>(
    `${STAFF_SELECT.replace('SELECT ', 'SELECT x.method, ')} JOIN sessions x ON x.staff_id = s.id AND x.restaurant_id = s.restaurant_id
     WHERE x.token_hash = $1 AND x.expires_at > $2 AND s.active`,
    [tokenHash(token), now],
  );
  const r = rows[0];
  return r && { staffId: r.id, restaurantId: r.restaurant_id, name: r.display_name, jobTitle: r.job_title, roleLevel: r.role_level ?? 'line', method: r.method };
}

export async function signOut(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function deviceFor(db: Db, token: string | undefined): Promise<{ id: string; restaurantId: string; name: string } | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<{ id: string; restaurant_id: string; name: string }>(
    'UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, restaurant_id, name',
    [tokenHash(token)],
  );
  const r = rows[0];
  return r && { id: r.id, restaurantId: r.restaurant_id, name: r.name };
}

const LEVELS: RoleLevel[] = ['line', 'lead', 'sous', 'chef', 'manager', 'owner'];
export function atLeast(level: RoleLevel, needed: RoleLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(needed);
}
