/**
 * Sign-ins.
 *
 * Kitchen: a manager enrolls each iPad once; on an enrolled iPad a cook taps their name and
 * enters a 4–6 digit PIN. Managers, administrators and the owner can also sign in anywhere
 * with email and password, once they've set one from an invite. After 5 wrong tries an
 * account locks for 5 minutes.
 *
 * Access, set per person: staff (everyone, by default), manager (approves and edits prep,
 * plans the menu, sees Performance), admin (a manager who also runs the team: access, PINs,
 * invites) and the one account owner (an admin no one else can change).
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

export type Access = 'staff' | 'manager' | 'admin' | 'owner';
export const ACCESS: readonly Access[] = ['staff', 'manager', 'admin', 'owner'];

export interface SignedIn {
  staffId: string;
  access: Access;
  /** The side of the menu they work: where screens open for them. */
  area: 'kitchen' | 'bar' | 'both';
  restaurantId: string;
  name: string;
  jobTitle: string | null;
  roleLevel: RoleLevel;
  method: 'pin' | 'password';
  restaurantName: string;
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
  access: Access;
  area: 'kitchen' | 'bar' | 'both';
  restaurant_name: string;
}

// What a person may do in the kitchen follows their access; running the team is checked on access itself.
const STAFF_SELECT = `SELECT s.id, s.restaurant_id, s.display_name, s.job_title, s.pin_hash, s.password_hash, s.failed_logins, s.locked_until, s.access, s.area,
    CASE s.access WHEN 'owner' THEN 'owner' WHEN 'staff' THEN 'line' ELSE 'manager' END AS role_level, r.name AS restaurant_name
  FROM staff s JOIN restaurants r ON r.id = s.restaurant_id`;

function signedInFrom(r: StaffRow, method: 'pin' | 'password'): SignedIn {
  return { staffId: r.id, access: r.access, area: r.area, restaurantId: r.restaurant_id, name: r.display_name, jobTitle: r.job_title, roleLevel: r.role_level ?? 'line', method, restaurantName: r.restaurant_name };
}

/** The owner and administrators run the team: who has which access, PINs, invites. */
export function canAdminister(who: Pick<SignedIn, 'access'>): boolean {
  return who.access === 'owner' || who.access === 'admin';
}

/**
 * Checks a PIN or password, counting wrong tries the same way everywhere (signing in, or confirming
 * the current password before changing it): after 5 wrong the account waits a few minutes.
 */
async function checkSecret(db: Db, row: StaffRow | undefined, secret: string, method: 'pin' | 'password', now: Date): Promise<{ ok: true; row: StaffRow } | { ok: false; reason: 'wrong' } | { ok: false; reason: 'locked'; lockedUntil: Date }> {
  if (!row) {
    await verifySecret(secret, await DUMMY); // same time whether or not the account exists
    return { ok: false, reason: 'wrong' };
  }
  if (row.locked_until && new Date(row.locked_until) > now) return { ok: false, reason: 'locked', lockedUntil: new Date(row.locked_until) };
  // The try is counted before the secret is checked, in one statement: many guesses sent at once each
  // take a turn at the counter, and once the fifth locks the account the rest are turned away unchecked.
  const lockAt = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  const counted = await db.query<{ locked_until: string | null }>(
    `UPDATE staff SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN $3::timestamptz ELSE NULL END
     WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $4::timestamptz) RETURNING locked_until`,
    [row.id, MAX_FAILED, lockAt.toISOString(), now.toISOString()]);
  if (!counted.rows.length) {
    const until = (await db.query<{ locked_until: string | null }>('SELECT locked_until FROM staff WHERE id = $1', [row.id])).rows[0]?.locked_until;
    return { ok: false, reason: 'locked', lockedUntil: until ? new Date(until) : lockAt };
  }
  const good = await verifySecret(secret, method === 'pin' ? row.pin_hash : row.password_hash);
  if (!good) {
    const lockedUntil = counted.rows[0]!.locked_until;
    return lockedUntil ? { ok: false, reason: 'locked', lockedUntil: new Date(lockedUntil) } : { ok: false, reason: 'wrong' };
  }
  await db.query('UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
  return { ok: true, row };
}

async function attempt(db: Db, row: StaffRow | undefined, secret: string, method: 'pin' | 'password', deviceId: string | null, now: Date): Promise<SignInResult> {
  const checked = await checkSecret(db, row, secret, method, now);
  if (!checked.ok) return checked;
  row = checked.row;
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + (method === 'pin' ? PIN_SESSION_HOURS * 3_600_000 : PASSWORD_SESSION_DAYS * 86_400_000));
  await db.query('INSERT INTO sessions (token_hash, restaurant_id, staff_id, device_id, method, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [hash, row.restaurant_id, row.id, deviceId, method, expiresAt]);
  return { ok: true, token, expiresAt, who: signedInFrom(row, method) };
}
const DUMMY = hashSecret('not-a-real-secret');

export async function signInWithPin(db: Db, device: { id: string; restaurantId: string }, staffId: string, pin: string, now = new Date()): Promise<SignInResult> {
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE s.restaurant_id = $1 AND s.id = $2 AND s.active`, [device.restaurantId, staffId]);
  return attempt(db, rows[0], pin, 'pin', device.id, now);
}

export async function signInWithPassword(db: Db, email: string, password: string, now = new Date()): Promise<SignInResult> {
  // Email sign-in is for managers and up; staff sign in on a kitchen iPad.
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE lower(s.email) = lower($1) AND s.active AND s.access <> 'staff'`, [email.trim()]);
  return attempt(db, rows[0], password, 'password', null, now);
}

