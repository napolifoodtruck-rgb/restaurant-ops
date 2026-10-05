import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyModifierAnswers, modifierCosts, modifierKey, readModifier, resolveModifier, usualPortion, type ModifierSaleLine } from '../src/core/modifiers.ts';
import { menuMargins } from '../src/core/margins.ts';
import { RecipeBook, type Product, type Recipe } from '../src/core/recipes.ts';
import { squareModifierSales } from '../src/connectors/square.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const products: Product[] = [
  { id: 'dough', name: 'Pizza dough ball', baseUnit: 'each', cost: { price: 0.4, per: { amount: 1, unit: 'each' } } },
  { id: 'gf-crust', name: 'Pizza Crust, Gluten Free', baseUnit: 'each', cost: { price: 3, per: { amount: 1, unit: 'each' } } },
  { id: 'mozz', name: 'Cheese, Mozzarella', baseUnit: 'lb', cost: { price: 6, per: { amount: 1, unit: 'lb' } } },
  { id: 'bufala', name: 'Cheese, Mozzarella Buffalo', baseUnit: 'lb', cost: { price: 16, per: { amount: 1, unit: 'lb' } } },
  { id: 'chorizo', name: 'Sausage, Chorizo', baseUnit: 'lb', cost: { price: 12, per: { amount: 1, unit: 'lb' } } },
  { id: 'sopressata', name: 'Sopressata', baseUnit: 'lb', cost: { price: 16, per: { amount: 1, unit: 'lb' } } },
  { id: 'basil', name: 'Basil, Fresh', baseUnit: 'g', cost: { price: 0.02, per: { amount: 1, unit: 'g' } } },
  { id: 'olives', name: 'Olives, Nicoise', baseUnit: 'lb', cost: { price: 10, per: { amount: 1, unit: 'lb' } } },
  { id: 'oil', name: 'Oil, Olive Extra Virgin', baseUnit: 'l', cost: { price: 8, per: { amount: 1, unit: 'l' } } },
  { id: 'garlic', name: 'Garlic, Peeled', baseUnit: 'g', cost: { price: 0.01, per: { amount: 1, unit: 'g' } } },
  { id: 'pepperoni', name: 'Pepperoni, Sliced', baseUnit: 'lb', cost: { price: 8, per: { amount: 1, unit: 'lb' } } },
];
const p = (id: string, amount: number, unit: string) => ({ item: { kind: 'product' as const, id }, quantity: { amount, unit } });
const dish = (id: string, name: string, ...ingredients: ReturnType<typeof p>[]): Recipe => ({ id, name, kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients });
const recipes: Recipe[] = [
  dish('margherita', 'Margherita', p('dough', 1, 'each'), p('mozz', 3, 'oz'), p('basil', 5, 'g')), // 0.40 + 1.125 + 0.10
  dish('pepperoni', 'Pepperoni', p('dough', 1, 'each'), p('mozz', 3, 'oz'), p('pepperoni', 3, 'oz')),
  dish('apricot', 'Apricot', p('dough', 1, 'each'), p('mozz', 1.75, 'oz'), p('sopressata', 1.25, 'oz')),
  dish('calabria', 'Calabria', p('dough', 1, 'each'), p('mozz', 3, 'oz'), p('chorizo', 0.8, 'oz')),
  dish('greca', 'Greca', p('dough', 1, 'each'), p('oil', 0.25, 'floz'), p('olives', 1, 'oz'), p('garlic', 5, 'g'), p('basil', 3, 'g')),
];
const book = new RecipeBook(products, recipes);
const mod = (name: string, listName?: string, price?: number) => ({ name, ...(listName ? { listName } : {}), ...(price !== undefined ? { price } : {}) });

