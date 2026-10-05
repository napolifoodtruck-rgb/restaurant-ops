import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLinks,
  confirmLink,
  describeQuestion,
  emptyLinkState,
  linkLookup,
  linkStatus,
  markNewDish,
  matchMenu,
  nameKey,
  nameSimilarity,
  posName,
  type SoldItem,
} from '../src/core/menuLinks.ts';
import type { Recipe } from '../src/core/recipes.ts';

const dish = (id: string, name: string): Recipe => ({ id, name, kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: [] });
const prep = (id: string, name: string): Recipe => ({ id, name, kind: 'prep', yield: { amount: 1, unit: 'qt' }, ingredients: [] });

// Names as they were typed into the recipe cards, which rarely match the POS.
const recipes: Recipe[] = [
  dish('margherita', 'Margherita'),
  dish('buffalo', 'Buffalo Margherita'),
  dish('marinara-pizza', 'Marinara pizza'),
  dish('spinachi', 'Spinachi Pizza'),
  dish('meatball-app', 'meatball app'),
  dish('merguez', 'Merguez'),
  dish('side-focaccia', 'side focaccia'),
  prep('marinara-sauce', 'Marinara Sauce'),
  prep('meatballs', 'meatballs'),
  prep('focaccia', 'focaccia'),
  prep('corn-panna', 'Corn Panna'),
];

const sold = (catalogId: string, itemName: string, netSales: number, extra: Partial<SoldItem> = {}): SoldItem => ({ catalogId, itemName, netSales, quantity: netSales / 15, ...extra });

test('names compare on what matters', () => {
  assert.equal(nameKey('Marinara pizza'), 'marinara');
  assert.equal(nameKey('Special: Heirloom'), nameKey('Heirloom'));
  assert.equal(nameKey('Meatballs'), 'meatball');
  assert.equal(nameKey('Olives & Focaccia'), 'olive focaccia');
  assert.equal(posName({ itemName: 'Add A Side', variationName: 'Focaccia' }), 'Add A Side (Focaccia)');
  assert.equal(posName({ itemName: 'Margherita', variationName: 'Regular' }), 'Margherita');
  assert.ok(nameSimilarity('Bufala Margherita', 'Buffalo Margherita') > nameSimilarity('Bufala Margherita', 'Margherita'));
  assert.ok(nameSimilarity('Spinaci', 'Spinachi Pizza') >= 0.75);
  assert.equal(nameSimilarity('Meatballs Pomodoro', 'meatball app'), 0.7);
  assert.equal(nameSimilarity('Olives & Focaccia', 'side focaccia'), 0.7); // a guess to confirm, not a match
  assert.ok(nameSimilarity('Calabria', 'Margherita') < 0.3);
});

test('exact names link on their own; the rest become questions, best sellers first', () => {
  const items = [
    sold('V-MARG', 'Margherita', 29000),
    sold('V-MARG-SHIFT', 'Margherita Shift', 0, { staffMeal: true, price: 0 }),
    sold('V-MARINARA', 'Marinara', 3100),
    sold('V-BUFALA', 'Bufala Margherita', 13700),
    sold('V-SPINACI', 'Spinaci', 1800),
    sold('V-MEATBALLS', 'Meatballs Pomodoro', 8200),
    sold('V-SIDE-FOC', 'Add A Side', 470, { variationName: 'Focaccia' }),
    sold('V-CORN', 'Corn Panna', 4400),
    sold('V-CALABRIA', 'Calabria', 18000),
  ];
  const { newLinks, questions } = matchMenu(items, recipes, emptyLinkState());

  assert.deepEqual(newLinks.map((l) => [l.catalogId, l.recipeId, l.matchedBy]), [
    ['V-MARG', 'margherita', 'name'],
    ['V-MARG-SHIFT', 'margherita', 'name'], // the staff meal uses the same recipe
    ['V-MARINARA', 'marinara-pizza', 'name'], // not the marinara sauce prep
    ['V-SIDE-FOC', 'side-focaccia', 'name'], // a dish wins over the focaccia prep
  ]);

  assert.deepEqual(questions.map((q) => [q.posName, q.type, q.candidates[0]?.recipeId]), [
    ['Calabria', 'choose', undefined],
    ['Bufala Margherita', 'confirm', 'buffalo'],
    ['Meatballs Pomodoro', 'confirm', 'meatball-app'],
    ['Corn Panna', 'confirm', 'corn-panna'], // same name as a prep, so it asks
    ['Spinaci', 'confirm', 'spinachi'],
  ]);
  assert.equal(describeQuestion(questions[1]!), 'Is "Bufala Margherita" the Buffalo Margherita recipe? (or Margherita)');
  assert.equal(describeQuestion(questions[3]!), '"Corn Panna" only matches the Corn Panna prep recipe. Is it sold as is, or does it need its own card?');
  assert.equal(describeQuestion(questions[0]!), 'No recipe for "Calabria" yet.');
});

