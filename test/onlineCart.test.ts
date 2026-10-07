import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlineMenu, type CatalogObject } from '../src/core/onlineMenu.ts';
import { CartError, priceCart, publicMenu, tipProblem } from '../src/core/onlineCart.ts';

const catalog: CatalogObject[] = [
  { type: 'CATEGORY', id: 'cat-pizza', category_data: { name: 'Pizza' } },
  { type: 'CATEGORY', id: 'cat-salad', category_data: { name: 'Salads' } },
  { type: 'MODIFIER_LIST', id: 'ml-cook', modifier_list_data: { name: 'Cooked?', selection_type: 'SINGLE', modifiers: [
    { id: 'm-full', modifier_data: { name: 'Fully cooked' } },
    { id: 'm-part', modifier_data: { name: 'Partially cooked' } },
  ] } },
  { type: 'MODIFIER_LIST', id: 'ml-gf', modifier_list_data: { name: 'Crust', selection_type: 'MULTIPLE', modifiers: [{ id: 'm-gf', modifier_data: { name: 'Gluten sensitive crust', price_money: { amount: 400 } } }] } },
  { type: 'MODIFIER_LIST', id: 'ml-veg', modifier_list_data: { name: 'Toppings', selection_type: 'MULTIPLE', modifiers: [
    { id: 'm-arugula', modifier_data: { name: 'Arugula', price_money: { amount: 200 } } },
    { id: 'm-basil', modifier_data: { name: 'Basil', price_money: { amount: 100 } } },
  ] } },
  { type: 'ITEM', id: 'item-marg', item_data: { name: 'Margherita', reporting_category: { id: 'cat-pizza' },
    variations: [{ id: 'var-marg', item_variation_data: { name: 'Regular', price_money: { amount: 1500 } } }],
    modifier_list_info: [{ modifier_list_id: 'ml-cook', min_selected_modifiers: 1, max_selected_modifiers: 1 }, { modifier_list_id: 'ml-gf' }, { modifier_list_id: 'ml-veg', max_selected_modifiers: 1 }] } },
  { type: 'ITEM', id: 'item-salad', item_data: { name: 'Caesar', reporting_category: { id: 'cat-salad' },
    variations: [{ id: 'var-small', item_variation_data: { name: 'Small', price_money: { amount: 800 } } }, { id: 'var-big', item_variation_data: { name: 'Large', price_money: { amount: 1200 } } }] } },
  { type: 'ITEM', id: 'item-hidden', item_data: { name: 'Calzone', reporting_category: { id: 'cat-pizza' }, variations: [{ id: 'var-calz', item_variation_data: { name: 'Regular', price_money: { amount: 1600 } } }] } },
];
const today = '2026-10-06';
const modes = { 'm-full': 'hidden', 'm-part': 'always', 'm-gf': 'hidden' } as const;
const menu = onlineMenu(catalog, [{ itemId: 'item-marg', published: true }, { itemId: 'item-salad', published: true }, { itemId: 'item-hidden', published: false }], modes, today);

test('customers see published items, with always-on options as notes and hidden ones gone', () => {
  const items = publicMenu(menu);
  assert.deepEqual(items.map((x) => x.name), ['Margherita', 'Caesar']);
  const marg = items.find((x) => x.name === 'Margherita')!;
  assert.deepEqual(marg.notes, ['Partially cooked']);
  assert.deepEqual(marg.optionLists.map((l) => [l.name, l.single, l.options.map((o) => [o.name, o.price])]), [['Toppings', true, [['Arugula', 200], ['Basil', 100]]]]);
  assert.equal(marg.isPizza, true);
  assert.deepEqual(items.find((x) => x.name === 'Caesar')!.variations.map((v) => v.price), [800, 1200]);
});

test('a cart is priced from the menu, with partially cooked put on every pizza', () => {
  const cart = priceCart(menu, [{ variationId: 'var-marg', quantity: 2, optionIds: ['m-arugula'] }, { variationId: 'var-big', quantity: 1 }]);
  assert.equal(cart.pizzas, 2);
  assert.equal(cart.subtotal, 2 * 1700 + 1200);
  assert.deepEqual(cart.lines[0]!.modifiers.map((m) => m.name), ['Partially cooked', 'Arugula']);
  assert.equal(cart.lines[0]!.unitPrice, 1700);
});