test('the wording says what a modifier does', () => {
  assert.deepEqual(readModifier(mod('++ Extra Mozzarella')), { action: 'add', adds: 'Mozzarella', extra: true });
  assert.deepEqual(readModifier(mod('-- No Chorizo')), { action: 'remove', removes: 'Chorizo' });
  assert.deepEqual(readModifier(mod('--No Honey')), { action: 'remove', removes: 'Honey' });
  assert.deepEqual(readModifier(mod('** Sub Buffalo Mozzarella')), { action: 'swap', adds: 'Buffalo Mozzarella' });
  assert.deepEqual(readModifier(mod('-No Focaccia; Sub Gluten Free')), { action: 'swap', adds: 'Gluten Free', removes: 'Focaccia' });
  assert.deepEqual(readModifier(mod('-Extra Side Focaccia')), { action: 'add', adds: 'Side Focaccia', extra: true });
  assert.deepEqual(readModifier(mod('++ Fresh Basil Cooked on Pizza')), { action: 'add', adds: 'Fresh Basil' });
  assert.equal(readModifier(mod('** Dressing OTS')).action, 'none');
  assert.equal(readModifier(mod('FULLY COOKED & SLICED (NOT AVAILABLE ONLINE)', 'How would you like it cooked?')).action, 'none');
  assert.equal(readModifier(mod('This App With Pizza', 'With Pizza?')).action, 'none');
  assert.equal(readModifier(mod('2 spoons', 'Spoons')).action, 'none');
  assert.equal(readModifier(mod('Gluten Sensitive Crust', 'Gluten Sensitive Crust?')).action, 'ask');
  assert.equal(modifierKey(mod('-- No Chorizo', 'Calabria')), 'calabria|no chorizo');
});

test('an add-on portion is proposed from the dishes that use it', () => {
  // Pepperoni is 3 oz on the Pepperoni pizza, so a pepperoni add-on is proposed at 3 oz.
  assert.deepEqual(usualPortion(book, { kind: 'product', id: 'mozz' }), { amount: 3, unit: 'oz' });
  const r = resolveModifier(book, 'margherita', mod('++ Pepperoni', 'Toppings', 2), emptyModifierAnswers());
  assert.ok('question' in r);
  assert.equal(r.question.type, 'portion');
  assert.deepEqual(r.question.proposal, [p('pepperoni', 3, 'oz')]);
});

test('"extra" is half again the dish\'s own portion', () => {
  const extra = mod('++ Extra Mozzarella', 'Toppings', 2);
  const q = resolveModifier(book, 'margherita', extra, emptyModifierAnswers());
  assert.ok('question' in q);
  assert.deepEqual(q.question.proposal, [{ item: { kind: 'product', id: 'mozz' }, share: 0.5 }]);

  const answers = { ...emptyModifierAnswers(), adds: { [modifierKey(extra)]: [{ item: { kind: 'product' as const, id: 'mozz' }, share: 0.5 }] } };
  const on = (dishId: string) => {
    const r = resolveModifier(book, dishId, extra, answers);
    assert.ok('resolved' in r);
    return r.resolved.adds;
  };
  assert.deepEqual(on('margherita'), [p('mozz', 1.5, 'oz')]); // 3 oz on the dish
  assert.deepEqual(on('apricot'), [p('mozz', 0.875, 'oz')]); // 1.75 oz on the dish
  assert.deepEqual(on('greca'), [p('mozz', 1.5, 'oz')]); // none on the dish: half the usual 3 oz
});

test('names match on what the ingredient is, not how it is bought', () => {
  const proposal = (name: string) => {
    const r = resolveModifier(book, 'pepperoni', mod(name, 'Toppings', 2), emptyModifierAnswers());
    return 'question' in r ? r.question.proposal : undefined;
  };
  assert.deepEqual(proposal('++ Olives'), [p('olives', 1, 'oz')]); // not olive oil
  assert.deepEqual(proposal('++ Fresh Garlic'), [p('garlic', 5, 'g')]); // not "Basil, Fresh"
});

