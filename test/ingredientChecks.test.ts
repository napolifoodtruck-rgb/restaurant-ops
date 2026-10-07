import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boughtNotInRecipes, nameLikeness, notBoughtLately, type Bought, type CheckProduct } from '../src/core/ingredientChecks.ts';

const today = '2026-10-07';
const products: CheckProduct[] = [
  { id: 'cream-old', name: 'Heavy Cream', baseUnit: 'qt', kind: 'food', unitPrice: 4, dimension: 'volume' },
  { id: 'cream-new', name: 'Cream, Heavy 40%', baseUnit: 'qt', kind: 'food', unitPrice: 4.5, dimension: 'volume' },
  { id: 'chili', name: 'Spice, Pepper Red Crushed', baseUnit: 'lb', kind: 'food', unitPrice: 6, dimension: 'mass' },
  { id: 'portabella', name: 'Mushrooms, Portabella', baseUnit: 'lb', kind: 'food', unitPrice: 7, dimension: 'mass' },
  { id: 'shiitake', name: 'Mushrooms, Shiitake', baseUnit: 'lb', kind: 'food', unitPrice: 9, dimension: 'mass' },
  { id: 'trumpet', name: 'Mushrooms, Royal Trumpet', baseUnit: 'lb', kind: 'food', unitPrice: 8, dimension: 'mass' },
  { id: 'gloves', name: 'Gloves, Nitrile', baseUnit: 'each', kind: 'other' },
];
const weekly = (productId: string, from: string, n: number, packBase: number, vendor = 'Sysco'): Bought[] =>
  Array.from({ length: n }, (_, k) => ({ productId, date: new Date(Date.parse(`${from}T12:00:00Z`) + k * 7 * 86_400_000).toISOString().slice(0, 10), invoiceId: `${productId}-${k}`, packBase, packs: 1, dollars: 20, vendor }));

const input = {
  products,
  bought: [
    ...weekly('cream-old', '2026-05-07', 4, 2, 'Homeland Creamery'), // last on May 28
    ...weekly('cream-new', '2026-08-13', 8, 2), // weekly since mid-August
    { productId: 'chili', date: '2026-04-01', invoiceId: 'c1', packBase: 5, packs: 1, dollars: 30 }, // a 5 lb bag in April
    ...weekly('shiitake', '2026-08-13', 8, 3, 'Blue Sky Farms'),
    ...weekly('trumpet', '2026-08-13', 8, 3, 'Blue Sky Farms'),
    ...weekly('gloves', '2026-08-13', 8, 100),
  ],
  uses: [
    { productId: 'cream-old', perWeek: 6, dishes: ['Spinaci'] },
    { productId: 'chili', perWeek: 0.1, dishes: ['Diavola'] },
    { productId: 'portabella', perWeek: 1.5, dishes: ['Funghi'] },
    { productId: 'shiitake', perWeek: 1, dishes: ['Funghi'] },
  ],
  inRecipes: new Set(['cream-old', 'chili', 'portabella', 'shiitake']),
  recipesOf: new Map([['cream-old', ['Spinach Panna']], ['chili', ['Chili Oil']], ['portabella', ['Mushroom Blend']], ['shiitake', ['Mushroom Blend']]]),
  today,
  invoicesFrom: '2026-01-01',
};

test('names: the words that say what it is, in any order', () => {
  assert.equal(nameLikeness('Heavy Cream', 'Cream, Heavy 40% 1/2 Gal'), 1);
  assert.equal(nameLikeness('Milk, Whole', 'Milk, Whole Organic'), 2 / 3);
  assert.equal(nameLikeness('Tomatoes, Heirloom', 'Tomato, Heirloom'), 1);
  assert.equal(nameLikeness('Basil, Fresh', 'Gloves'), 0);
});

test('used every week, not bought since May: flagged, with what you buy now', () => {
  const flags = notBoughtLately(input);
  const cream = flags.find((f) => f.productId === 'cream-old')!;
  assert.equal(cream.last?.date, '2026-05-28');
  assert.equal(cream.last?.vendor, 'Homeland Creamery');
  assert.equal(cream.weeks, 18);
  assert.equal(cream.likely?.name, 'Cream, Heavy 40%');
  assert.equal(cream.likely?.times, 8);
});

test('a big bag used a pinch at a time is not flagged', () => {
  assert.ok(!notBoughtLately(input).some((f) => f.productId === 'chili')); // 0.1 lb a week from a 5 lb bag
});

test('never bought: the likely swap is the look-alike no recipe uses, not the one beside it in the same recipe', () => {
  const portabella = notBoughtLately(input).find((f) => f.productId === 'portabella')!;
  assert.equal(portabella.last, undefined);
  assert.equal(portabella.likely?.name, 'Mushrooms, Royal Trumpet'); // shiitake is already in the blend
  assert.equal(portabella.likely?.inNoRecipe, true);
});

test('bought on invoice after invoice, in no recipe: listed; supplies are not', () => {
  const list = boughtNotInRecipes(input);
  assert.deepEqual(list.map((x) => x.name), ['Cream, Heavy 40%', 'Mushrooms, Royal Trumpet']);
  assert.equal(list[0]!.times, 8);
});

test('a vendor who invoiced every week and then stopped is flagged; a monthly one a month late is not', async () => {
  const { quietVendors } = await import('../src/core/ingredientChecks.ts');
  const every = (vendorId: string, vendor: string, from: string, n: number, step: number) =>
    Array.from({ length: n }, (_, k) => ({ vendorId, vendor, kind: 'food' as const, date: new Date(Date.parse(`${from}T12:00:00Z`) + k * step * 86_400_000).toISOString().slice(0, 10) }));
  const invoices = [
    ...every('home', 'Homeland Creamery', '2025-12-04', 26, 7), // weekly, last on May 28
    ...every('sysco', 'Sysco', '2026-04-01', 27, 7), // weekly, still coming
    ...every('rare', 'Spice House', '2026-01-10', 8, 30), // monthly, last Aug 7: two months is under 3 gaps
  ];
  const quiet = quietVendors(invoices, '2026-10-07');
  assert.deepEqual(quiet.map((q) => [q.vendor, q.lastDate, q.usualGap]), [['Homeland Creamery', '2026-05-28', 7]]);
});
