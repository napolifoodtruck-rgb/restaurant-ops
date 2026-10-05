import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuMargins, type MarginSaleLine } from '../src/core/margins.ts';
import { applyLinks, confirmLink, emptyLinkState, linkLookup } from '../src/core/menuLinks.ts';
import { RecipeBook, type Product, type Recipe } from '../src/core/recipes.ts';
import { isStaffMeal, squareItemSales, squareMenuItems, type SquareCatalogObject } from '../src/connectors/square.ts';
import { theoreticalUsage } from '../src/core/sales.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const products: Product[] = [
  { id: 'dough', name: 'Dough ball', baseUnit: 'each', cost: { price: 0.4, per: { amount: 1, unit: 'each' } } },
  { id: 'mozz', name: 'Mozzarella', baseUnit: 'lb', cost: { price: 6, per: { amount: 1, unit: 'lb' } } },
  { id: 'prosciutto', name: 'Prosciutto', baseUnit: 'lb', cost: { price: 20, per: { amount: 1, unit: 'lb' } } },
  { id: 'tomato', name: 'Tomatoes', baseUnit: 'oz', cost: { price: 0.1, per: { amount: 1, unit: 'oz' } } },
  { id: 'lettuce', name: 'Lettuce', baseUnit: 'oz', cost: { price: 0.25, per: { amount: 1, unit: 'oz' } } },
];
const p = (id: string, amount: number, unit: string) => ({ item: { kind: 'product' as const, id }, quantity: { amount, unit } });
const dish = (id: string, ...ingredients: ReturnType<typeof p>[]): Recipe => ({ id, name: id, kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients });
const recipes: Recipe[] = [
  dish('margherita', p('dough', 1, 'each'), p('mozz', 4, 'oz'), p('tomato', 3, 'oz')), // 0.40 + 1.50 + 0.30 = 2.20
  dish('parma', p('dough', 1, 'each'), p('mozz', 4, 'oz'), p('prosciutto', 2, 'oz')), // 0.40 + 1.50 + 2.50 = 4.40
  dish('marinara', p('dough', 1, 'each'), p('tomato', 4, 'oz')), // 0.80
  dish('special', p('dough', 1, 'each'), p('prosciutto', 4, 'oz')), // 5.40
  dish('salad', p('lettuce', 4, 'oz')), // 1.00
  { id: 'sauce', name: 'Sauce', kind: 'prep', yield: { amount: 32, unit: 'oz' }, ingredients: [p('tomato', 32, 'oz')] }, // $0.10/oz
];
const book = new RecipeBook(products, recipes);

const state = applyLinks(emptyLinkState(), [
  { catalogId: 'V-MARG', posName: 'Margherita', recipeId: 'margherita', matchedBy: 'name' },
  { catalogId: 'V-MARG-SHIFT', posName: 'Margherita Shift', recipeId: 'margherita', matchedBy: 'name' },
  { catalogId: 'V-PARMA', posName: 'Parma', recipeId: 'parma', matchedBy: 'name' },
  { catalogId: 'V-MARINARA', posName: 'Marinara', recipeId: 'marinara', matchedBy: 'name' },
  { catalogId: 'V-SPECIAL', posName: 'Special', recipeId: 'special', matchedBy: 'name' },
  { catalogId: 'V-SALAD', posName: 'House Salad', recipeId: 'salad', matchedBy: 'name' },
  { catalogId: 'V-SIDE', posName: 'Add A Side (Sauce)', recipeId: 'sauce', portion: { amount: 2, unit: 'oz' }, matchedBy: 'manager' },
]);

const sales: MarginSaleLine[] = [
  { catalogId: 'V-MARG', name: 'Margherita', quantity: 100, netSales: 1520, category: 'Pizza', listPrice: 16 }, // $15.20 a plate: 5% given away
  { catalogId: 'V-PARMA', name: 'Parma', quantity: 60, netSales: 1380, category: 'Pizza', listPrice: 23 },
  { catalogId: 'V-MARINARA', name: 'Marinara', quantity: 10, netSales: 140, category: 'Pizza', listPrice: 14 },
  { catalogId: 'V-SPECIAL', name: 'Special', quantity: 10, netSales: 240, category: 'Pizza', listPrice: 24 },
  { catalogId: 'V-SALAD', name: 'House Salad', quantity: 50, netSales: 500, category: 'Apps', listPrice: 10 },
  { catalogId: 'V-SIDE', name: 'Add A Side (Sauce)', quantity: 20, netSales: 30, category: 'Apps', listPrice: 1.5 },
  { catalogId: 'V-MARG-SHIFT', name: 'Margherita Shift', quantity: 5, netSales: 0, category: 'Pizza', listPrice: 0 },
  { catalogId: 'V-CALABRIA', name: 'Calabria', quantity: 40, netSales: 800, category: 'Pizza', listPrice: 20 },
  { catalogId: '', name: 'Gift Card', quantity: 3, netSales: 150 },
];