test('"no X" takes off the dish\'s own line, and asks when the name doesn\'t say which', () => {
  const r = resolveModifier(book, 'calabria', mod('-- No Chorizo', 'Calabria'), emptyModifierAnswers());
  assert.ok('resolved' in r);
  assert.deepEqual(r.resolved.removes, [p('chorizo', 0.8, 'oz')]);

  // The Apricot is made with soppressata; the button says salami.
  const q = resolveModifier(book, 'apricot', mod('-- No Salami', 'Apricot'), emptyModifierAnswers());
  assert.ok('question' in q);
  assert.equal(q.question.type, 'which');
  assert.equal(q.question.dishName, 'Apricot');
  assert.equal(q.question.choices?.length, 3);
  const answers = { ...emptyModifierAnswers(), removes: { 'apricot|apricot|no salami': { kind: 'product' as const, id: 'sopressata' } } };
  const a = resolveModifier(book, 'apricot', mod('-- No Salami', 'Apricot'), answers);
  assert.ok('resolved' in a);
  assert.deepEqual(a.resolved.removes, [p('sopressata', 1.25, 'oz')]);
});

test('a free add of something the dish has is the dish as written', () => {
  const r = resolveModifier(book, 'margherita', mod('++ Fresh Basil Cooked on Pizza', 'Basil', 0), emptyModifierAnswers());
  assert.deepEqual(r, { resolved: { adds: [], removes: [] } });
  // On a pizza without basil it is an add-on, free or not.
  const q = resolveModifier(book, 'pepperoni', mod('++ Fresh Basil Cooked on Pizza', 'Basil', 0), emptyModifierAnswers());
  assert.ok('question' in q && q.question.type === 'portion');
});

test('a swap takes off the closest thing on the dish', () => {
  const answers = { ...emptyModifierAnswers(), adds: { 'topping|sub buffalo mozzarella': [p('bufala', 3, 'oz')] } };
  const r = resolveModifier(book, 'pepperoni', mod('** Sub Buffalo Mozzarella', 'Toppings', 3), answers);
  assert.ok('resolved' in r);
  assert.deepEqual(r.resolved.adds, [p('bufala', 3, 'oz')]);
  assert.deepEqual(r.resolved.removes, [p('mozz', 3, 'oz')]);
});

