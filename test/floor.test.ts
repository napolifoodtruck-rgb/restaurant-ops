import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allergensOf, allergyLine, cardLines, spokenName, usesRecipe } from '../src/core/allergens.ts';
import { wineBase } from '../src/server/floor.ts';
import { clock, forTables, mergeBooks, notesAndTags, readOpenTableCsv, tablesOf, whyNotable } from '../src/core/reservations.ts';
import type { Recipe } from '../src/core/recipes.ts';

const recipe = (id: string, lines: [kind: 'product' | 'recipe', id: string][]): Recipe => ({
  id, name: id, kind: 'dish', yield: { amount: 1, unit: 'each' }, ingredients: lines.map(([kind, i]) => ({ item: { kind, id: i }, quantity: { amount: 1, unit: 'each' } })),
});

test('allergens come up through every recipe; unchecked ingredients are named, never safe', () => {
  const recipes = new Map([
    ['dough', recipe('dough', [['product', 'flour'], ['product', 'free-water'], ['product', 'salt']])],
    ['pesto', recipe('pesto', [['product', 'basil'], ['product', 'pine'], ['product', 'parm'], ['product', 'garlic']])],
    ['pizza', recipe('pizza', [['recipe', 'dough'], ['recipe', 'pesto'], ['product', 'mozz'], ['product', 'unmatched:mystery sauce']])],
  ]);
  const tags: Record<string, string[]> = { flour: ['wheat'], salt: [], pine: ['treenut'], parm: ['milk'], garlic: ['allium'], mozz: ['milk'] };
  const names: Record<string, string> = { flour: 'Flour, 00', salt: 'Salt', basil: 'Basil, Fresh', pine: 'Pine Nuts', parm: 'Parmigiano', garlic: 'Garlic', mozz: 'Cheese, Mozzarella' };
  const info = allergensOf('pizza', { recipes, tagsOf: (id) => tags[id], nameOf: (id) => names[id] ?? id });
  assert.deepEqual(info.contains.map((c) => [c.label, c.from]), [['Dairy', ['Cheese, Mozzarella', 'Parmigiano']], ['Gluten', ['Flour, 00']], ['Tree nut', ['Pine Nuts']], ['Allium', ['Garlic']]]);
  assert.deepEqual(info.unchecked, ['Basil, Fresh']);
  assert.deepEqual(info.unknown, ['mystery sauce']);
  assert.equal(allergyLine(info), 'Dairy, Gluten, Tree nut, Allium');
  // A loop between recipes doesn't hang.
  recipes.set('dough', recipe('dough', [['recipe', 'pizza']]));
  assert.ok(allergensOf('pizza', { recipes, tagsOf: (id) => tags[id], nameOf: (id) => id }));
});

test('a swap the kitchen offers answers the dish both ways', () => {
  const recipes = new Map([
    ['dough', recipe('dough', [['product', 'flour']])],
    ['gs-dough', recipe('gs-dough', [['product', 'gs-flour']])],
    ['base', recipe('base', [['recipe', 'dough'], ['product', 'garlic']])],
    ['pizza', recipe('pizza', [['recipe', 'base'], ['product', 'mozz']])],
    ['salad', recipe('salad', [['product', 'mozz']])],
  ]);
  const tags: Record<string, string[]> = { flour: ['wheat'], 'gs-flour': [], garlic: ['allium'], mozz: ['milk'] };
  const src = { recipes, tagsOf: (id: string) => tags[id], nameOf: (id: string) => id };
  assert.equal(allergyLine(allergensOf('pizza', src)), 'Dairy, Gluten, Allium');
  assert.equal(allergyLine(allergensOf('pizza', src, { from: 'dough', to: 'gs-dough' })), 'Dairy, Allium');
  assert.ok(usesRecipe('pizza', 'dough', recipes));
  assert.ok(!usesRecipe('salad', 'dough', recipes));
});

test('Square wine buttons come down to the wine', () => {
  assert.equal(wineBase('La Cassaccia Chardonnay DOC - BTL (50% OFF WINE WEDNESDAY)'), 'La Cassaccia Chardonnay DOC');
  assert.equal(wineBase('Tenuta degli Ultimi- Prosecco BTL'), wineBase('Tenuta degli Ultimi-Prosecco GLS'));
});