test('margins use what each plate really sold for', () => {
  const report = menuMargins(book, linkLookup(state), sales);
  const marg = report.dishes.find((d) => d.recipeId === 'margherita')!;
  close(marg.averagePrice, 15.2);
  close(marg.discountShare, 0.05);
  close(marg.cost.total, 2.2);
  close(marg.foodCostShare, 2.2 / 15.2);
  close(marg.listFoodCostShare, 2.2 / 16);
  close(marg.contribution, 13);
  close(marg.totalContribution, 1300);

  // A side of sauce costs its 2 oz portion, not the whole batch.
  close(report.dishes.find((d) => d.recipeId === 'sauce')?.cost.total, 0.2);

  // Highest total contribution first.
  assert.deepEqual(report.dishes.map((d) => d.recipeId), ['margherita', 'parma', 'salad', 'special', 'marinara', 'sauce']);
});

test('staff meals, unlinked items and gift cards are kept apart', () => {
  const report = menuMargins(book, linkLookup(state), sales);
  assert.deepEqual(report.staffMeals.map((s) => [s.name, s.quantity]), [['Margherita Shift', 5]]);
  close(report.staffMeals[0]?.totalCost, 11);
  assert.deepEqual(report.unlinked.map((u) => u.name), ['Calabria']);
  // The gift card isn't a menu item, so coverage is 3,810 linked out of 4,610 sold.
  close(report.coverage, 3810 / 4610);
  close(report.totals.netSales, 3810);
});

test('seasonal versions of one button are compared as separate dishes', () => {
  const versions = confirmLink(confirmLink(emptyLinkState(), { catalogId: 'V-APP', itemName: 'Ricotta' }, 'salad'), { catalogId: 'V-APP', itemName: 'Ricotta' }, 'special', undefined, '2026-09-15');
  const report = menuMargins(book, linkLookup(versions), [
    { catalogId: 'V-APP', name: 'Ricotta', quantity: 30, netSales: 420, category: 'Apps', date: '2026-08-20' },
    { catalogId: 'V-APP', name: 'Ricotta', quantity: 10, netSales: 140, category: 'Apps', date: '2026-09-02' },
    { catalogId: 'V-APP', name: 'Ricotta', quantity: 20, netSales: 280, category: 'Apps', date: '2026-09-20' },
  ]);
  assert.deepEqual(report.dishes.map((d) => [d.name, d.quantity]).sort(), [['Ricotta (salad)', 40], ['Ricotta (special)', 20]]);
  close(report.dishes.find((d) => d.recipeId === 'salad')?.contribution, 14 - 1);
  close(report.dishes.find((d) => d.recipeId === 'special')?.contribution, 14 - 5.4);
});

test('dishes are sorted into menu-engineering groups within their category', () => {
  const report = menuMargins(book, linkLookup(state), sales);
  const groups = Object.fromEntries(report.dishes.map((d) => [d.recipeId, d.menuClass]));
  // Pizza: 180 plates over 4 pizzas, average contribution $2,734 / 180 = $15.19.
  assert.equal(groups.parma, 'star'); // popular, $18.60 a plate
  assert.equal(groups.margherita, 'workhorse'); // the most popular, $13.00 a plate
  assert.equal(groups.special, 'puzzle'); // slow, $18.60 a plate
  assert.equal(groups.marinara, 'dog'); // slow, $13.20 a plate
  // Apps: the salad sells most and earns most per plate.
  assert.equal(groups.salad, 'star');
  assert.equal(groups.sauce, 'dog');
});

test('theoretical usage follows the same links, portions included', () => {
  const { usage, unmappedItems } = theoreticalUsage(book, { lookup: linkLookup(state) }, sales.filter((s) => s.catalogId));
  // 100 + 5 staff meals of Margherita at 4 oz, plus 60 Parma: 165 × 0.25 lb.
  close(usage.products.get('mozz'), 165 * 0.25);
  // 20 sides × 2 oz of sauce.
  close(usage.recipes.get('sauce'), 40);
  assert.deepEqual(unmappedItems.map((u) => u.name), ['Calabria']);
});

