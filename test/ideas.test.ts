import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dishIdeas, foodCostIdeas, laborIdeas, prepIdeas, priceIdeas, rankIdeas, unusedIdeas, vendorIdeas, wasteIdeas } from '../src/core/ideas.ts';

test('waste: bought well beyond the recipes, two periods running, in dollars a month', () => {
  const now = [{ productId: 'mozz', name: 'Mozzarella', bought: 1400, expected: 1000, gap: 400 }, { productId: 'flour', name: 'Flour', bought: 900, expected: 860, gap: 40 }, { productId: 'basil', name: 'Basil', bought: 200, expected: 100, gap: 100 }];
  const before = [{ productId: 'mozz', name: 'Mozzarella', bought: 1300, expected: 1000, gap: 300 }, { productId: 'basil', name: 'Basil', bought: 100, expected: 110, gap: -10 }];
  const ideas = wasteIdeas(now, before, 28, 'kitchen');
  assert.deepEqual(ideas.map((i) => [i.key, i.monthly]), [['waste:kitchen:mozz', 429]]); // basil's gap didn't hold; flour's is small
  assert.match(ideas[0]!.title, /\$429 a month more bought/);
  assert.deepEqual(unusedIdeas([{ productId: 'lamb', name: 'Ground Lamb', bought: 600 }, { productId: 'x', name: 'Tiny', bought: 20 }, { productId: 'k', name: 'Keg Deposit', bought: 400 }], 28, 'kitchen').map((i) => i.key), ['unused:kitchen:lamb']);
  assert.deepEqual(unusedIdeas([{ productId: 'gin', name: 'Gin', bought: 300 }, { productId: 'vod', name: 'Vodka', bought: 200 }], 28, 'bar', { coverage: 0.05 }).map((i) => [i.key, i.monthly]), [['unused:bar:all', 536]]); // few drink recipes yet: one idea for the lot
});

test('prices up, and the same thing cheaper from another vendor', () => {
  const p = (date: string, vendor: string, perUnit: number, quantity = 4) => ({ date, vendor, perUnit, packPrice: perUnit * 50, quantity });
  const olives = { productId: 'ol', name: 'Olives', unit: 'lb', change90: 0.3, points: [p('2026-07-20', 'IGF', 4), p('2026-09-01', 'IGF', 5), p('2026-09-28', 'IGF', 5.2)] };
  const flour = { productId: 'fl', name: 'Flour', unit: 'lb', change90: 0.01, points: [p('2026-08-01', 'Ferraro', 0.9, 20), p('2026-09-20', 'IGF', 1.0, 20), p('2026-09-30', 'IGF', 1.0, 20)] };
  assert.deepEqual(priceIdeas([olives, flour], '2026-10-06').map((i) => i.key), ['price:ol']);
  const v = vendorIdeas([olives, flour], '2026-10-06');
  assert.deepEqual(v.map((i) => [i.key, i.monthly]), [['vendor:fl:Ferraro', 100]]); // 0.10/lb × 3,000 lb in 90 days ÷ 3
});

test('a dish selling less, and one whose food cost runs well over its section', () => {
  const cats = [{ name: 'Pizza', foodCostShare: 0.2, dishes: [
    { recipeId: 'greca', name: 'Greca', sold: 300, averagePrice: 16, plateCost: 3, leftPerPlate: 13, foodCostShare: 0.19, trend: { change: -0.5, series: [6, 5.5, null, 4, 3, 3] } },
    { recipeId: 'parma', name: 'Parma', sold: 700, averagePrice: 18, plateCost: 6, leftPerPlate: 12, foodCostShare: 0.33, trend: { change: 0, series: [8, 8, 8, 8] } },
  ] }];
  assert.deepEqual(dishIdeas(cats, 26, 'kitchen').map((i) => [i.key, i.monthly]), [['dish:greca', 930]]); // (5.75 − 3) plates a day × $13 × 26 open days
  const fc = foodCostIdeas(cats, 90, 'kitchen');
  assert.deepEqual(fc.map((i) => i.key), ['foodcost:parma']);
  assert.match(fc[0]!.suggestion, /\$30\.00/); // $6 ÷ 20% = $30
});

test('labor: stretches staffed well beyond their sales; prep: one cook much slower on one item', () => {
  const cells = Array.from({ length: 14 }, (_, i) => ({ weekday: 5, hour: 10 + i, sales: 800, laborHours: 8 }));
  cells.push({ weekday: 1, hour: 15, sales: 100, laborHours: 4 }, { weekday: 1, hour: 16, sales: 100, laborHours: 4 });
  const l = laborIdeas(cells, 15);
  assert.deepEqual(l.map((i) => i.key), ['labor:1:15-16']);
  assert.match(l[0]!.title, /Mondays 3pm–5pm/);
  const t = (by: string, minutes: number, day: number) => ({ itemId: 'mozz', name: 'Portion mozzarella', minutes, amount: 2, by, byName: by === 'a' ? 'Alex' : 'Blair', date: `2026-09-${10 + day}` });
  const times = [...[30, 32, 28, 35].map((m, i) => t('a', m, i)), ...[15, 14, 16, 15].map((m, i) => t('b', m, i))];
  const p = prepIdeas(times, 14, 16); // 65 extra minutes in 2 weeks: about $37 a month
  assert.deepEqual(p.map((i) => i.key), ['prep:mozz:a']);
  assert.match(p[0]!.title, /Alex takes about 31 minutes, the others about 15/);
});

test('ranked by money, one per key', () => {
  const r = rankIdeas([{ key: 'a', kind: 'price', title: '', monthly: 10, why: [], suggestion: '' }, { key: 'b', kind: 'waste', title: '', monthly: 90, why: [], suggestion: '' }, { key: 'a', kind: 'price', title: '', monthly: 10, why: [], suggestion: '' }]);
  assert.deepEqual(r.map((i) => i.key), ['b', 'a']);
});
