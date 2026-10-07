import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arranged, modifierProblems, onlineMenu, type CatalogObject, type OnlineMenuItem } from '../src/core/onlineMenu.ts';

// Shaped like the Square catalog: a pizza with the cooking choice, a gluten-sensitive crust and toppings; a salad.
const catalog: CatalogObject[] = [
  { type: 'CATEGORY', id: 'cat-pizza', category_data: { name: 'Pizza' } },
  { type: 'CATEGORY', id: 'cat-salad', category_data: { name: 'Salads' } },
  { type: 'IMAGE', id: 'img-1', image_data: { url: 'https://example.com/margherita.jpg' } },
  {
    type: 'MODIFIER_LIST', id: 'ml-cook', modifier_list_data: { name: 'How would you like it cooked?', selection_type: 'SINGLE', modifiers: [
      { id: 'm-full', modifier_data: { name: 'FULLY COOKED & SLICED (NOT AVAILABLE ONLINE)', ordinal: 0 } },
      { id: 'm-part', modifier_data: { name: 'PARTIALLY COOKED (ONLY OPTION ONLINE)', ordinal: 1 } },
    ] },
  },
  { type: 'MODIFIER_LIST', id: 'ml-gf', modifier_list_data: { name: 'Gluten Sensitive Crust?', selection_type: 'MULTIPLE', modifiers: [{ id: 'm-gf', modifier_data: { name: 'Gluten Sensitive Crust', price_money: { amount: 400 } } }] } },
  { type: 'MODIFIER_LIST', id: 'ml-veg', modifier_list_data: { name: 'Toppings Vegetables', selection_type: 'MULTIPLE', modifiers: [
    { id: 'm-arugula', modifier_data: { name: '++ Arugula', price_money: { amount: 200 }, ordinal: 1 } },
    { id: 'm-pesto', modifier_data: { name: '++ Pesto', price_money: { amount: 300 }, hidden_online: true, ordinal: 2 } },
    { id: 'm-gone', is_deleted: true, modifier_data: { name: 'Old topping' } },
  ] } },
  {
    type: 'ITEM', id: 'item-marg', item_data: {
      name: 'Margherita', description_plaintext: 'San Marzano Tomato Sauce, Fior di Latte Mozzarella, Basil', reporting_category: { id: 'cat-pizza' }, image_ids: ['img-1'],
      variations: [{ id: 'var-marg', item_variation_data: { name: 'Regular', price_money: { amount: 1500 } } }],
      modifier_list_info: [
        { modifier_list_id: 'ml-veg', ordinal: 2 },
        { modifier_list_id: 'ml-cook', min_selected_modifiers: 1, max_selected_modifiers: 1, ordinal: 0 },
        { modifier_list_id: 'ml-gf', min_selected_modifiers: 0, max_selected_modifiers: 1, ordinal: 1 },
        { modifier_list_id: 'ml-off', enabled: false },
      ],
    },
  },
  { type: 'ITEM', id: 'item-salad', item_data: { name: 'House Salad', categories: [{ id: 'cat-salad' }], variations: [{ id: 'var-salad', item_variation_data: { name: 'Regular', price_money: { amount: 900 } } }] } },
  { type: 'ITEM', id: 'item-old', item_data: { name: 'Old Special', is_archived: true, variations: [{ id: 'var-old' }] } },
  { type: 'ITEM', id: 'item-deleted', is_deleted: true, item_data: { name: 'Gone', variations: [{ id: 'var-gone' }] } },
];

test('every live Square item is listed, none online until published', () => {
  const menu = onlineMenu(catalog, [], {}, '2026-10-10');
  assert.deepEqual(menu.map((x) => [x.category, x.name, x.published]), [['Pizza', 'Margherita', false], ['Salads', 'House Salad', false]]);
  const marg = menu[0]!;
  assert.equal(marg.description, 'San Marzano Tomato Sauce, Fior di Latte Mozzarella, Basil');
  assert.equal(marg.image, 'https://example.com/margherita.jpg');
  assert.deepEqual(marg.variations, [{ id: 'var-marg', name: 'Regular', price: 15 }]);
});

test('pizzas count against the windows by category, unless someone says otherwise', () => {
  const menu = onlineMenu(catalog, [], {}, '2026-10-10');
  assert.deepEqual(menu.map((x) => [x.name, x.countsAsPizza, x.pizzaFromCategory]), [['Margherita', true, true], ['House Salad', false, false]]);
  const set = onlineMenu(catalog, [{ itemId: 'item-salad', published: true, countsAsPizza: true }, { itemId: 'item-marg', published: true, countsAsPizza: false }], {}, '2026-10-10');
  assert.deepEqual(set.map((x) => [x.name, x.countsAsPizza, x.pizzaFromCategory]), [['Margherita', false, false], ['House Salad', true, false]]);
});