test('a rename keeps the link by id and asks once whether it is the same dish', () => {
  // Square kept the id when Merguez was renamed; both names show up in the sales.
  const items = [sold('V-LAMB', 'Katahdin Pizza', 5300), sold('V-LAMB', 'Merguez', 3400)];
  const { newLinks, questions } = matchMenu(items, recipes, emptyLinkState());
  assert.deepEqual(newLinks.map((l) => l.posName), ['Merguez']);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.type, 'renamed');
  assert.equal(describeQuestion(questions[0]!), '"Merguez" now sells as "Katahdin Pizza". Same recipe?');

  // Until answered, sales under the new name don't count against the old recipe.
  let state = applyLinks(emptyLinkState(), newLinks);
  const lookup = linkLookup(state);
  assert.deepEqual(lookup('V-LAMB', 'Merguez'), { recipeId: 'merguez', portion: undefined });
  assert.equal(lookup('V-LAMB', 'Katahdin Pizza'), undefined);

  // The chef says it's a new dish with no card yet: the old name keeps its recipe.
  state = confirmLink(state, { catalogId: 'V-LAMB', itemName: 'Katahdin Pizza' }, null);
  assert.equal(linkStatus(state, 'V-LAMB', 'Katahdin Pizza').status, 'linked');
  assert.equal(linkLookup(state)('V-LAMB', 'Katahdin Pizza'), undefined);
  assert.equal(linkLookup(state)('V-LAMB', 'Merguez')?.recipeId, 'merguez');
  assert.equal(matchMenu(items, recipes, state).questions.length, 0);
});

test('a new dish on a reused id waits for its card, then links on its own', () => {
  const items = [sold('V-LAMB', 'Merguez', 3400), sold('V-LAMB', 'Katahdin Pizza', 5300)];
  let state = applyLinks(emptyLinkState(), matchMenu(items, recipes, emptyLinkState()).newLinks);
  state = markNewDish(state, { catalogId: 'V-LAMB', itemName: 'Katahdin Pizza' });
  // No more questions, and its sales count as missing a recipe.
  assert.equal(matchMenu(items, recipes, state).questions.length, 0);
  assert.equal(linkLookup(state)('V-LAMB', 'Katahdin Pizza'), undefined);

  // The card arrives.
  const withCard = [...recipes, dish('katahdin', 'Katahdin')];
  const { newLinks } = matchMenu(items, withCard, state);
  assert.deepEqual(newLinks.map((l) => [l.posName, l.recipeId]), [['Katahdin Pizza', 'katahdin']]);
  state = applyLinks(state, newLinks);
  assert.equal(linkLookup(state)('V-LAMB', 'Katahdin Pizza')?.recipeId, 'katahdin');
  assert.equal(linkLookup(state)('V-LAMB', 'Merguez')?.recipeId, 'merguez');
  assert.equal(state.links.filter((l) => l.catalogId === 'V-LAMB').length, 2);
});

test('a rename that only adds "Special:" is the same dish', () => {
  const state = applyLinks(emptyLinkState(), [{ catalogId: 'V-H', posName: 'Heirloom', recipeId: 'heirloom', matchedBy: 'manager' }]);
  assert.equal(linkStatus(state, 'V-H', 'Special: Heirloom').status, 'linked');
});

test('answers become aliases, so the same name links elsewhere without asking', () => {
  let state = emptyLinkState();
  state = confirmLink(state, { catalogId: 'V-BUFALA', itemName: 'Bufala Margherita' }, 'buffalo');
  // A second location, or a new button, with the same name.
  const { newLinks, questions } = matchMenu([sold('V-BUFALA-2', 'Bufala Margherita', 500)], recipes, state);
  assert.deepEqual(newLinks.map((l) => [l.catalogId, l.recipeId, l.matchedBy]), [['V-BUFALA-2', 'buffalo', 'alias']]);
  assert.equal(questions.length, 0);
});

test('a side of a prep links with its portion', () => {
  const state = confirmLink(emptyLinkState(), { catalogId: 'V-SIDE-SAUCE', itemName: 'Add A Side', variationName: 'San Marzano Tomato Sauce' }, 'marinara-sauce', { amount: 2, unit: 'oz' });
  assert.deepEqual(linkLookup(state)('V-SIDE-SAUCE', 'Add A Side (San Marzano Tomato Sauce)'), { recipeId: 'marinara-sauce', portion: { amount: 2, unit: 'oz' } });
});
