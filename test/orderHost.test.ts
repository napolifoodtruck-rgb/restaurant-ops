// The customers' address (order.<domain>) serves the ordering page only; the staff app isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.ts';
import type { Db } from '../src/server/db.ts';

test('the ordering address shows only the ordering page', async (t) => {
  const db = { query: async () => ({ rows: [] }) } as unknown as Db;
  const server = createServer(createApp({ db, secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const call = (host: string, path: string, method = 'GET') => new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });

  const order = 'order.napolicarrboro.com';
  assert.deepEqual(await call(order, '/'), { status: 302, location: '/order' });
  assert.deepEqual(await call(order, '/app.js'), { status: 302, location: '/order' });
  assert.equal((await call(order, '/api/staff', 'POST')).status, 404);
  assert.equal((await call(order, '/api/login', 'POST')).status, 404);
  assert.equal((await call(order, '/order')).status, 200);
  assert.equal((await call(order, '/order.js')).status, 200);
  assert.equal((await call(order, '/api/brand')).status, 200);
  assert.equal((await call('Order.Napolicarrboro.com', '/')).status, 302);

  // The staff address is unchanged.
  const staff = 'restaurant-ops.onrender.com';
  assert.equal((await call(staff, '/')).status, 200);
  assert.equal((await call(staff, '/order')).status, 200);
});