test('modifier lists in Square order; a modifier Square hides online starts hidden', () => {
  const marg = onlineMenu(catalog, [], {}, '2026-10-10')[0]!;
  assert.deepEqual(marg.modifierLists.map((l) => l.name), ['How would you like it cooked?', 'Gluten Sensitive Crust?', 'Toppings Vegetables']);
  // Square's own labels decide before anyone sets anything: partially cooked on, fully cooked and gluten-sensitive off.
  assert.deepEqual(marg.modifierLists[0]!.modifiers.map((m) => [m.mode, m.locked]), [['hidden', true], ['always', undefined]]);
  assert.deepEqual(marg.modifierLists[1]!.modifiers.map((m) => m.mode), ['hidden']);
  assert.deepEqual(modifierProblems(marg), []);
  assert.deepEqual(marg.modifierLists[0]!, { ...marg.modifierLists[0]!, single: true, min: 1, max: 1 });
  assert.deepEqual(marg.modifierLists[2]!.modifiers.map((m) => [m.name, m.price, m.mode, m.squareHidesOnline]), [['++ Arugula', 2, 'shown', false], ['++ Pesto', 3, 'hidden', true]]);
});

test('partially cooked always on, fully cooked and gluten-sensitive hidden', () => {
  const modes = { 'm-part': 'always', 'm-full': 'hidden', 'm-gf': 'hidden' } as const;
  const marg = onlineMenu(catalog, [{ itemId: 'item-marg', published: true }], modes, '2026-10-10')[0]!;
  assert.deepEqual(marg.modifierLists[0]!.modifiers.map((m) => m.mode), ['hidden', 'always']);
  assert.deepEqual(marg.modifierLists[1]!.modifiers.map((m) => m.mode), ['hidden']);
  assert.deepEqual(modifierProblems(marg), []);
});

test('a required choice with every option hidden would stop the order', () => {
  const marg = onlineMenu(catalog, [{ itemId: 'item-marg', published: true }], { 'm-part': 'hidden', 'm-full': 'hidden' }, '2026-10-10')[0]!;
  assert.deepEqual(modifierProblems(marg), ['How would you like it cooked?: needs a choice, but every option is hidden online.']);
  // "Not available online" stays hidden whatever is set: fully cooked can't be ordered online.
  const fullOn = onlineMenu(catalog, [{ itemId: 'item-marg', published: true }], { 'm-part': 'shown', 'm-full': 'always' }, '2026-10-10')[0]!;
  assert.deepEqual(fullOn.modifierLists[0]!.modifiers.map((m) => m.mode), ['hidden', 'shown']);
});

test('sold out online for today only', () => {
  const items = [{ itemId: 'item-marg', published: true, soldOutOn: '2026-10-10' }];
  assert.equal(onlineMenu(catalog, items, {}, '2026-10-10')[0]!.soldOutToday, true);
  assert.equal(onlineMenu(catalog, items, {}, '2026-10-11')[0]!.soldOutToday, false);
});

test('sold out in Square at the restaurant’s location', () => {
  const sizes = (overrides: { location_id?: string; sold_out?: boolean }[][]): CatalogObject[] => catalog.map((o) => (o.id !== 'item-marg' ? o : {
    ...o, item_data: { ...o.item_data, variations: overrides.map((location_overrides, i) => ({ id: `var-${i}`, item_variation_data: { name: `Size ${i}`, price_money: { amount: 1500 }, location_overrides } })) },
  }));
  const items = [{ itemId: 'item-marg', published: true }];
  const one = sizes([[{ location_id: 'loc-1', sold_out: true }], [{ location_id: 'loc-1', sold_out: false }]]);
  const marg = onlineMenu(one, items, {}, '2026-10-10', 'loc-1').find((x) => x.itemId === 'item-marg')!;
  assert.deepEqual([marg.variations.map((v) => Boolean(v.soldOut)), marg.soldOutInSquare], [[true, false], false]);
  // Sold out somewhere else doesn't count here.
  const all = sizes([[{ location_id: 'loc-2', sold_out: true }]]);
  assert.equal(onlineMenu(all, items, {}, '2026-10-10', 'loc-1').find((x) => x.itemId === 'item-marg')!.soldOutInSquare, false);
  assert.equal(onlineMenu(all, items, {}, '2026-10-10', 'loc-2').find((x) => x.itemId === 'item-marg')!.soldOutInSquare, true);
});

test('arranged: sections as listed, items by position, the rest alphabetical after', () => {
  const item = (name: string, category: string, position?: number) => ({ itemId: name, name, category, ...(position !== undefined ? { position } : {}) }) as OnlineMenuItem;
  const menu = [item('Zucca', 'Pizza'), item('Diavola', 'Pizza', 2), item('Marg', 'Pizza', 1), item('Pistachio', 'Gelato', 0), item('Arancini', 'Apps'), item('Bruschetta', 'Bread')];
  assert.deepEqual(arranged(menu, ['Pizza', 'Gelato']).map((x) => x.name), ['Marg', 'Diavola', 'Zucca', 'Pistachio', 'Arancini', 'Bruschetta']);
  assert.deepEqual(arranged(menu, []).map((x) => x.category), ['Apps', 'Bread', 'Gelato', 'Pizza', 'Pizza', 'Pizza']);
});