test('modifier costs add up per dish and feed the margins', () => {
  const gf = mod('Gluten Sensitive Crust', 'Gluten Sensitive Crust?', 4);
  const sales: ModifierSaleLine[] = [
    { catalogId: 'V-MARG', itemName: 'Margherita', modifier: mod('++ Extra Mozzarella', 'Toppings', 2), quantity: 10, sales: 20 },
    { catalogId: 'V-MARG', itemName: 'Margherita', modifier: gf, quantity: 5, sales: 20 },
    { catalogId: 'V-CAL', itemName: 'Calabria', modifier: mod('-- No Chorizo', 'Calabria'), quantity: 4, sales: 0 },
    { catalogId: 'V-CAL', itemName: 'Calabria', modifier: gf, quantity: 2, sales: 8 },
    { catalogId: 'V-MARG', itemName: 'Margherita', modifier: mod('FULLY COOKED & SLICED', 'How would you like it cooked?'), quantity: 90, sales: 0 },
  ];
  const dishFor = (id: string) => ({ 'V-MARG': 'margherita', 'V-CAL': 'calabria' })[id];

  // Nothing answered yet, asking about everything: the add-on and the crust are questions, most used first.
  const asking = modifierCosts(book, sales, dishFor, emptyModifierAnswers(), { assumeUsualPortions: false });
  assert.deepEqual(asking.questions.map((q) => [q.modifier.name, q.type, q.uses]), [
    ['++ Extra Mozzarella', 'portion', 10],
    ['Gluten Sensitive Crust', 'what', 7],
  ]);
  // By default the add-on portion is taken from the dishes and listed for review; only the crust is asked.
  const before = modifierCosts(book, sales, dishFor, emptyModifierAnswers());
  assert.deepEqual(before.questions.map((q) => q.modifier.name), ['Gluten Sensitive Crust']);
  assert.deepEqual(before.assumed.map((a) => [a.modifier.name, a.uses, a.proposal]), [['++ Extra Mozzarella', 10, [{ item: { kind: 'product', id: 'mozz' }, share: 0.5 }]]]);
  close(before.byItem.get('V-MARG|margherita'), 10 * 0.5625);
  close(before.byItem.get('V-CAL|calabria'), -4 * (0.8 / 16) * 12); // no chorizo saves $0.60 a plate

  // Answered: extra mozzarella is 3 oz; the gluten-free crust replaces the dough.
  const answers = {
    adds: { [modifierKey(mod('++ Extra Mozzarella', 'Toppings'))]: [{ item: { kind: 'product' as const, id: 'mozz' }, share: 0.5 }], [modifierKey(gf)]: [p('gf-crust', 1, 'each')] },
    removes: { '*|gluten sensitive crust|gluten sensitive crust': { kind: 'product' as const, id: 'dough' } },
  };
  const after = modifierCosts(book, sales, dishFor, answers);
  assert.equal(after.questions.length, 0);
  // Waiting on a recipe: not costed and not asked again.
  const waiting = modifierCosts(book, sales, dishFor, { ...emptyModifierAnswers(), waiting: { [modifierKey(gf)]: 'card not in yet' } });
  assert.deepEqual(waiting.questions.map((q) => q.modifier.name), []);
  assert.equal(waiting.modifiers.find((m) => m.key === modifierKey(gf))?.complete, false);
  // Margherita: 10 × 1.5 oz mozzarella ($0.5625) + 5 × (crust $3 − dough $0.40).
  close(after.byItem.get('V-MARG|margherita'), 10 * 0.5625 + 5 * 2.6);
  close(after.byItem.get('V-CAL|calabria'), -4 * 0.6 + 2 * 2.6);
  close(after.usage.products.get('dough'), -7);
  const crust = after.modifiers.find((m) => m.key === modifierKey(gf))!;
  assert.equal(crust.uses, 7);
  close(crust.cost, 7 * 2.6); // $4 upcharge against $2.60 of extra cost

  const report = menuMargins(
    book,
    (id) => (dishFor(id) ? { recipeId: dishFor(id)! } : undefined),
    [{ catalogId: 'V-MARG', name: 'Margherita', quantity: 100, netSales: 1540, category: 'Pizza', listPrice: 15 }],
    { modifierCosts: after.byItem },
  );
  const marg = report.dishes[0]!;
  close(marg.modifierCost, (10 * 0.5625 + 5 * 2.6) / 100);
  close(marg.plateCost, 1.625 + marg.modifierCost);
  close(marg.contribution, 15.4 - marg.plateCost);
});

test('reads Square modifier sales', () => {
  const lines = squareModifierSales([
    { 'ItemSales.item_variation_id': 'V-MARG', 'ItemSales.item_name': 'Margherita', 'ItemSales.modifier_name': '++ Extra Mozzarella', 'ItemSales.modifier_list_name': 'Toppings Meat & Cheese', 'ItemSales.modifier_net_quantity': 99.000000001, 'ItemSales.gross_sales': 198 },
    { 'ItemSales.item_variation_id': 'V-MARG', 'ItemSales.item_name': 'Margherita', 'ItemSales.modifier_name': '++ Spinach', 'ItemSales.modifier_list_name': null, 'ItemSales.modifier_net_quantity': 25, 'ItemSales.gross_sales': 50 },
    { 'ItemSales.item_variation_id': 'V-MARG', 'ItemSales.item_name': 'Margherita', 'ItemSales.modifier_net_quantity': 0, 'ItemSales.gross_sales': 0 },
  ]);
  assert.deepEqual(lines, [
    { catalogId: 'V-MARG', itemName: 'Margherita', quantity: 99, sales: 198, modifier: { name: '++ Extra Mozzarella', listName: 'Toppings Meat & Cheese', price: 2 } },
    { catalogId: 'V-MARG', itemName: 'Margherita', quantity: 25, sales: 50, modifier: { name: '++ Spinach', price: 2 } },
  ]);
});