test('a menu card lists the dish’s own lines by the names servers say', () => {
  const pizza = recipe('pizza', [['recipe', 'sauce'], ['product', 'mozz'], ['product', 'salt'], ['product', 'free-water'], ['product', 'mozz2']]);
  const lines = cardLines(pizza, {
    product: (id) => (id === 'salt' ? { name: 'Salt', show: false } : { name: 'Fior di Latte', show: true }),
    recipe: () => 'Pomodoro Base',
  });
  assert.deepEqual(lines, ['Pomodoro Base', 'Fior di Latte']);
  assert.equal(spokenName('Cheese, Mozzarella'), 'Mozzarella Cheese');
  assert.equal(spokenName('Banana Pepper'), 'Banana Pepper');
});

const CSV = `"TIME","PARTY SIZE","GUEST","PHONE","TABLE","NOTES AND TAGS","PAYMENT STATUS","TABLE STATUS","MADE"
"5:15 pm","2","Pat Guest","(919) 555-0101","T5","SEATING PREFERENCES: Covered Patio Booked,   SPECIAL EVENTS: Birthday ",,"Confirmed by guest","10/5/26"
"6:30 pm","5","Sam Party","(919) 555-0102","T2+","SEATING PREFERENCES: Covered Patio Booked,  ",,"Booked","9/30/26"
"6:45 pm","2","Kris Example","(919) 555-0103","T37","GUEST REQUESTS: Birthday celebration for Mara SEATING PREFERENCES: Interior Dining Room Booked  SPECIAL EVENTS: Birthday ",,"Booked","10/6/26"
"7:00 pm","4","Lee Plain","(919) 555-0104","T33",,,"Booked, Reminder sent","10/5/26"
"8:00 pm","6","Chloe Friend","(919) 555-0105","T7+","SPECIAL RELATIONSHIP: Friend of Mira, CFM Manager SEATING PREFERENCES: Covered Patio Booked,  ",,"Confirmed by guest","10/5/26"
"8:30 pm","2","Gone Guest","(919) 555-0106","T31",,,"Cancelled","10/5/26"
`;

test('OpenTable CSV: times, tables, occasions, regulars; phones and cancellations left out', () => {
  assert.deepEqual([clock('5:15 pm'), clock('12:05 AM'), clock('19:30')], ['17:15', '00:05', '19:30']);
  assert.deepEqual(tablesOf('T37,T36'), { tables: ['T37', 'T36'], combined: true });
  assert.deepEqual(notesAndTags('SPECIAL RELATIONSHIP: Friend of Mira, CFM Manager SEATING PREFERENCES: Covered Patio Booked,  '), { occasions: [], vip: true, vipNote: 'Friend of Mira, CFM Manager' });
  const book = readOpenTableCsv(CSV);
  assert.equal(book.reservations.length, 5);
  assert.equal(book.covers, 19);
  assert.ok(!JSON.stringify(book).includes('555'));
  const [birthday, party, kris, plain, friend] = book.reservations;
  assert.deepEqual([birthday!.time, birthday!.tables, birthday!.occasions], ['17:15', ['T5'], ['Birthday']]);
  assert.deepEqual([party!.tables, party!.combined, whyNotable(party!)], [['T2'], true, ['party of 5']]);
  assert.deepEqual([kris!.requests, whyNotable(kris!)], ['Birthday celebration for Mara', ['birthday', 'request']]);
  assert.deepEqual(whyNotable(plain!), []);
  assert.deepEqual(whyNotable(friend!), ['regular', 'party of 6']);
  // The dining room's tables only, by time.
  assert.deepEqual(forTables(book, ['T31', 'T32', 'T33', 'T37']).map((r) => r.name), ['Kris Example', 'Lee Plain']);
  assert.throws(() => readOpenTableCsv('a,b\n1,2'), /OpenTable/);
});

test('a later report keeps what the digest knew about each guest', () => {
  const digest = { asOf: '2026-10-08T16:18:00Z', reservations: [
    { time: '17:00', partySize: 2, name: 'Lee Plain', tables: ['T31'], occasions: [], visitsLastYear: 12, lastVisit: '2026-09-09', spendPerCover: 54.56, notes: 'Window table if possible' },
    { time: '19:00', partySize: 2, name: 'Cancelled Since', tables: ['T5'], occasions: [] },
  ] };
  const csv = readOpenTableCsv(CSV);
  const merged = mergeBooks(digest, csv);
  const lee = merged.reservations.find((r) => r.name === 'Lee Plain')!;
  // Time and table from the later report, history and notes from the digest.
  assert.deepEqual([lee.time, lee.tables, lee.visitsLastYear, lee.notes, whyNotable(lee)], ['19:00', ['T33'], 12, 'Window table if possible', ['notes', 'often here']]);
  assert.ok(!merged.reservations.some((r) => r.name === 'Cancelled Since'));
});
