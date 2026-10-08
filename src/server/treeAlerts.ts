/**
 * The markers on the recipe tree, from each ingredient up through the preps to the dishes:
 *
 *   notBought  the menu uses it but no invoice has brought it in for far too long (Recipe checks)
 *   noCost     a line with no price, or a unit that won't convert
 *   red        a price over 6 months old (or MarginEdge's last price, older than every invoice we read)
 *   yellow     a price over 3 months old
 *   rough      a recipe not marked ready
 *
 * A recipe carries its own lines' markers and everything below it, so a marker on a dish says
 * "somewhere under here": tap down to find it. Each marker names the ingredient or recipe it's on.
 */

import type { Model } from './model.ts';
import { recipeChecks } from './recipeChecks.ts';

export type MarkerKind = 'notBought' | 'noCost' | 'red' | 'yellow' | 'rough';
export type Markers = Partial<Record<MarkerKind, string[]>>;

const DAY = 86_400_000;
const ageOf = (date: string, today: string) => (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date.slice(0, 10)}T12:00:00Z`)) / DAY;

/** How old a product's price is: red past 6 months (or MarginEdge's last price), yellow past 3. */
export function priceAge(model: Model, productId: string, today: string): 'red' | 'yellow' | undefined {
  const s = model.priceSource.get(productId);
  if (!s) return undefined;
  if (s.from === 'marginedge') return 'red';
  if (!('date' in s) || !s.date) return undefined;
  const days = ageOf(s.date, today);
  return days > 182 ? 'red' : days > 91 ? 'yellow' : undefined;
}

export interface TreeAlerts {
  recipes: Map<string, Markers>;
  products: Map<string, Markers>;
}

const memo = new WeakMap<Model, Map<string, TreeAlerts>>();

export function treeAlerts(model: Model, today: string, dismissed: string[] = []): TreeAlerts {
  const key = `${today}|${dismissed.join('|')}`;
  const hit = memo.get(model)?.get(key);
  if (hit) return hit;
  const notBought = new Set(recipeChecks(model, today, dismissed).notBought.map((x) => x.productId));
  const products = new Map<string, Markers>();
  const productMarkers = (id: string): Markers => {
    let m = products.get(id);
    if (m) return m;
    const name = model.book.products.get(id)?.name ?? id;
    m = {};
    // Never bought: "not bought lately" says it; an old-price marker on top would say it twice.
    if (notBought.has(id)) m.notBought = [name];
    else { const age = priceAge(model, id, today); if (age) m[age] = [name]; }
    if (model.book.unitCost(id) === undefined) m.noCost = [name];
    products.set(id, m);
    return m;
  };
  const add = (into: Markers, from: Markers) => {
    for (const [k, names] of Object.entries(from) as [MarkerKind, string[]][]) into[k] = [...new Set([...(into[k] ?? []), ...names])];
  };
  const recipes = new Map<string, Markers>();
  const visiting = new Set<string>();
  const recipeMarkers = (id: string): Markers => {
    const done = recipes.get(id);
    if (done) return done;
    const r = model.book.recipes.get(id);
    if (!r || visiting.has(id)) return {};
    visiting.add(id);
    const m: Markers = {};
    if (model.rough.has(id)) m.rough = [r.name];
    for (const ing of r.ingredients) {
      if (ing.item.kind === 'recipe') { add(m, recipeMarkers(ing.item.id)); continue; }
      const pid = ing.item.id;
      if (pid.startsWith('free-')) continue;
      // A line not matched yet, or with no amount: it can't be costed.
      if (pid.startsWith('unfinished:') || pid.startsWith('unmatched:')) { add(m, { noCost: [pid.replace(/^\w+:/, '')] }); continue; }
      const own = productMarkers(pid);
      add(m, Object.fromEntries(Object.entries(own).filter(([k]) => k !== 'noCost')) as Markers);
      // No cost for this line: no price, or this unit won't convert to how it's bought.
      if (!model.book.costOf(ing.item, ing.quantity).complete) add(m, { noCost: [model.book.products.get(pid)?.name ?? pid] });
    }
    visiting.delete(id);
    recipes.set(id, m);
    return m;
  };
  for (const id of model.book.recipes.keys()) recipeMarkers(id);
  const result = { recipes, products };
  const mm = memo.get(model) ?? new Map<string, TreeAlerts>();
  mm.set(key, result);
  memo.set(model, mm);
  return result;
}

export const hasMarkers = (m: Markers | undefined) => Boolean(m && Object.values(m).some((x) => x && x.length));
