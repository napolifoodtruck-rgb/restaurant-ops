import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToMenu, entriesFromSales, menuChecks, MenuError, onMenu, switchVersion, takeOffMenu, type DatedModifierLine, type MenuEntry } from '../src/core/menu.ts';
import { confirmLink, emptyLinkState, linkLookup } from '../src/core/menuLinks.ts';
import { sellingSpans, type SaleLine } from '../src/core/sales.ts';
import { addDays } from '../src/core/forecast.ts';

const names: Record<string, string> = { margherita: 'Margherita', 'ricotta-summer': 'Ricotta, summer', 'ricotta-fall': 'Ricotta, fall', heirloom: 'Heirloom', calabria: 'Calabria' };
const recipeName = (id: string) => names[id] ?? id;
const ricottaButton = { catalogId: 'V-RICOTTA', itemName: 'Ricotta Appetizer' };

/** Daily sales from `from` to `to`, skipping Sundays and Mondays like a restaurant closed those days. */
function daily(catalogId: string, name: string, from: string, to: string, perDay: number, price: number): SaleLine[] {
  const out: SaleLine[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 1) continue;
    out.push({ catalogId, name, date: d, quantity: perDay, netSales: perDay * price });
  }
  return out;
}

test('the menu on a day, adding and taking off', () => {
  let entries: MenuEntry[] = [];
  entries = addToMenu(entries, { id: 'm1', menuId: 'dinner', recipeId: 'margherita', name: 'Margherita', startsOn: '2026-01-01' });
  entries = addToMenu(entries, { id: 'h1', menuId: 'dinner', recipeId: 'heirloom', name: 'Heirloom', startsOn: '2026-07-01' });
  assert.deepEqual(onMenu(entries, '2026-06-01').map((e) => e.name), ['Margherita']);
  assert.throws(() => addToMenu(entries, { menuId: 'dinner', recipeId: 'margherita', name: 'Margherita', startsOn: '2026-05-01' }), MenuError);
  entries = takeOffMenu(entries, 'h1', '2026-09-20');
  assert.deepEqual(onMenu(entries, '2026-09-21').map((e) => e.name), ['Margherita']);
  assert.throws(() => takeOffMenu(entries, 'h1', '2026-06-01'), MenuError);
  // Back on next summer: a new entry, no overlap with the first.
  entries = addToMenu(entries, { menuId: 'dinner', recipeId: 'heirloom', name: 'Heirloom', startsOn: '2027-06-15' });
  assert.equal(entries.length, 3);
});

test('a seasonal switch ends one version, starts the next and moves the Square button', () => {
  let entries = addToMenu([], { id: 'r1', menuId: 'dinner', recipeId: 'ricotta-summer', name: 'Ricotta, summer', section: 'Apps', startsOn: '2026-05-26' });
  let links = confirmLink(emptyLinkState(), ricottaButton, 'ricotta-summer');
  ({ entries, links } = switchVersion(entries, links, { menuId: 'dinner', button: ricottaButton, fromEntryId: 'r1', toName: 'Ricotta, fall', firstDay: '2026-08-18' }));
  assert.equal(entries.find((e) => e.id === 'r1')?.endsOn, '2026-08-17');
  const fall = onMenu(entries, '2026-10-01');
  assert.deepEqual(fall.map((e) => [e.name, e.recipeId, e.section]), [['Ricotta, fall', undefined, 'Apps']]); // card to come
  const lookup = linkLookup(links);
  assert.equal(lookup('V-RICOTTA', 'Ricotta Appetizer', '2026-08-15')?.recipeId, 'ricotta-summer');
  assert.equal(lookup('V-RICOTTA', 'Ricotta Appetizer', '2026-08-20'), undefined); // waiting for the card
  assert.throws(() => switchVersion(entries, links, { menuId: 'dinner', button: ricottaButton, fromEntryId: 'r1', toName: 'x', firstDay: '2026-05-01' }), MenuError);
});

test('menu entries proposed from the first and last day each dish sold', () => {
  const links = confirmLink(confirmLink(emptyLinkState(), { catalogId: 'V-MARG', itemName: 'Margherita' }, 'margherita'), { catalogId: 'V-HEIR', itemName: 'Heirloom' }, 'heirloom');
  const sales = [...daily('V-MARG', 'Margherita', '2026-06-02', '2026-10-03', 20, 15), ...daily('V-HEIR', 'Heirloom', '2026-07-07', '2026-09-19', 5, 18)];
  const entries = entriesFromSales(sellingSpans(sales), linkLookup(links), recipeName, 'dinner', '2026-10-04');
  assert.deepEqual(entries.map((e) => [e.name, e.startsOn, e.endsOn, e.datesFrom]).sort(), [
    ['Heirloom', '2026-07-07', '2026-09-19', 'sales'],
    ['Margherita', '2026-06-02', undefined, 'sales'], // still selling: no end
  ]);
});