test('a cart that asks for what isn’t offered online is refused, by name', () => {
  const bad = (lines: Parameters<typeof priceCart>[1], match: RegExp) => assert.throws(() => priceCart(menu, lines), (e: unknown) => e instanceof CartError && match.test(e.message));
  bad([], /empty/);
  bad([{ variationId: 'var-calz', quantity: 1 }], /isn’t on the online menu/);
  bad([{ variationId: 'var-nope', quantity: 1 }], /isn’t on the online menu/);
  bad([{ variationId: 'var-marg', quantity: 1, optionIds: ['m-full'] }], /set for online orders/);
  bad([{ variationId: 'var-marg', quantity: 1, optionIds: ['m-gf'] }], /isn’t available online/);
  bad([{ variationId: 'var-marg', quantity: 1, optionIds: ['m-arugula', 'm-basil'] }], /at most 1/);
  bad([{ variationId: 'var-small', quantity: 1, optionIds: ['m-arugula'] }], /isn’t available for it/);
  bad([{ variationId: 'var-marg', quantity: 0 }], /Pick 1 to 20/);
  bad([{ variationId: 'var-marg', quantity: 1.5 }], /Pick 1 to 20/);
  const soldOut = onlineMenu(catalog, [{ itemId: 'item-marg', published: true, soldOutOn: today }], modes, today);
  assert.throws(() => priceCart(soldOut, [{ variationId: 'var-marg', quantity: 1 }]), /sold out tonight/);
});

test('tips are whole cents, up to the order', () => {
  assert.equal(tipProblem(0, 1500), undefined);
  assert.equal(tipProblem(1500, 1500), undefined);
  assert.ok(tipProblem(1501, 1500));
  assert.ok(tipProblem(-1, 1500));
  assert.ok(tipProblem(2.5, 1500));
  assert.ok(tipProblem('300', 1500));
});

test('an option Square labels "not available online" can never be ordered, whatever is set', () => {
  const labelled: CatalogObject[] = [
    { type: 'CATEGORY', id: 'cat-pizza', category_data: { name: 'Pizza' } },
    { type: 'MODIFIER_LIST', id: 'ml-cook', modifier_list_data: { name: 'How would you like it cooked?', selection_type: 'SINGLE', modifiers: [
      { id: 'm-full', modifier_data: { name: 'FULLY COOKED & SLICED (NOT AVAILABLE ONLINE)', ordinal: 0 } },
      { id: 'm-part', modifier_data: { name: 'PARTIALLY COOKED (ONLY OPTION ONLINE)', ordinal: 1 } },
    ] } },
    { type: 'ITEM', id: 'item-apricot', item_data: { name: 'Apricot', reporting_category: { id: 'cat-pizza' }, variations: [{ id: 'var-apricot', item_variation_data: { name: 'Regular', price_money: { amount: 2000 } } }],
      modifier_list_info: [{ modifier_list_id: 'ml-cook', min_selected_modifiers: 1, max_selected_modifiers: 1 }] } },
  ];
  // Nothing set by a manager: partially cooked goes on by itself.
  const fresh = onlineMenu(labelled, [{ itemId: 'item-apricot', published: true }], {}, today);
  assert.deepEqual(priceCart(fresh, [{ variationId: 'var-apricot', quantity: 1 }]).lines[0]!.modifiers.map((m) => m.id), ['m-part']);
  assert.throws(() => priceCart(fresh, [{ variationId: 'var-apricot', quantity: 1, optionIds: ['m-full'] }]), CartError);
  // Even set to shown or always by mistake, fully cooked stays off the order.
  for (const mode of ['shown', 'always'] as const) {
    const wrong = onlineMenu(labelled, [{ itemId: 'item-apricot', published: true }], { 'm-full': mode, 'm-part': 'shown' }, today);
    assert.throws(() => priceCart(wrong, [{ variationId: 'var-apricot', quantity: 1, optionIds: ['m-full'] }]), CartError);
    assert.ok(publicMenu(wrong)[0]!.optionLists.every((l) => l.options.every((o) => o.id !== 'm-full')));
  }
});
