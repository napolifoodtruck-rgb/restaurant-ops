import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountWineDays, lastYearRange, menuReport, orderType, previousRange, salesReport, wineKind, type Line, type Order } from '../src/core/reports.ts';

const order = (o: Partial<Order> & { id: string }): Order => ({ day: '2026-10-03', covers: 0, sales: 0, tips: 0, autoGratuity: 0, ...o });
const line = (l: Partial<Line> & { orderId: string; item: string }): Line => ({ day: '2026-10-03', quantity: 1, sales: 0, ...l });

test('order types: a table is a table order; register orders without one are to go; online is online', () => {
  assert.equal(orderType({ table: 'T6', source: 'Point of Sale' }), 'table');
  assert.equal(orderType({ source: 'Point of Sale' }), 'register'); // rung "For Here" with no table: really to go
  assert.equal(orderType({ source: 'Square Online' }), 'online');
});

test('periods: the one before, and the same weekdays last year', () => {
  assert.deepEqual(previousRange('2026-09-21', '2026-10-04'), { from: '2026-09-07', to: '2026-09-20' });
  assert.deepEqual(lastYearRange('2026-09-21', '2026-10-04'), { from: '2025-09-22', to: '2025-10-05' }); // Monday to Sunday, a year back
});

test('wine: glass or bottle from the name; half-price days found from the buttons', () => {
  assert.equal(wineKind({ item: 'Borghese Pinot Grigio GLS' }), 'glass');
  assert.equal(wineKind({ item: 'St. Evasio - Gavi BTL' }), 'bottle');
  const wed = '2026-09-30', sat = '2026-10-03';
  const lines = [
    line({ orderId: 'a', item: 'Pinot GLS', variation: '50% OFF WINE WEDNESDAY', category: 'Wine', quantity: 8, day: wed }),
    line({ orderId: 'a', item: 'Pinot GLS', variation: 'Regular', category: 'Wine', quantity: 2, day: wed }),
    line({ orderId: 'b', item: 'Pinot GLS', variation: 'Regular', category: 'Wine', quantity: 10, day: sat }),
  ];
  assert.deepEqual(discountWineDays(lines), [3]);
});

test('team and sales: covers, cover rate and tip rate on table orders; auto-gratuity is a tip; wine per cover', () => {
  const orders = [
    order({ id: '1', table: 'T6', serverName: 'Ava', covers: 4, sales: 120, tips: 24 }),
    order({ id: '2', table: 'T2', serverName: 'Mara', covers: 8, sales: 400, autoGratuity: 80 }), // a large party: auto-gratuity
    order({ id: '3', serverName: 'Travis', sales: 60, tips: 5, source: 'Point of Sale' }), // to go at the register
    order({ id: '4', source: 'Square Online', sales: 40, tips: 4 }),
    order({ id: '5', table: 'T6', serverName: 'Ava', covers: 2, sales: 80, tips: 12, day: '2026-09-30' }), // Wednesday
  ];
  const lines = [
    line({ orderId: '1', item: 'Pinot GLS', category: 'Wine', sales: 24 }),
    line({ orderId: '1', item: 'Gavi BTL', category: 'Wine', sales: 40 }),
    line({ orderId: '5', item: 'Pinot GLS', category: 'Wine', sales: 6, day: '2026-09-30' }),
    line({ orderId: '3', item: 'Pinot GLS', category: 'Wine', sales: 12 }), // to go: not a server's table wine
  ];
  const r = salesReport(orders, lines, { wineDaysLeftOut: [3] });
  assert.deepEqual([r.totals.sales, r.totals.covers, r.totals.coverRate, r.totals.tips], [700, 14, 42.86, 125]);
  assert.equal(Math.round(r.totals.tipRate! * 1000) / 1000, 0.193); // (24+80+12) / 600, table orders only
  assert.deepEqual(r.byType.map((t) => [t.type, t.sales, t.orders]), [['table', 600, 3], ['register', 60, 1], ['online', 40, 1]]);
  assert.deepEqual(r.tables.map((t) => [t.table, t.sales, t.covers, t.turns]), [['T2', 400, 8, 1], ['T6', 200, 6, 2]]);
  const ava = r.servers.find((s) => s.name === 'Ava')!;
  assert.deepEqual([ava.covers, ava.coverRate, ava.wineGlass, ava.wineBottle, ava.wineCovers, ava.winePerCover], [6, 33.33, 24, 40, 4, 16]); // Wednesday's glass and covers left out
  assert.equal(r.servers.some((s) => s.name === 'Travis'), false); // to-go only: not judged as a server
});

test('menu items: by how they were ordered, ranked in their category; specials per day on', () => {
  const orders = [order({ id: '1', table: 'T1', day: '2026-10-01' }), order({ id: '2', source: 'Square Online', day: '2026-10-02' }), order({ id: '3', day: '2026-10-03' })];
  const lines = [
    line({ orderId: '1', item: 'Margherita', category: 'Pizza', quantity: 2, sales: 30, day: '2026-10-01' }),
    line({ orderId: '2', item: 'Margherita', category: 'Pizza', quantity: 1, sales: 15, day: '2026-10-02' }),
    line({ orderId: '3', item: 'Special: Fig', category: 'Pizza', quantity: 4, sales: 72, day: '2026-10-03' }),
  ];
  const before = { orders: [order({ id: 'p', table: 'T1', day: '2026-09-24' }), order({ id: 'q', day: '2026-09-25' })], lines: [line({ orderId: 'p', item: 'Margherita', category: 'Pizza', quantity: 4, sales: 60, day: '2026-09-24' }), line({ orderId: 'q', item: 'Margherita', category: 'Pizza', quantity: 0, day: '2026-09-25' })] };
  const r = menuReport(orders, lines, before);
  const [pizza] = r.categories;
  assert.deepEqual(pizza!.items.map((i) => [i.name, i.sales, i.daysOn, i.perDay]), [['Special: Fig', 72, 1, 4], ['Margherita', 45, 2, 1.5]]);
  assert.deepEqual(pizza!.items[1]!.byType, { table: 2, register: 0, online: 1 });
  assert.equal(Math.round(pizza!.items[1]!.change! * 100), -25); // 1.5 a day against 2 a day before
});