/**
 * A PIN typed to take credit for something (a checklist item, a note), without signing in: the
 * same wrong-try lockout as signing in.
 */
export async function checkPin(db: Db, restaurantId: string, staffId: string, pin: string, now = new Date()): Promise<{ ok: true; name: string } | { ok: false; error: string; status: number }> {
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE s.restaurant_id = $1 AND s.id = $2 AND s.active`, [restaurantId, staffId]);
  const row = rows[0];
  if (row && !row.pin_hash) return { ok: false, error: 'No PIN set for you yet. A manager can set one in Settings.', status: 400 };
  const checked = await checkSecret(db, row, pin, 'pin', now);
  if (checked.ok) return { ok: true, name: checked.row.display_name };
  return checked.reason === 'locked' ? { ok: false, error: 'Too many wrong tries. Try again in a few minutes.', status: 423 } : { ok: false, error: 'That PIN didn’t match.', status: 403 };
}

export type PasswordChange = { ok: true } | { ok: false; reason: 'wrong' | 'weak' | 'noPassword'; error: string } | { ok: false; reason: 'locked'; lockedUntil: Date; error: string };

/**
 * A manager changing their own password: the current one first (wrong tries count toward the
 * same lockout as signing in), then the new one. Every other password sign-in ends; the one
 * they're using stays, so they aren't thrown out mid-change.
 */
export async function changePassword(db: Db, who: SignedIn, current: string, next: string, keepTokenHash: string | undefined, now = new Date()): Promise<PasswordChange> {
  const { rows } = await db.query<StaffRow>(`${STAFF_SELECT} WHERE s.id = $1 AND s.restaurant_id = $2 AND s.active`, [who.staffId, who.restaurantId]);
  const row = rows[0];
  if (!row?.password_hash) return { ok: false, reason: 'noPassword', error: 'You don’t have a password yet. Ask the owner for an invite link.' };
  const checked = await checkSecret(db, row, current, 'password', now);
  if (!checked.ok) return checked.reason === 'locked'
    ? { ok: false, reason: 'locked', lockedUntil: checked.lockedUntil, error: 'Too many wrong tries. Try again in a few minutes.' }
    : { ok: false, reason: 'wrong', error: 'Your current password didn’t match.' };
  const problem = passwordProblem(next);
  if (problem) return { ok: false, reason: 'weak', error: problem };
  if (next === current) return { ok: false, reason: 'weak', error: 'Pick a password different from the current one.' };
  await db.query('UPDATE staff SET password_hash = $1 WHERE id = $2', [await hashSecret(next), row.id]);
  await db.query("DELETE FROM sessions WHERE staff_id = $1 AND method = 'password' AND token_hash IS DISTINCT FROM $2", [row.id, keepTokenHash ?? null]);
  return { ok: true };
}

export async function sessionFor(db: Db, token: string | undefined, now = new Date()): Promise<SignedIn | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<StaffRow & { method: 'pin' | 'password' }>(
    `${STAFF_SELECT.replace('SELECT ', 'SELECT x.method, ')} JOIN sessions x ON x.staff_id = s.id AND x.restaurant_id = s.restaurant_id
     WHERE x.token_hash = $1 AND x.expires_at > $2 AND s.active`,
    [tokenHash(token), now],
  );
  const r = rows[0];
  return r && signedInFrom(r, r.method);
}

export async function signOut(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export interface Device { id: string; restaurantId: string; name: string; stationId: string | null; floorPostId: string | null }

export async function deviceFor(db: Db, token: string | undefined): Promise<Device | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<{ id: string; restaurant_id: string; name: string; station_id: string | null; floor_post_id: string | null }>(
    'UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, restaurant_id, name, station_id, floor_post_id',
    [tokenHash(token)],
  );
  const r = rows[0];
  return r && { id: r.id, restaurantId: r.restaurant_id, name: r.name, stationId: r.station_id, floorPostId: r.floor_post_id };
}

const LEVELS: RoleLevel[] = ['line', 'lead', 'sous', 'chef', 'manager', 'owner'];
export function atLeast(level: RoleLevel, needed: RoleLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(needed);
}