test('mismatches between Square, sales and the menu become to-do items', () => {
  const today = '2026-10-04';
  let links = confirmLink(emptyLinkState(), { catalogId: 'V-MARG', itemName: 'Margherita' }, 'margherita');
  links = confirmLink(links, { catalogId: 'V-HEIR', itemName: 'Heirloom' }, 'heirloom');
  links = confirmLink(links, { catalogId: 'V-CAL', itemName: 'Calabria' }, 'calabria');
  const entries: MenuEntry[] = [
    { id: 'm1', menuId: 'dinner', recipeId: 'margherita', name: 'Margherita', startsOn: '2026-01-01', datesFrom: 'manager' },
    { id: 'h1', menuId: 'dinner', recipeId: 'heirloom', name: 'Heirloom', startsOn: '2026-07-01', datesFrom: 'manager' }, // stopped selling
    { id: 'c1', menuId: 'dinner', recipeId: 'calabria', name: 'Calabria', startsOn: '2026-01-01', endsOn: '2026-09-15', datesFrom: 'manager' }, // marked off
  ];
  const sales = [
    ...daily('V-MARG', 'Margherita', '2026-09-01', '2026-10-03', 20, 15),
    ...daily('V-HEIR', 'Heirloom', '2026-09-01', '2026-09-19', 5, 18),
    ...daily('V-CAL', 'Calabria', '2026-09-23', '2026-10-03', 10, 20), // still selling after coming off
    ...daily('V-NEW', 'Katahdin Pizza', '2026-09-26', '2026-10-03', 6, 20), // a new button
    ...daily('V-OLD', 'Shift Pizza', '2026-06-01', '2026-10-03', 1, 0), // old $0 button: not new, no sales value
  ];
  const checks = menuChecks({ entries, sales, lookup: linkLookup(links), recipeName, today });
  assert.deepEqual(checks.map((c) => [c.kind, c.title]), [
    ['soldOffMenu', "Calabria sold 90 times since 2026-09-23 but isn't on the menu. Put it on, or was it a special?"],
    ['newButton', '"Katahdin Pizza" started selling on 2026-09-26. Add it to the menu?'],
    ['notSelling', "Heirloom is on the menu but hasn't sold since 2026-09-19. Still on?"],
  ]);
  assert.equal(checks[0]!.netSales, 1800);
});

test("a dish's own modifier buttons changing suggests a new version", () => {
  const today = '2026-10-04';
  const links = confirmLink(emptyLinkState(), ricottaButton, 'ricotta-summer');
  const entries: MenuEntry[] = [{ id: 'r1', menuId: 'dinner', recipeId: 'ricotta-summer', name: 'Ricotta, summer', startsOn: '2026-05-26', datesFrom: 'manager' }];
  const sales = daily('V-RICOTTA', 'Ricotta Appetizer', '2026-06-02', '2026-10-03', 15, 12);
  const mod = (modifierName: string, listName: string, date: string, catalogId = 'V-RICOTTA'): DatedModifierLine => ({ catalogId, modifierName, listName, date, quantity: 1 });
  const modifiers = [
    ...['2026-06-23', '2026-07-08', '2026-07-25', '2026-08-13', '2026-08-14'].map((d) => mod('-- No Pistachio', 'Ricotta Appetizer', d)),
    ...['2026-08-20', '2026-08-28', '2026-09-11', '2026-10-02'].map((d) => mod('-- No Tomato Jam', 'Ricotta Appetizer', d)),
    // A shared list says nothing about one dish.
    mod('++ Add Prosciutto', 'Toppings', '2026-07-01'),
    mod('++ Add Prosciutto', 'Toppings', '2026-07-02', 'V-MARG'),
  ];
  const checks = menuChecks({ entries, sales, modifiers, lookup: linkLookup(links), recipeName, today });
  const changed = checks.filter((c) => c.kind === 'dishChanged');
  assert.equal(changed.length, 1);
  // It sold on Sat 15, Tue 18, Wed 19, Thu 20 in between; closed Sunday and Monday, so the
  // likeliest change is the Tuesday after the weekend.
  assert.equal(changed[0]!.suggestedDate, '2026-08-18');
  assert.match(changed[0]!.title, /"-- No Pistachio" was last used 2026-08-14 and "-- No Tomato Jam" first used 2026-08-20/);
});
