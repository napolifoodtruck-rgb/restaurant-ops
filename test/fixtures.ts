import { RecipeBook, type Product, type Recipe } from '../src/core/recipes.ts';
import type { MenuLinks } from '../src/core/sales.ts';

const product = (id: string) => ({ kind: 'product' as const, id });
const recipe = (id: string) => ({ kind: 'recipe' as const, id });

export const products: Product[] = [
  { id: 'garlic', name: 'Garlic', baseUnit: 'lb', cost: { price: 30, per: { amount: 5, unit: 'lb' } } }, // $6/lb
  { id: 'crushed-tomatoes', name: 'Crushed tomatoes #10 can', baseUnit: 'each', cost: { price: 6, per: { amount: 1, unit: 'each' } } },
  { id: 'cream', name: 'Heavy cream', baseUnit: 'qt', cost: { price: 5, per: { amount: 1, unit: 'qt' } } },
  { id: 'vodka', name: 'Vodka', baseUnit: 'l', cost: { price: 15, per: { amount: 1, unit: 'l' } } },
  { id: 'rigatoni', name: 'Rigatoni', baseUnit: 'lb', cost: { price: 20, per: { amount: 10, unit: 'lb' } } }, // $2/lb
  { id: 'parmesan', name: 'Parmesan', baseUnit: 'lb', cost: { price: 12, per: { amount: 1, unit: 'lb' } } },
  { id: 'chicken', name: 'Chicken breast', baseUnit: 'lb', cost: { price: 160, per: { amount: 40, unit: 'lb' } } }, // $4/lb
  { id: 'basil', name: 'Basil', baseUnit: 'oz' }, // no invoice yet, so no price
];

export const recipes: Recipe[] = [
  {
    id: 'chopped-garlic',
    name: 'Chopped garlic',
    kind: 'prep',
    yield: { amount: 1, unit: 'cup' }, // 0.5 lb of whole garlic makes 1 cup after peeling
    ingredients: [{ item: product('garlic'), quantity: { amount: 0.5, unit: 'lb' } }],
    shelfLifeDays: 3,
  },
  {
    id: 'vodka-sauce',
    name: 'Vodka sauce',
    kind: 'prep',
    yield: { amount: 4, unit: 'qt' },
    ingredients: [
      { item: recipe('chopped-garlic'), quantity: { amount: 0.25, unit: 'cup' } },
      { item: product('crushed-tomatoes'), quantity: { amount: 2, unit: 'each' } },
      { item: product('cream'), quantity: { amount: 1, unit: 'qt' } },
      { item: product('vodka'), quantity: { amount: 1, unit: 'cup' } },
    ],
    conversions: { customUnits: { 'sixth pan': { amount: 2, unit: 'qt' } } },
    shelfLifeDays: 5,
  },
  {
    id: 'rigatoni-vodka',
    name: 'Rigatoni alla vodka',
    kind: 'dish',
    yield: { amount: 1, unit: 'each' },
    ingredients: [
      { item: recipe('vodka-sauce'), quantity: { amount: 1, unit: 'cup' } },
      { item: product('rigatoni'), quantity: { amount: 0.25, unit: 'lb' } },
      { item: product('parmesan'), quantity: { amount: 1, unit: 'oz' } },
    ],
  },
  {
    id: 'add-chicken',
    name: 'Add chicken',
    kind: 'modifier',
    yield: { amount: 1, unit: 'each' },
    ingredients: [{ item: product('chicken'), quantity: { amount: 4, unit: 'oz' } }],
  },
];

export const links: MenuLinks = {
  items: { 'SQ-RIGATONI': 'rigatoni-vodka' },
  modifiers: { 'SQ-MOD-CHICKEN': 'add-chicken' },
};

export function book(): RecipeBook {
  return new RecipeBook(products, recipes);
}
