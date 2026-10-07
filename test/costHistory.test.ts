import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costHistory, priceOn } from '../src/core/costHistory.ts';

test('a price on a date is the latest invoice up to it, or the first one before any', () => {
  const pts = [{ date: '2026-03-01', perUnit: 4 }, { date: '2026-06-01', perUnit: 5 }];
  assert.equal(priceOn(pts, '2026-01-01'), 4);
  assert.equal(priceOn(pts, '2026-05-31'), 4);
  assert.equal(priceOn(pts, '2026-06-01'), 5);
  assert.equal(priceOn([], '2026-06-01'), undefined);
});

test('a dish costed at each week’s prices, and what moved it', () => {
  const prices: Record<string, { date: string; perUnit: number }[]> = {
    mozz: [{ date: '2025-10-01', perUnit: 4 }, { date: '2026-08-01', perUnit: 5 }], // up a dollar a lb in August
    flour: [{ date: '2025-10-01', perUnit: 0.5 }],
  };
  const h = costHistory({
    lines: [{ productId: 'mozz', name: 'Mozzarella', amount: 0.25 }, { productId: 'flour', name: 'Flour', amount: 0.5 }, { productId: 'basil', name: 'Basil', amount: 0.01 }],
    pricesOf: (id) => prices[id] ?? [], priceNow: (id) => (id === 'basil' ? 10 : undefined), today: '2026-10-07',
  });
  assert.equal(h.points[0]!.cost, 1.35); // 0.25×4 + 0.5×0.5 + 0.01×10 (basil at today's price, no invoices)
  assert.equal(h.points.at(-1)!.cost, 1.6);
  assert.equal(h.points.at(-1)!.date, '2026-10-07');
  assert.deepEqual(h.drivers.map((d) => [d.name, d.change]), [['Mozzarella', 0.25]]);
  assert.equal(h.complete, true);
});
