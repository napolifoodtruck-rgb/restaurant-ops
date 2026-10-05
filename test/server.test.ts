// End to end against a real PostgreSQL: migrations, setup, iPad enrollment, PIN sign-in, lockout.
// Skipped when PostgreSQL binaries aren't installed or when running as root (initdb refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { startTestDb } from './support/psqlDb.ts';

const db = startTestDb();

test('sign-ins from setup to a locked PIN', { skip: !db && 'no PostgreSQL for tests (or running as root)' }, async (t) => {
  t.after(() => db!.close());
  const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url));
  assert.deepEqual(await migrate(db!, migrations), ['0001_schema.sql', '0002_logins.sql', '0003_pos_data.sql', '0004_book.sql']);
  assert.deepEqual(await migrate(db!, migrations), []); // each applied once

  const server = createServer(createApp({ db: db!, setupToken: 'setup-secret', secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, opts: { body?: object; cookies?: string[]; origin?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.cookies?.length) headers.cookie = opts.cookies.join('; ');
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
    return { status: res.status, json: (await res.json()) as any, cookies: set };
  };

  assert.equal((await call('GET', '/health')).status, 200);

  // First owner, once, with the setup token.
  const owner = { token: 'setup-secret', restaurantName: 'Napoli', name: 'Owner', email: 'Owner@Example.com', password: 'a long enough one' };
  assert.equal((await call('POST', '/api/setup', { body: { ...owner, token: 'nope' } })).status, 403);
  const setup = await call('POST', '/api/setup', { body: owner });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.me.roleLevel, 'owner');
  assert.equal((await call('POST', '/api/setup', { body: owner })).status, 409);

  // Email sign-in ignores case; a wrong password says nothing about whether the email exists.
  const ownerLogin = await call('POST', '/api/login/password', { body: { email: 'owner@example.com', password: 'a long enough one' } });
  assert.equal(ownerLogin.status, 200);
  const ownerSession = ownerLogin.cookies;
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'owner@example.com', password: 'wrong password' } })).json.error, 'That didn’t match.');
  assert.equal((await call('POST', '/api/login/password', { body: { email: 'nobody@example.com', password: 'wrong password' } })).json.error, 'That didn’t match.');

  // A cook (staff normally arrive from the Square sync).
  const restaurantId = (await db!.query<{ id: string }>('SELECT id FROM restaurants')).rows[0]!.id;
  await db!.query("INSERT INTO job_title_permissions (restaurant_id, job_title, role_level) VALUES ($1, 'Line Cook', 'line')", [restaurantId]);
  const cookId = (await db!.query<{ id: string }>("INSERT INTO staff (restaurant_id, display_name, job_title) VALUES ($1, 'Marco', 'Line Cook') RETURNING id", [restaurantId])).rows[0]!.id;

  // PINs only work on an enrolled iPad.
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' } })).status, 403);
  const enrolled = await call('POST', '/api/devices', { body: { name: 'Sauté iPad' }, cookies: ownerSession });
  assert.equal(enrolled.status, 201);
  const device = enrolled.cookies;

  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '1234' }, cookies: ownerSession })).status, 400);
  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '2468' }, cookies: ownerSession })).status, 200);
  const names = await call('GET', '/api/devices/staff', { cookies: device });
  assert.deepEqual(names.json.staff.map((s: any) => [s.name, s.hasPin]), [['Marco', true], ['Owner', false]]);

  // Five wrong PINs lock the account, even against the right PIN.
  for (let i = 1; i <= 4; i++) assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '1357' }, cookies: device })).status, 401);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '1357' }, cookies: device })).status, 423);
  assert.equal((await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' }, cookies: device })).status, 423);

  // Once the lock passes, the right PIN works.
  await db!.query('UPDATE staff SET locked_until = now() - interval \'1 minute\' WHERE id = $1', [cookId]);
  const cook = await call('POST', '/api/login/pin', { body: { staffId: cookId, pin: '2468' }, cookies: device });
  assert.equal(cook.status, 200);
  assert.equal(cook.json.me.roleLevel, 'line');
  const cookSession = [...cook.cookies, ...device];

  // A cook can't enroll iPads or change someone else's PIN.
  assert.equal((await call('POST', '/api/devices', { body: { name: 'x' }, cookies: cookSession })).status, 403);
  const ownerId = setup.json.me.staffId;
  assert.equal((await call('POST', `/api/staff/${ownerId}/pin`, { body: { pin: '8024' }, cookies: cookSession })).status, 403);
  assert.equal((await call('POST', `/api/staff/${cookId}/pin`, { body: { pin: '8024' }, cookies: cookSession })).status, 200);

  // Cross-site posts are refused; signing out ends the session.
  assert.equal((await call('POST', '/api/logout', { cookies: cookSession, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/logout', { cookies: cookSession })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookies: cookSession })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookies: ownerSession })).status, 200);

  // Nothing secret is stored in the clear.
  const stored = await db!.query<{ pin_hash: string }>('SELECT pin_hash FROM staff WHERE id = $1', [cookId]);
  assert.match(stored.rows[0]!.pin_hash, /^scrypt\$/);
});