// ---------------------------------------------------------------- Square connector

test('reads the Square catalog per variation and spots staff meals', () => {
  const objects: SquareCatalogObject[] = [
    { type: 'ITEM', id: 'I-MARG', item_data: { name: 'Margherita', categories: [{ id: 'C-PIZZA' }], variations: [{ id: 'V-MARG', item_variation_data: { name: 'Regular', price_money: { amount: 1600, currency: 'USD' } } }] } },
    { type: 'ITEM', id: 'I-SHIFT', item_data: { name: 'Margherita Shift', variations: [{ id: 'V-MARG-SHIFT', item_variation_data: { name: 'Regular', price_money: { amount: 0, currency: 'USD' } } }] } },
    {
      type: 'ITEM',
      id: 'I-SIDE',
      item_data: {
        name: 'Add A Side',
        variations: [
          { id: 'V-SIDE-FOC', item_variation_data: { name: 'Focaccia', price_money: { amount: 200 } } },
          { id: 'V-SIDE-SAUCE', item_variation_data: { name: 'San Marzano Tomato Sauce', price_money: { amount: 150 } } },
          { id: 'V-GONE', is_deleted: true, item_variation_data: { name: 'Old' } },
        ],
      },
    },
    { type: 'ITEM', id: 'I-DEL', is_deleted: true, item_data: { name: 'Gone', variations: [{ id: 'V-X' }] } },
  ];
  const menu = squareMenuItems(objects, { 'C-PIZZA': 'Pizza' });
  assert.deepEqual(menu, [
    { catalogId: 'V-MARG', itemId: 'I-MARG', itemName: 'Margherita', category: 'Pizza', price: 16 },
    { catalogId: 'V-MARG-SHIFT', itemId: 'I-SHIFT', itemName: 'Margherita Shift', price: 0, staffMeal: true },
    { catalogId: 'V-SIDE-FOC', itemId: 'I-SIDE', itemName: 'Add A Side', variationName: 'Focaccia', price: 2 },
    { catalogId: 'V-SIDE-SAUCE', itemId: 'I-SIDE', itemName: 'Add A Side', variationName: 'San Marzano Tomato Sauce', price: 1.5 },
  ]);
  assert.equal(isStaffMeal('Shift House Salad', 0), true);
  assert.equal(isStaffMeal('Shiftless', 0), false);
  assert.equal(isStaffMeal('Margherita Shift', 16), false);

  const lines = squareItemSales(
    [
      { 'ItemSales.item_variation_id': 'V-MARG', 'ItemSales.item_name': 'Margherita', 'ItemSales.item_variation_name': 'Regular', 'ItemSales.category_name': 'Pizza', 'ItemSales.items_sold_count': 10, 'ItemSales.item_net_sales': 152 },
      { 'ItemSales.item_variation_id': 'V-SIDE-FOC', 'ItemSales.item_name': 'Add A Side', 'ItemSales.item_variation_name': 'Focaccia', 'ItemSales.category_name': 'Apps', 'ItemSales.items_sold_count': '4', 'ItemSales.item_net_sales': '6.5' },
      // Sold under its old name: today's price is for today's dish.
      { 'ItemSales.item_variation_id': 'V-MARG', 'ItemSales.item_name': 'Margherita DOC', 'ItemSales.items_sold_count': 2, 'ItemSales.item_net_sales': 28 },
      { 'ItemSales.item_name': 'Gift Card', 'ItemSales.category_name': 'Uncategorized', 'ItemSales.items_sold_count': 1, 'ItemSales.item_net_sales': 50 },
    ],
    menu,
  );
  assert.deepEqual(lines, [
    { catalogId: 'V-MARG', name: 'Margherita', quantity: 10, netSales: 152, category: 'Pizza', listPrice: 16 },
    { catalogId: 'V-SIDE-FOC', name: 'Add A Side (Focaccia)', quantity: 4, netSales: 6.5, category: 'Apps', listPrice: 2 },
    { catalogId: 'V-MARG', name: 'Margherita DOC', quantity: 2, netSales: 28 },
    { catalogId: '', name: 'Gift Card', quantity: 1, netSales: 50, category: 'Uncategorized' },
  ]);
});
