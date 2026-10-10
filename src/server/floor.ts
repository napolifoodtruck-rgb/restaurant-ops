/**
 * The Floor: the front of house's board on each POS iPad, and what managers set up for it.
 *
 * On an iPad set to a post (no sign-in needed; a PIN only to take credit):
 *   GET  /api/floor/board[?post=]           the post's board for tonight
 *   GET  /api/floor/staff                   names to pick before a PIN
 *   POST /api/floor/check                   { checklistId, staffId, pin, undo? }: tick a checklist item
 *   POST /api/floor/handoff                 { staffId, pin, body }: end-of-night note for the managers
 *   GET  /api/floor/wines/:id/photo         a wine's bottle photo
 *
 * Managers (signed in, on any iPad with their PIN, or on a computer):
 *   GET  /api/floor/setup                   posts, iPads, checklists, notes, features, gelato, settings
 *   POST /api/floor/posts                   { id?, name, kind, tables, stationId?, active? }
 *   POST /api/floor/checklists              { id?, postId?, kind, name, everyDays?, active? }
 *   POST /api/floor/notes                   { id?, postId?, startsOn, endsOn, weekdays?, body, remove? }
 *   POST /api/floor/features                { id?, kind, recipeId?, name, price?, startsOn, endsOn?, weekdays?, note?, remove? }
 *   POST /api/floor/pushes                  { id?, name, recipeId?, why?, endsOn?, remove? }
 *   POST /api/floor/gelato                  { flavors: [{name, vegan}], panChanges?: [{from, to}] }
 *   POST /api/floor/settings                { allergyNote }
 *   POST /api/floor/reports                 { csv } or { mediaType, data }: tonight's OpenTable report
 *   GET  /api/floor/reports/:id             how reading it is going
 *   GET  /api/floor/ingredients             allergens and spoken names, unchecked first
 *   POST /api/floor/ingredients/:id         { allergens?, guestName?, onCards? }
 *   POST /api/floor/ingredients/suggest     Claude suggests allergens and names for unchecked ones
 *   POST /api/floor/preps/:recipeId         { guestName }
 *   GET  /api/floor/wines                   wine cards, Square buttons to link, and which stopped selling
 *   POST /api/floor/wines/scan              { mediaType, data }: read tech sheets
 *   GET  /api/floor/wines/scan/:id
 *   POST /api/floor/wines/scan/:id/save     { wines: [{...sheet, catalogIds}] }
 *   POST /api/floor/wines/:id               { ...fields, catalogIds?, active? }
 *   POST /api/floor/wines/:id/suggest       Claude suggests dishes it pairs with
 *   POST /api/floor/wines/:id/pairings      { pairings: [{recipeId, why}] }
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, body, send } from './http.ts';
import { atLeast, checkPin, type SignedIn } from './auth.ts';
import { getModel, loadBook, type Model } from './model.ts';
import { loadAreas } from './areas.ts';
import { kindOf, linkedItems } from './cards.ts';
import { allergensOf, allergyLine, cardLines, spokenName, usesRecipe, ALLERGEN_KEYS, type AllergenInfo, type Swap } from '../core/allergens.ts';
import { modifierKey, readModifier, resolveModifier, type PosModifier } from '../core/modifiers.ts';
import type { ItemRef } from '../core/recipes.ts';
import { celebrationOf, dietaryOf, forTables, mergeBooks, readOpenTableCsv, whyNotable, REGULAR_VISITS, type Book } from '../core/reservations.ts';
import { claudeOptions, type ClaudePage } from '../connectors/claude.ts';
import { readReservations, readWineSheets, suggestIngredients, suggestPairings, type WineSheet } from '../connectors/floorReaders.ts';
import { normalizeName } from '../core/recipeCards.ts';

export interface FloorContext { who?: SignedIn; device?: { id: string; restaurantId: string; floorPostId: string | null }; restaurantId: string; today: string; minutes: number; weekday: number }

const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const bytes = (d: unknown) => (Buffer.isBuffer(d) ? d : Buffer.from(String(d).replace(/^\\x/, ''), 'hex'));
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const s = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const weekdaysOf = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : null);
const js = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Before 5: getting ready. Until 8:30: service. Then closing. */
export function phaseAt(minutes: number): 'pre' | 'service' | 'closing' {
  return minutes < 17 * 60 ? 'pre' : minutes < 20 * 60 + 30 ? 'service' : 'closing';
}

/** When each item first sold, from the daily sales (they go back further than the order lines). */
const FIRST_SOLD = 'SELECT item_name, min(day)::text AS first FROM pos_item_sales_daily WHERE restaurant_id = $1 AND quantity > 0 GROUP BY item_name';

/** New: first sold within this many days. */
const NEW_DAYS = 21;

// ---------------------------------------------------------------- dishes, drinks and wines, as servers need them

interface DishInfo {
  id: string; name: string; kind: 'dish' | 'drink'; price?: number; lines: string[];
  allergyLine: string; contains: AllergenInfo['contains']; unchecked: string[]; unknown: string[];
  firstSold?: string; catalogIds: string[]; area: 'kitchen' | 'bar'; image?: string;
  /** Asked for with a swap (the gluten-sensitive crust): what it has then. */
  swaps: { label: string; contains: string[]; allergyLine: string; unchecked: string[] }[];
  /**
   * Other ways it can be made for someone avoiding something: a swap the kitchen offers, a modifier rung
   * on the button ("No Goat Cheese"), or two of them together; each with what it has then. Fewest changes first.
   */
  ways: { changes: string[]; contains: string[]; allergyLine: string; unchecked: string[] }[];
}

/**
 * A cards file: `{ "wines": [...] }` or a bare list, each with the fields a tech sheet is read into, plus
 * `dishPairings: [{ dish, why }]` naming dishes on the menu. Anything else is dropped.
 */
export function readCardsFile(text: string): (WineSheet & { dishPairings: { dish: string; why: string }[] })[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpError(400, 'That cards file isn’t valid JSON.'); }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.wines) ? (raw as any).wines : undefined;
  if (!list) throw new HttpError(400, 'A cards file is a list of wines.');
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter((x): x is string => Boolean(x)).slice(0, 12) : []);
  const out = list.slice(0, 200).flatMap((w: any) => {
    const name = str(w?.name, 160);
    if (!name) return [];
    const opt = Object.fromEntries((['producer', 'region', 'place', 'grapes', 'vessel', 'style', 'tastingNotes', 'story'] as const).flatMap((k) => { const v = str(w[k], k === 'story' ? 2000 : 600); return v ? [[k, v]] : []; }));
    const dishPairings = (Array.isArray(w.dishPairings) ? w.dishPairings : []).flatMap((p: any) => { const dish = str(typeof p === 'string' ? p : p?.dish, 160); return dish ? [{ dish, why: str(p?.why, 200) ?? '' }] : []; }).slice(0, 10);
    return [{ name, ...opt, facts: strs(w.facts), menuPairings: strs(w.menuPairings), ingredientPairings: strs(w.ingredientPairings), dishPairings }];
  });
  if (!out.length) throw new HttpError(400, 'No wines with a name in that file.');
  return out;
}

/** The quiz bank: managers' own questions, and their edits to (or switching off of) questions from the menu. */
interface QuizRow { id: string; auto_key: string | null; question: string | null; answer: string | null; wrong: unknown; why: string | null; dish_id: string | null; active: boolean }
const quizView = (r: QuizRow) => ({ id: r.id, ...(r.auto_key ? { key: r.auto_key } : {}), question: r.question, answer: r.answer, wrong: js<string[]>(r.wrong ?? []), why: r.why, dishId: r.dish_id, active: r.active });
async function quizBank(db: Db, rid: string) {
  const rows = (await db.query<QuizRow>('SELECT id, auto_key, question, answer, wrong, why, dish_id, active FROM floor_quiz WHERE restaurant_id = $1 ORDER BY updated_at', [rid])).rows;
  return { own: rows.filter((r) => !r.auto_key && r.active).map(quizView), edits: rows.filter((r) => r.auto_key).map(quizView) };
}

/** "-- No Goat Cheese" → "No Goat Cheese". */
const modifierLabel = (name: string) => name.replace(/^[\s+*\-–]+/, '').replace(/\s+/g, ' ').trim();

async function floorSettings(db: Db, restaurantId: string): Promise<{ allergyNote?: string; swaps?: Swap[]; readOnlyLists?: string[] }> {
  return js<{ allergyNote?: string; swaps?: Swap[]; readOnlyLists?: string[] }>((await db.query<{ settings: unknown }>('SELECT settings FROM restaurants WHERE id = $1', [restaurantId])).rows[0]?.settings ?? {});
}

/** Allergens for any recipe, from what's been tagged on the ingredients (and the swaps the kitchen offers). */
export async function recipeAllergens(db: Db, restaurantId: string, model: Model) {
  const tags = new Map((await db.query<{ ingredient_id: string; allergens: string[] | null }>('SELECT ingredient_id, allergens FROM ingredient_answers WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.ingredient_id, r.allergens]));
  const productName = new Map(model.products.map((p) => [p.id, p.name]));
  const swaps = ((await floorSettings(db, restaurantId)).swaps ?? []).filter((w) => model.book.recipes.has(w.from) && model.book.recipes.has(w.to));
  const src = { recipes: model.book.recipes, tagsOf: (id: string) => tags.get(id) ?? undefined, nameOf: (id: string) => productName.get(id) ?? id };
  return {
    of: (recipeId: string) => {
      const info = allergensOf(recipeId, src);
      return { ...info, line: allergyLine(info), swaps: swaps.filter((w) => usesRecipe(recipeId, w.from, model.book.recipes)).map((w) => { const x = allergensOf(recipeId, src, w); return { label: w.label, line: allergyLine(x), contains: x.contains.map((c) => c.key) }; }) };
    },
    /** Each ingredient's tags by id: [] checked and none, null not checked. */
    tags,
  };
}

async function dishIndex(db: Db, restaurantId: string, model: Model): Promise<{ dishes: DishInfo[]; byId: Map<string, DishInfo> }> {
  const book = await loadBook(db, restaurantId);
  const cards = (book.recipeCards ?? []).filter((c) => c.status !== 'rough' && (kindOf(c) === 'dish' || kindOf(c) === 'drink'));
  const answers = new Map((await db.query<{ ingredient_id: string; allergens: string[] | null; guest_name: string | null; on_cards: boolean }>(
    'SELECT ingredient_id, allergens, guest_name, on_cards FROM ingredient_answers WHERE restaurant_id = $1', [restaurantId])).rows.map((r) => [r.ingredient_id, r]));
  const prepNames = new Map((await db.query<{ id: string; name: string; guest_name: string | null }>('SELECT id, name, guest_name FROM recipes WHERE restaurant_id = $1 AND removed_at IS NULL', [restaurantId])).rows.map((r) => [r.id, r.guest_name ?? r.name]));
  const productName = new Map(model.products.map((p) => [p.id, p.name]));
  const linked = linkedItems(model);
  const price = new Map(model.menuItems.filter((m) => m.price !== undefined).map((m) => [m.catalogId, m.price!]));
  const firstSold = new Map((await db.query<{ item_name: string; first: string }>(FIRST_SOLD, [restaurantId])).rows.map((r) => [r.item_name, r.first]));
  const areaOf = await loadAreas(db, restaurantId);
  const swaps = ((await floorSettings(db, restaurantId)).swaps ?? []).filter((w) => model.book.recipes.has(w.from) && model.book.recipes.has(w.to));
  const src = {
    recipes: model.book.recipes,
    tagsOf: (id: string) => answers.get(id)?.allergens ?? undefined,
    nameOf: (id: string) => productName.get(id) ?? id,
  };
  const names = {
    product: (id: string) => { const a = answers.get(id); return { name: a?.guest_name ?? spokenName(productName.get(id) ?? id), show: a?.on_cards ?? true }; },
    recipe: (id: string) => prepNames.get(id) ?? model.book.recipes.get(id)?.name ?? id,
  };
  // The modifiers rung on each button, and what each takes off or puts on a dish.
  const modsOn = new Map<string, PosModifier[]>();
  for (const l of model.modifierSales) {
    const list = modsOn.get(l.catalogId) ?? [];
    if (!list.some((m) => modifierKey(m) === modifierKey(l.modifier))) list.push(l.modifier);
    modsOn.set(l.catalogId, list);
  }
  const waysFor = (recipeId: string, catalogIds: string[], plain: AllergenInfo) => {
    const keys = (i: AllergenInfo) => i.contains.map((x) => x.key);
    const base = new Set(keys(plain));
    const changes: { label: string; swap?: Swap; removes?: ItemRef[]; adds?: ItemRef[] }[] = [
      ...swaps.filter((w) => usesRecipe(recipeId, w.from, model.book.recipes)).map((w) => ({ label: `the ${w.label}`, swap: w })),
    ];
    const seen = new Set<string>();
    for (const m of catalogIds.flatMap((id) => modsOn.get(id) ?? [])) {
      const reading = readModifier(m);
      if (reading.action !== 'remove' && reading.action !== 'swap') continue;
      if (seen.has(modifierLabel(m.name).toLowerCase())) continue;
      seen.add(modifierLabel(m.name).toLowerCase());
      const r = resolveModifier(model.book, recipeId, m, model.modifierAnswers);
      if (!('resolved' in r) || !r.resolved.removes.length) continue;
      changes.push({ label: modifierLabel(m.name), removes: r.resolved.removes.map((x) => x.item), adds: r.resolved.adds.map((x) => x.item) });
    }
    const out: DishInfo['ways'] = [];
    const tryWay = (picked: typeof changes) => {
      const swap = picked.find((x) => x.swap)?.swap;
      const change = { removes: picked.flatMap((x) => x.removes ?? []), adds: picked.flatMap((x) => x.adds ?? []) };
      const info = allergensOf(recipeId, src, swap, change);
      const now = keys(info);
      // Only worth saying when it takes an allergen away (and not already said with fewer changes).
      if ([...base].some((k) => !now.includes(k)) && !out.some((w) => w.contains.join() === now.join() && w.changes.length <= picked.length)) {
        out.push({ changes: picked.map((x) => x.label), contains: now, allergyLine: allergyLine(info), unchecked: info.unchecked });
      }
    };
    for (const a of changes) tryWay([a]);
    for (let i = 0; i < changes.length; i++) for (let j = i + 1; j < changes.length; j++) if (!(changes[i]!.swap && changes[j]!.swap)) tryWay([changes[i]!, changes[j]!]);
    return out.slice(0, 12);
  };
  const dishes: DishInfo[] = [];
  for (const c of cards) {
    const recipe = c.id ? model.book.recipes.get(c.id) : undefined;
    if (!recipe) continue;
    const items = linked.get(recipe.id) ?? [];
    const info = allergensOf(recipe.id, src);
    const firsts = items.map((i) => firstSold.get(i.itemName)).filter((x): x is string => Boolean(x)).sort();
    const prices = items.map((i) => price.get(i.catalogId)).filter((p): p is number => p !== undefined);
    const category = model.sales.find((l) => items.some((i) => i.catalogId === l.catalogId))?.category;
    dishes.push({
      id: recipe.id, name: c.name, kind: kindOf(c) === 'drink' ? 'drink' : 'dish', ...(prices.length ? { price: Math.max(...prices) } : {}),
      lines: cardLines(recipe, names), allergyLine: allergyLine(info), contains: info.contains, unchecked: info.unchecked, unknown: info.unknown,
      ...(firsts[0] ? { firstSold: firsts[0] } : {}), catalogIds: items.map((i) => i.catalogId),
      ...(items.map((i) => model.imageOf(i.catalogId)).find(Boolean) ? { image: items.map((i) => model.imageOf(i.catalogId)).find(Boolean)! } : {}),
      area: category && areaOf(category) === 'bar' ? 'bar' : category ? 'kitchen' : kindOf(c) === 'drink' ? 'bar' : 'kitchen',
      swaps: swaps.filter((w) => usesRecipe(recipe.id, w.from, model.book.recipes)).map((w) => {
        const with_ = allergensOf(recipe.id, src, w);
        return { label: w.label, contains: with_.contains.map((x) => x.key), allergyLine: allergyLine(with_), unchecked: with_.unchecked };
      }),
      ways: waysFor(recipe.id, items.map((i) => i.catalogId), info),
    });
  }
  return { dishes, byId: new Map(dishes.map((d) => [d.id, d])) };
}

interface WineRow {
  id: string; name: string; producer: string | null; region: string | null; place: string | null; grapes: string | null; vessel: string | null; style: string | null;
  tasting_notes: string | null; story: string | null; facts: unknown; sheet_pairings: unknown; ingredient_pairings: unknown; catalog_ids: string[]; pairings: unknown; suggested: unknown;
  has_photo: boolean; active: boolean; created_at: string;
}
const WINE_COLS = 'id, name, producer, region, place, grapes, vessel, style, tasting_notes, story, facts, sheet_pairings, ingredient_pairings, catalog_ids, pairings, suggested, photo IS NOT NULL AS has_photo, active, created_at::text AS created_at';

function wineView(w: WineRow, buttons: ReturnType<typeof wineButtons>, dishes: Map<string, DishInfo>, firstSold: Map<string, string>, today: string) {
  const items = buttons.filter((m) => w.catalog_ids.includes(m.catalogId));
  const firsts = items.map((m) => firstSold.get(m.itemName)).filter((x): x is string => Boolean(x)).sort();
  const isNew = (firsts[0] ?? w.created_at.slice(0, 10)) >= addDays(today, -30);
  // Approved pairings; until there are any, the suggestions waiting for a manager, marked as such.
  const approved = js<{ recipeId: string; why: string }[]>(w.pairings ?? []);
  const waiting = approved.length ? [] : js<{ recipeId: string; why: string }[] | null>(w.suggested ?? null) ?? [];
  const pairings = [...approved.map((p) => ({ ...p })), ...waiting.map((p) => ({ ...p, suggested: true }))].map((p) => ({ ...p, name: dishes.get(p.recipeId)?.name })).filter((p) => p.name);
  return {
    id: w.id, name: w.name, producer: w.producer, region: w.region, place: w.place, grapes: w.grapes, vessel: w.vessel, style: w.style,
    tastingNotes: w.tasting_notes, story: w.story, facts: js<string[]>(w.facts ?? []), sheetPairings: js<string[]>(w.sheet_pairings ?? []), ingredientPairings: js<string[]>(w.ingredient_pairings ?? []),
    pairings, prices: items.map((m) => ({ label: /\bGLS\b|glass/i.test(`${m.itemName} ${m.variationName ?? ''}`) ? 'Glass' : /\bBTL\b|bottle/i.test(`${m.itemName} ${m.variationName ?? ''}`) ? 'Bottle' : (m.variationName ?? 'Price'), price: m.price })).filter((p) => p.price !== undefined),
    hasPhoto: w.has_photo, isNew, catalogIds: w.catalog_ids,
  };
}

/**
 * Square's wine buttons: catalog items in a wine category, or bar items marked BTL/GLS; and, when the
 * catalog doesn't carry a category, what sold under a wine category.
 */
function wineButtons(model: Model, areaOf: (category: string | undefined) => string): { catalogId: string; name: string; itemName: string; variationName?: string; price?: number }[] {
  const out = new Map<string, { catalogId: string; name: string; itemName: string; variationName?: string; price?: number }>();
  for (const m of model.menuItems) {
    if (!(/wine/i.test(m.category ?? '') || (areaOf(m.category) === 'bar' && /\b(BTL|GLS)\b/.test(m.itemName)))) continue;
    out.set(m.catalogId, { catalogId: m.catalogId, name: m.variationName && !/^regular$/i.test(m.variationName) ? `${m.itemName} (${m.variationName})` : m.itemName, itemName: m.itemName, ...(m.variationName ? { variationName: m.variationName } : {}), ...(m.price !== undefined ? { price: m.price } : {}) });
  }
  for (const l of model.sales) {
    if (out.has(l.catalogId) || !/wine/i.test(l.category ?? '') || /corkage/i.test(l.name)) continue;
    out.set(l.catalogId, { catalogId: l.catalogId, name: l.name, itemName: l.name, ...(l.listPrice !== undefined ? { price: l.listPrice } : {}) });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "Gavi - GLS", "Gavi BTL (50% OFF WINE WEDNESDAY)" → "Gavi". */
export const wineBase = (name: string) => name.replace(/\(.*?\)/g, ' ').replace(/[-–]?\s*\b(BTL|GLS|bottle|glass)\b/gi, ' ').replace(/\s*[-–]\s*/g, ' - ').replace(/\s+/g, ' ').replace(/[\s-]+$/, '').trim();

// ---------------------------------------------------------------- tonight's book

async function tonightsBook(db: Db, restaurantId: string, today: string): Promise<{ book: Book; asOf: string; source: string } | undefined> {
  // Guest details are for the night only.
  await db.query('DELETE FROM floor_reports WHERE restaurant_id = $1 AND day < $2', [restaurantId, today]);
  const reports = (await db.query<{ source: string; result: unknown; uploaded_at: string }>(
    "SELECT source, result, uploaded_at::text AS uploaded_at FROM floor_reports WHERE restaurant_id = $1 AND day = $2 AND status = 'read' ORDER BY uploaded_at", [restaurantId, today])).rows;
  if (!reports.length) return undefined;
  let book: Book | undefined;
  let asOf = '', source = '';
  for (const r of reports) {
    const read = js<{ book: Book; asOf: string }>(r.result);
    book = mergeBooks(book, read.book);
    asOf = read.asOf; source = r.source;
  }
  return { book: book!, asOf, source };
}

// ---------------------------------------------------------------- the board

async function postFor(db: Db, ctx: FloorContext, asked: string | undefined) {
  const posts = (await db.query<{ id: string; name: string; kind: string; tables: string[]; station_id: string | null }>(
    'SELECT id, name, kind, tables, station_id FROM floor_posts WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [ctx.restaurantId])).rows;
  const manager = ctx.who && atLeast(ctx.who.roleLevel, 'manager');
  const id = (manager && asked) || ctx.device?.floorPostId || (manager ? posts[0]?.id : undefined);
  const post = posts.find((p) => p.id === id);
  return { posts, post };
}

export async function floorBoard(db: Db, ctx: FloorContext, asked?: string) {
  const { posts, post } = await postFor(db, ctx, asked);
  if (!post) throw new HttpError(409, posts.length ? 'This iPad isn’t set to a post yet. A manager can set it in Service → Setup.' : 'Service isn’t set up yet. A manager can add the dining rooms in Service → Setup.');
  const rid = ctx.restaurantId, today = ctx.today;
  const model = await getModel(db, rid, today);
  const { dishes, byId } = await dishIndex(db, rid, model);
  const side: 'kitchen' | 'bar' | 'both' = post.kind === 'bar' ? 'bar' : post.kind === 'room' ? 'kitchen' : 'both';

  // Tonight's book: this post's tables (every table at the host stand).
  const tonight = await tonightsBook(db, rid, today);
  const mine = tonight ? forTables(tonight.book, post.kind === 'host' ? 'all' : post.tables) : [];
  const all = tonight?.book.reservations ?? [];
  const hour = (t: string) => Number(t.slice(0, 2));
  const byHour = new Map<number, number>();
  for (const r of all) byHour.set(hour(r.time), (byHour.get(hour(r.time)) ?? 0) + r.partySize);
  const busiest = [...byHour].sort((a, b) => b[1] - a[1])[0];

  // Featured: specials running tonight and items first sold in the last few weeks (unless hidden).
  const features = (await db.query<{ id: string; kind: string; recipe_id: string | null; name: string; price: string | null; starts_on: string; ends_on: string | null; weekdays: number[] | null; note: string | null }>(
    `SELECT id, kind, recipe_id, name, price, starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays, note FROM floor_features
      WHERE restaurant_id = $1 AND starts_on <= $2 AND (ends_on IS NULL OR ends_on >= $2) ORDER BY created_at`, [rid, today])).rows;
  const hidden = new Set(features.filter((f) => f.kind === 'hidden' && f.recipe_id).map((f) => f.recipe_id!));
  const card = (d: DishInfo | undefined, extra: { kind: string; name?: string; price?: number; note?: string | null; days?: number[] | null }) => ({
    kind: extra.kind, name: extra.name ?? d?.name ?? '', ...(extra.price ?? d?.price ? { price: extra.price ?? d?.price } : {}),
    lines: d?.lines ?? [], allergyLine: d?.allergyLine ?? '', unchecked: d?.unchecked ?? [], ...(d ? { id: d.id } : {}),
    ...(extra.note ? { note: extra.note } : {}), ...(extra.days?.length ? { days: extra.days } : {}), area: d?.area ?? 'kitchen',
  });
  const specials = features.filter((f) => f.kind === 'special' && (!f.weekdays?.length || f.weekdays.includes(ctx.weekday)))
    .map((f) => card(f.recipe_id ? byId.get(f.recipe_id) : undefined, { kind: 'special', name: f.name, ...(f.price !== null ? { price: Number(f.price) } : {}), note: f.note, days: f.weekdays }));
  const pinnedNew = features.filter((f) => f.kind === 'new' && f.recipe_id).map((f) => f.recipe_id!);
  // New on the menu: dishes everywhere; new drinks at the bar (wines have their own cards).
  const fresh = dishes.filter((d) => (d.kind === 'dish' || post.kind === 'bar') && !hidden.has(d.id) && !specials.some((x) => x.id === d.id) && ((d.firstSold && d.firstSold >= addDays(today, -NEW_DAYS)) || pinnedNew.includes(d.id)))
    .map((d) => card(d, { kind: 'new' }));
  const featured = [...specials, ...fresh].filter((f) => side === 'both' || f.area === side || post.kind === 'room');

  // Gelato: the flight as last set; tonight's pan changes only on the night they were set for.
  const gelato = (await db.query<{ flavors: unknown; pan_changes: unknown; pans_on: string | null; set_at: string }>(
    'SELECT flavors, pan_changes, pans_on::text AS pans_on, set_at::text AS set_at FROM floor_gelato WHERE restaurant_id = $1 ORDER BY set_at DESC LIMIT 1', [rid])).rows[0];

  // Talk it up: managers' picks, then what makes the most money on this side.
  const pushes = (await db.query<{ name: string; recipe_id: string | null; why: string | null }>('SELECT name, recipe_id, why FROM floor_pushes WHERE restaurant_id = $1 AND (ends_on IS NULL OR ends_on >= $2) ORDER BY created_at DESC', [rid, today])).rows;
  const areaOf = await loadAreas(db, rid);
  const earners = model.margins.dishes
    .filter((d) => d.cost.complete && d.quantity > 0 && (side === 'both' || areaOf(d.category) === side))
    .map((d) => ({ name: d.name, recipeId: d.recipeId, profit: d.netSales - d.cost.total * d.quantity }))
    .sort((a, b) => b.profit - a.profit);
  const talk = [
    ...pushes.map((p) => ({ name: p.name, why: p.why ?? 'Manager’s pick', mine: true })),
    ...earners.filter((e) => !pushes.some((p) => p.recipe_id === e.recipeId || normalizeName(p.name) === normalizeName(e.name))).slice(0, 3).map((e) => ({ name: e.name, why: 'One of our best earners', mine: false })),
  ];

  // Notes for tonight: every post's and this one's, one-night or recurring on a weekday.
  const notes = (await db.query<{ id: string; body: string; post_id: string | null; by: string | null; weekdays: number[] | null }>(
    `SELECT n.id, n.body, n.post_id, s.display_name AS by, n.weekdays FROM floor_notes n LEFT JOIN staff s ON s.id = n.created_by
      WHERE n.restaurant_id = $1 AND n.starts_on <= $2 AND n.ends_on >= $2 AND (n.post_id IS NULL OR n.post_id = $3) ORDER BY n.created_at`, [rid, today, post.id])).rows
    .filter((n) => !n.weekdays?.length || n.weekdays.includes(ctx.weekday))
    .map((n) => ({ id: n.id, body: n.body, ...(n.by ? { by: n.by } : {}), forPost: Boolean(n.post_id) }));

  // Checklists: tonight's opening and closing, and the "when it's slow" list with when each was last done.
  const readOnlyLists = new Set((await floorSettings(db, rid)).readOnlyLists ?? []);
  const lists = (await db.query<{ id: string; kind: 'opening' | 'closing' | 'slow'; name: string; every_days: number | null; read_only: boolean }>(
    'SELECT id, kind, name, every_days, read_only FROM floor_checklists WHERE restaurant_id = $1 AND active AND (post_id IS NULL OR post_id = $2) ORDER BY kind, sort_order, name', [rid, post.id])).rows;
  const done = (await db.query<{ checklist_id: string; day: string; by: string | null; at: string }>(
    `SELECT DISTINCT ON (c.checklist_id) c.checklist_id, c.day::text AS day, s.display_name AS by, c.done_at::text AS at
       FROM floor_checks c LEFT JOIN staff s ON s.id = c.done_by WHERE c.restaurant_id = $1 ORDER BY c.checklist_id, c.day DESC, c.done_at DESC`, [rid])).rows;
  const last = new Map(done.map((d) => [d.checklist_id, d]));
  const checklist = (kind: 'opening' | 'closing') => lists.filter((l) => l.kind === kind).map((l) => {
    const d = last.get(l.id);
    if (readOnlyLists.has(kind) || l.read_only) return { id: l.id, name: l.name, readOnly: true };
    return { id: l.id, name: l.name, ...(d && d.day === today ? { done: { by: d.by, at: d.at } } : {}) };
  });
  const slow = lists.filter((l) => l.kind === 'slow').map((l) => {
    if (readOnlyLists.has('slow') || l.read_only) return { id: l.id, name: l.name, due: false, readOnly: true };
    const d = last.get(l.id);
    const due = !d || !l.every_days || d.day <= addDays(today, -l.every_days);
    return { id: l.id, name: l.name, due, ...(d ? { last: { day: d.day, by: d.by } } : {}), ...(l.every_days ? { everyDays: l.every_days } : {}) };
  }).sort((a, b) => Number(b.due) - Number(a.due));

  // Wines.
  const firstSold = new Map((await db.query<{ item_name: string; first: string }>(FIRST_SOLD, [rid])).rows.map((r) => [r.item_name, r.first]));
  const buttons = wineButtons(model, areaOf);
  const wines = (await db.query<WineRow>(`SELECT ${WINE_COLS} FROM wine_cards WHERE restaurant_id = $1 AND active ORDER BY name`, [rid])).rows.map((w) => wineView(w, buttons, byId, firstSold, today));
  // Each dish shows the wines that pair with it.
  const winesFor = new Map<string, string[]>();
  for (const w of wines) for (const p of w.pairings) winesFor.set(p.recipeId, [...(winesFor.get(p.recipeId) ?? []), w.name]);

  const settings = await floorSettings(db, rid);
  const book = tonight ? {
    asOf: tonight.asOf, source: tonight.source, covers: tonight.book.covers ?? all.reduce((a, r) => a + r.partySize, 0), parties: all.length,
    mineCovers: mine.reduce((a, r) => a + r.partySize, 0), mineParties: mine.length,
    ...(busiest ? { busiest: { hour: busiest[0], covers: busiest[1] } } : {}),
    reservations: mine.map((r) => {
      const dietary = dietaryOf(r), celebration = celebrationOf(r);
      return { ...r, why: whyNotable(r), notable: whyNotable(r).length > 0, suggestRegular: !r.vip && (r.visitsLastYear ?? 0) >= REGULAR_VISITS, ...(dietary ? { dietary } : {}), ...(celebration ? { celebration } : {}) };
    }),
  } : null;
  return {
    post: { id: post.id, name: post.name, kind: post.kind, ...(post.station_id ? { stationId: post.station_id } : {}) },
    posts: ctx.who && atLeast(ctx.who.roleLevel, 'manager') ? posts.map((p) => ({ id: p.id, name: p.name })) : undefined,
    day: today, weekday: ctx.weekday, minutes: ctx.minutes, phase: phaseAt(ctx.minutes),
    book, featured,
    gelato: gelato ? { flavors: js(gelato.flavors), panChanges: gelato.pans_on === today ? js(gelato.pan_changes) : [], setAt: gelato.set_at } : null,
    talk, notes, checklists: { opening: checklist('opening'), closing: checklist('closing'), slow },
    quiz: await quizBank(db, rid),
    lookup: {
      dishes: dishes
        .map((d) => ({ id: d.id, name: d.name, kind: d.kind, area: d.area, ...(d.price !== undefined ? { price: d.price } : {}), ...(d.image ? { image: d.image } : {}),
          ...(d.firstSold ? { firstSold: d.firstSold } : {}), isNew: fresh.some((f) => f.id === d.id), lines: d.lines, allergyLine: d.allergyLine, contains: d.contains.map((c) => c.key), unchecked: d.unchecked, unknown: d.unknown, swaps: d.swaps, ways: d.ways, wines: winesFor.get(d.id) ?? [] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      wines,
    },
    allergyNote: settings.allergyNote ?? '',
    allergens: ALLERGEN_KEYS,
  };
}

// ---------------------------------------------------------------- reading reports and sheets

async function readReport(db: Db, id: string): Promise<void> {
  const r = (await db.query<{ file: unknown; media_type: string; uploaded_at: string; day: string }>('SELECT file, media_type, uploaded_at::text AS uploaded_at, day::text AS day FROM floor_reports WHERE id = $1', [id])).rows[0];
  if (!r) return;
  const opts = claudeOptions();
  try {
    if (!opts) throw new Error('Reading reports needs ANTHROPIC_API_KEY in Render.');
    const read = await readReservations([{ mediaType: r.media_type as ClaudePage['mediaType'], data: bytes(r.file) }], opts);
    const asOf = read.generatedAt ?? new Date(r.uploaded_at).toISOString();
    await db.query("UPDATE floor_reports SET status = 'read', result = $2, usage = $3, day = coalesce($4::date, day), file = NULL WHERE id = $1",
      [id, JSON.stringify({ book: read.book, asOf }), JSON.stringify({ ...read.usage, model: read.model }), read.book.day ?? null]);
  } catch (err) {
    console.error(`[floor report ${id}]`, err);
    await db.query("UPDATE floor_reports SET status = 'failed', error = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 300)]);
  }
}

async function readSheets(db: Db, id: string, restaurantId: string): Promise<void> {
  const r = (await db.query<{ file: unknown; media_type: string }>('SELECT file, media_type FROM wine_sheet_scans WHERE id = $1', [id])).rows[0];
  if (!r) return;
  const opts = claudeOptions();
  try {
    if (!opts) throw new Error('Reading tech sheets needs ANTHROPIC_API_KEY in Render.');
    const wineList = (await db.query<{ item_name: string }>(
      "SELECT DISTINCT item_name FROM pos_item_sales_daily WHERE restaurant_id = $1 AND category ILIKE '%wine%' AND day >= current_date - 120 ORDER BY item_name", [restaurantId])).rows.map((x) => x.item_name);
    const read = await readWineSheets([{ mediaType: r.media_type as ClaudePage['mediaType'], data: bytes(r.file) }], opts, wineList);
    await db.query("UPDATE wine_sheet_scans SET status = 'read', result = $2, usage = $3 WHERE id = $1", [id, JSON.stringify(read.wines), JSON.stringify({ ...read.usage, model: read.model })]);
  } catch (err) {
    console.error(`[wine sheets ${id}]`, err);
    await db.query("UPDATE wine_sheet_scans SET status = 'failed', error = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 300)]);
  }
}

/** Square's wine buttons a sheet probably is (same producer and wine words). */
const buttonWords = (x: string) => new Set(normalizeName(x).split(' ').filter((w) => w.length > 2 && !['btl', 'gls', 'bottle', 'glass', 'doc', 'docg', 'igt'].includes(w)));
const sharedWords = (name: string, button: string) => { const mine = buttonWords(name), theirs = buttonWords(button); return { shared: [...theirs].filter((w) => mine.has(w)).length, size: theirs.size }; };
function likelyButtons(name: string, items: { catalogId: string; name: string }[]): string[] {
  return items.filter((i) => { const { shared, size } = sharedWords(name, i.name); return shared >= Math.min(3, size); }).map((i) => i.catalogId);
}
/**
 * Buttons for several wines at once: a button that fits more than one ("Tenuta degli Ultimi Prosecco"
 * and "… Sparkling Rosé" share three words) goes only to the wine sharing the most words with it.
 */
export function buttonsForWines(names: readonly string[], items: { catalogId: string; name: string }[]): string[][] {
  const fits = names.map((n) => likelyButtons(n, items));
  const best = new Map(items.map((i) => [i.catalogId, Math.max(0, ...names.map((n, k) => (fits[k]!.includes(i.catalogId) ? sharedWords(n, i.name).shared : 0)))]));
  return names.map((n, k) => fits[k]!.filter((id) => sharedWords(n, items.find((i) => i.catalogId === id)!.name).shared >= best.get(id)!));
}

// ---------------------------------------------------------------- routes

export async function floorRoutes(db: Db, req: IncomingMessage, res: ServerResponse, url: URL, method: string, ctx: FloorContext): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/floor')) return false;
  const rid = ctx.restaurantId;

  if (method === 'GET' && path === '/api/floor/board') return send(res, 200, await floorBoard(db, ctx, url.searchParams.get('post') ?? undefined)), true;
  // Tonight for anyone signed in (staff Today): what the boards say, without the reservations.
  if (method === 'GET' && path === '/api/floor/tonight') {
    if (!ctx.who) throw new HttpError(401, 'Sign in first.');
    const posts = (await db.query<{ id: string; kind: string }>('SELECT id, kind FROM floor_posts WHERE restaurant_id = $1 AND active ORDER BY sort_order, name', [rid])).rows;
    const host = posts.find((p) => p.kind === 'host') ?? posts[0];
    if (!host) return send(res, 200, { featured: [], talk: [], notes: [], gelato: null }), true;
    const b = await floorBoard(db, { ...ctx, device: { id: 'tonight', restaurantId: rid, floorPostId: host.id } });
    return send(res, 200, {
      featured: b.featured.map((f) => ({ kind: f.kind, name: f.name, ...(f.price !== undefined ? { price: f.price } : {}), ...(f.note ? { note: f.note } : {}), lines: f.lines })),
      talk: b.talk, notes: b.notes.filter((n) => !n.forPost).map((n) => ({ body: n.body, ...(n.by ? { by: n.by } : {}) })), gelato: b.gelato,
    }), true;
  }

  if (method === 'GET' && path === '/api/floor/staff') {
    const rows = (await db.query<{ id: string; display_name: string; access: string }>('SELECT id, display_name, access FROM staff WHERE restaurant_id = $1 AND active AND pin_hash IS NOT NULL ORDER BY display_name', [rid])).rows;
    return send(res, 200, { staff: rows.map((r) => ({ id: r.id, name: r.display_name, manager: r.access !== 'staff' })) }), true;
  }

  if (method === 'POST' && (path === '/api/floor/check' || path === '/api/floor/handoff')) {
    const b = await body(req);
    const staffId = String(b.staffId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(staffId)) throw new HttpError(400, 'Who are you? Pick your name.');
    const pin = await checkPin(db, rid, staffId, String(b.pin ?? ''));
    if (!pin.ok) throw new HttpError(pin.status, pin.error);
    if (path === '/api/floor/handoff') {
      const text = s(b.body, 4000);
      if (!text) throw new HttpError(400, 'Write the note first.');
      await db.query('INSERT INTO floor_handoffs (restaurant_id, post_id, day, body, written_by) VALUES ($1, $2, $3, $4, $5)', [rid, ctx.device?.floorPostId ?? null, ctx.today, text, staffId]);
      return send(res, 200, { ok: true, by: pin.name }), true;
    }
    const list = (await db.query<{ id: string; kind: string; read_only: boolean }>('SELECT id, kind, read_only FROM floor_checklists WHERE restaurant_id = $1 AND id = $2 AND active', [rid, String(b.checklistId ?? '')])).rows[0];
    if (!list) throw new HttpError(404, 'That checklist item isn’t there any more.');
    if (list.read_only || ((await floorSettings(db, rid)).readOnlyLists ?? []).includes(list.kind)) throw new HttpError(400, 'That one’s a reminder to read, not a box to tick.');
    if (b.undo === true) await db.query('DELETE FROM floor_checks WHERE restaurant_id = $1 AND checklist_id = $2 AND day = $3', [rid, list.id, ctx.today]);
    else await db.query('INSERT INTO floor_checks (restaurant_id, checklist_id, day, done_by) VALUES ($1, $2, $3, $4) ON CONFLICT (checklist_id, day) DO UPDATE SET done_by = EXCLUDED.done_by, done_at = now()', [rid, list.id, ctx.today, staffId]);
    return send(res, 200, { ok: true, by: pin.name }), true;
  }

  const photo = path.match(/^\/api\/floor\/wines\/([0-9a-f-]{36})\/photo$/);
  if (method === 'GET' && photo) {
    const w = (await db.query<{ photo: unknown; photo_type: string | null }>('SELECT photo, photo_type FROM wine_cards WHERE restaurant_id = $1 AND id = $2', [rid, photo[1]])).rows[0];
    if (!w?.photo) throw new HttpError(404, 'No photo.');
    res.writeHead(200, { 'content-type': w.photo_type ?? 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    res.end(bytes(w.photo));
    return true;
  }

  // Everything below changes how the Floor is set up: managers only.
  const who = ctx.who;
  if (!who || !atLeast(who.roleLevel, 'manager')) throw new HttpError(who ? 403 : 401, 'A manager signs in to change this.');

  // The quiz bank: every question a manager has written or changed, turned off ones too.
  if (method === 'GET' && path === '/api/floor/quiz') {
    const rows = (await db.query<QuizRow>('SELECT id, auto_key, question, answer, wrong, why, dish_id, active FROM floor_quiz WHERE restaurant_id = $1 ORDER BY updated_at DESC', [rid])).rows;
    return send(res, 200, { questions: rows.map(quizView) }), true;
  }
  if (method === 'POST' && path === '/api/floor/quiz') {
    const b = await body(req);
    const key = s(b.key, 300) ?? null;
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : null;
    // Back to how the menu makes it: the edit goes.
    if (b.reset === true && (key || id)) {
      await db.query('DELETE FROM floor_quiz WHERE restaurant_id = $1 AND (auto_key = $2 OR id = $3)', [rid, key, id]);
      return send(res, 200, { ok: true }), true;
    }
    const question = s(b.question, 300) ?? null, answer = s(b.answer, 200) ?? null;
    const wrong = (Array.isArray(b.wrong) ? b.wrong : []).map((x: unknown) => s(x, 200)).filter((x: string | undefined): x is string => Boolean(x) && x !== answer).slice(0, 5);
    const why = s(b.why, 600) ?? null;
    const dish = typeof b.dishId === 'string' && /^[0-9a-f-]{36}$/.test(b.dishId) ? b.dishId : null;
    const active = b.active !== false;
    if (!key && active && (!question || !answer || !wrong.length)) throw new HttpError(400, 'A question, the right answer and at least one wrong one.');
    if (key) {
      await db.query(`INSERT INTO floor_quiz (restaurant_id, auto_key, question, answer, wrong, why, dish_id, active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (restaurant_id, auto_key) WHERE auto_key IS NOT NULL DO UPDATE SET question = coalesce(EXCLUDED.question, floor_quiz.question), answer = coalesce(EXCLUDED.answer, floor_quiz.answer),
          wrong = CASE WHEN jsonb_array_length(EXCLUDED.wrong) > 0 THEN EXCLUDED.wrong ELSE floor_quiz.wrong END, why = coalesce(EXCLUDED.why, floor_quiz.why), dish_id = coalesce(EXCLUDED.dish_id, floor_quiz.dish_id),
          active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()`, [rid, key, question, answer, JSON.stringify(wrong), why, dish, active, who.staffId]);
      return send(res, 200, { ok: true }), true;
    }
    if (id) {
      if (!active) await db.query('UPDATE floor_quiz SET active = false, updated_by = $3, updated_at = now() WHERE restaurant_id = $1 AND id = $2 AND auto_key IS NULL', [rid, id, who.staffId]);
      else await db.query('UPDATE floor_quiz SET question = $3, answer = $4, wrong = $5, why = $6, dish_id = $7, active = true, updated_by = $8, updated_at = now() WHERE restaurant_id = $1 AND id = $2 AND auto_key IS NULL', [rid, id, question, answer, JSON.stringify(wrong), why, dish, who.staffId]);
      return send(res, 200, { ok: true }), true;
    }
    const r = await db.query<{ id: string }>('INSERT INTO floor_quiz (restaurant_id, question, answer, wrong, why, dish_id, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [rid, question, answer, JSON.stringify(wrong), why, dish, who.staffId]);
    return send(res, 201, { ok: true, id: r.rows[0]!.id }), true;
  }

  if (method === 'GET' && path === '/api/floor/setup') {
    const q = <T>(sql: string, p: unknown[] = [rid]) => db.query<T>(sql, p).then((r) => r.rows);
    const [posts, devices, stations, checklists, notes, features, pushes, gelato, settings, handoffs] = await Promise.all([
      q('SELECT id, name, kind, tables, station_id AS "stationId", sort_order AS "sortOrder" FROM floor_posts WHERE restaurant_id = $1 AND active ORDER BY sort_order, name'),
      q('SELECT id, name, floor_post_id AS "postId", station_id AS "stationId", last_seen_at::text AS "lastSeen" FROM devices WHERE restaurant_id = $1 AND revoked_at IS NULL ORDER BY name'),
      q('SELECT id, name FROM stations WHERE restaurant_id = $1 AND active ORDER BY sort_order'),
      q('SELECT id, post_id AS "postId", kind, name, every_days AS "everyDays", read_only AS "readOnly" FROM floor_checklists WHERE restaurant_id = $1 AND active ORDER BY kind, sort_order, name'),
      q(`SELECT n.id, n.post_id AS "postId", n.starts_on::text AS "startsOn", n.ends_on::text AS "endsOn", n.weekdays, n.body, s.display_name AS by FROM floor_notes n LEFT JOIN staff s ON s.id = n.created_by
           WHERE n.restaurant_id = $1 AND n.ends_on >= $2 ORDER BY n.starts_on`, [rid, ctx.today]),
      q(`SELECT id, kind, recipe_id AS "recipeId", name, price, starts_on::text AS "startsOn", ends_on::text AS "endsOn", weekdays, note FROM floor_features
           WHERE restaurant_id = $1 AND (ends_on IS NULL OR ends_on >= $2) ORDER BY created_at`, [rid, ctx.today]),
      q('SELECT id, name, recipe_id AS "recipeId", why, ends_on::text AS "endsOn" FROM floor_pushes WHERE restaurant_id = $1 AND (ends_on IS NULL OR ends_on >= $2) ORDER BY created_at DESC', [rid, ctx.today]),
      q('SELECT flavors, pan_changes AS "panChanges", pans_on::text AS "pansOn", set_at::text AS "setAt" FROM floor_gelato WHERE restaurant_id = $1 ORDER BY set_at DESC LIMIT 1'),
      q('SELECT settings FROM restaurants WHERE id = $1'),
      q(`SELECT h.id::text AS id, h.day::text AS day, h.body, s.display_name AS by, p.name AS post FROM floor_handoffs h LEFT JOIN staff s ON s.id = h.written_by LEFT JOIN floor_posts p ON p.id = h.post_id
           WHERE h.restaurant_id = $1 AND h.day >= $2 ORDER BY h.written_at DESC`, [rid, addDays(ctx.today, -7)]),
    ]);
    const model = await getModel(db, rid, ctx.today);
    const { dishes } = await dishIndex(db, rid, model);
    const report = (await db.query<{ id: string; status: string; error: string | null; source: string; uploaded_at: string }>("SELECT id, status, error, source, uploaded_at::text AS uploaded_at FROM floor_reports WHERE restaurant_id = $1 AND day = $2 ORDER BY uploaded_at DESC LIMIT 1", [rid, ctx.today])).rows[0];
    return send(res, 200, {
      today: ctx.today, posts, devices, stations, checklists, notes, features, pushes, gelato: (gelato as unknown[])[0] ?? null, handoffs,
      allergyNote: js<{ allergyNote?: string }>((settings as { settings: unknown }[])[0]?.settings ?? {}).allergyNote ?? '',
      swaps: js<{ swaps?: Swap[] }>((settings as { settings: unknown }[])[0]?.settings ?? {}).swaps ?? [],
      readOnlyLists: js<{ readOnlyLists?: string[] }>((settings as { settings: unknown }[])[0]?.settings ?? {}).readOnlyLists ?? [],
      recipes: model.recipes.map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
      dishes: dishes.map((d) => ({ id: d.id, name: d.name, kind: d.kind, price: d.price, firstSold: d.firstSold, allergyLine: d.allergyLine, unchecked: d.unchecked.length })),
      ...(report ? { report: { id: report.id, status: report.status, error: report.error, source: report.source, at: report.uploaded_at } } : {}),
      canRead: Boolean(claudeOptions()),
    }), true;
  }

  if (method === 'POST' && path === '/api/floor/posts') {
    const b = await body(req);
    const name = s(b.name, 80);
    if (!name) throw new HttpError(400, 'Name the post (Patio, Dining room, Bar...).');
    const kind = ['room', 'bar', 'counter', 'host'].includes(String(b.kind)) ? String(b.kind) : 'room';
    const tables = (Array.isArray(b.tables) ? b.tables : String(b.tables ?? '').split(/[\s,]+/)).map((t: unknown) => String(t).trim().toUpperCase()).filter((t: string) => /^[A-Z]*\d+$/.test(t));
    const station = typeof b.stationId === 'string' && b.stationId ? b.stationId : null;
    if (typeof b.id === 'string' && b.id) {
      if (b.active === false) await db.query('UPDATE floor_posts SET active = false WHERE restaurant_id = $1 AND id = $2', [rid, b.id]);
      else await db.query('UPDATE floor_posts SET name = $3, kind = $4, tables = (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($5::jsonb) x), station_id = $6, sort_order = coalesce($7, sort_order) WHERE restaurant_id = $1 AND id = $2', [rid, b.id, name, kind, JSON.stringify(tables), station, Number.isInteger(b.sortOrder) ? b.sortOrder : null]);
      return send(res, 200, { ok: true, id: b.id }), true;
    }
    const r = await db.query<{ id: string }>('INSERT INTO floor_posts (restaurant_id, name, kind, tables, station_id, sort_order) VALUES ($1, $2, $3, (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($4::jsonb) x), $5, (SELECT coalesce(max(sort_order), 0) + 1 FROM floor_posts WHERE restaurant_id = $1)) RETURNING id', [rid, name, kind, JSON.stringify(tables), station]);
    return send(res, 201, { ok: true, id: r.rows[0]!.id }), true;
  }

  if (method === 'POST' && path === '/api/floor/checklists') {
    const b = await body(req);
    const kind = ['opening', 'closing', 'slow'].includes(String(b.kind)) ? String(b.kind) : undefined;
    const name = s(b.name, 200);
    const post = typeof b.postId === 'string' && b.postId ? b.postId : null;
    const every = Number(b.everyDays) > 0 ? Math.round(Number(b.everyDays)) : null;
    if (typeof b.id === 'string' && b.id && typeof b.readOnly === 'boolean' && b.name === undefined) {
      await db.query('UPDATE floor_checklists SET read_only = $3 WHERE restaurant_id = $1 AND id = $2', [rid, b.id, b.readOnly]);
      return send(res, 200, { ok: true }), true;
    }
    if (typeof b.id === 'string' && b.id) {
      if (b.active === false) await db.query('UPDATE floor_checklists SET active = false WHERE restaurant_id = $1 AND id = $2', [rid, b.id]);
      else await db.query('UPDATE floor_checklists SET name = coalesce($3, name), post_id = $4, every_days = $5 WHERE restaurant_id = $1 AND id = $2', [rid, b.id, name ?? null, post, every]);
      return send(res, 200, { ok: true }), true;
    }
    if (!kind || !name) throw new HttpError(400, 'Which list (opening, closing, when it’s slow) and what needs doing?');
    const r = await db.query<{ id: string }>('INSERT INTO floor_checklists (restaurant_id, post_id, kind, name, every_days, read_only, sort_order) VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort_order), 0) + 1 FROM floor_checklists WHERE restaurant_id = $1)) RETURNING id', [rid, post, kind, name, every, b.readOnly === true]);
    return send(res, 201, { ok: true, id: r.rows[0]!.id }), true;
  }

  if (method === 'POST' && path === '/api/floor/notes') {
    const b = await body(req);
    if (typeof b.id === 'string' && b.remove === true) { await db.query('DELETE FROM floor_notes WHERE restaurant_id = $1 AND id = $2', [rid, b.id]); return send(res, 200, { ok: true }), true; }
    const text = s(b.body, 2000);
    if (!text) throw new HttpError(400, 'Write the note.');
    const starts = day(b.startsOn) ?? ctx.today, ends = day(b.endsOn) ?? starts;
    if (ends < starts) throw new HttpError(400, 'It can’t end before it starts.');
    const wd = weekdaysOf(b.weekdays);
    const post = typeof b.postId === 'string' && b.postId ? b.postId : null;
    if (typeof b.id === 'string' && b.id) await db.query('UPDATE floor_notes SET body = $3, starts_on = $4, ends_on = $5, weekdays = (SELECT array_agg(x::int) FROM jsonb_array_elements_text($6::jsonb) x), post_id = $7 WHERE restaurant_id = $1 AND id = $2', [rid, b.id, text, starts, ends, JSON.stringify(wd ?? []), post]);
    else await db.query('INSERT INTO floor_notes (restaurant_id, post_id, starts_on, ends_on, weekdays, body, created_by) VALUES ($1, $2, $3, $4, (SELECT array_agg(x::int) FROM jsonb_array_elements_text($5::jsonb) x), $6, $7)', [rid, post, starts, ends, JSON.stringify(wd ?? []), text, who.staffId]);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && path === '/api/floor/features') {
    const b = await body(req);
    if (typeof b.id === 'string' && b.remove === true) { await db.query('DELETE FROM floor_features WHERE restaurant_id = $1 AND id = $2', [rid, b.id]); return send(res, 200, { ok: true }), true; }
    const kind = ['special', 'new', 'hidden'].includes(String(b.kind)) ? String(b.kind) : undefined;
    const recipe = typeof b.recipeId === 'string' && /^[0-9a-f-]{36}$/.test(b.recipeId) ? b.recipeId : null;
    const name = s(b.name, 120);
    if (!kind || !name) throw new HttpError(400, 'What is it, and is it a special or a new item?');
    if (kind !== 'special' && !recipe) throw new HttpError(400, 'Pick the recipe.');
    const price = b.price === undefined || b.price === null || b.price === '' ? null : Number(b.price);
    if (price !== null && !(price >= 0)) throw new HttpError(400, 'A price like 20.');
    const starts = day(b.startsOn) ?? ctx.today, ends = day(b.endsOn) ?? null;
    const wd = weekdaysOf(b.weekdays);
    if (typeof b.id === 'string' && b.id) {
      await db.query('UPDATE floor_features SET kind = $3, recipe_id = $4, name = $5, price = $6, starts_on = $7, ends_on = $8, weekdays = (SELECT array_agg(x::int) FROM jsonb_array_elements_text($9::jsonb) x), note = $10 WHERE restaurant_id = $1 AND id = $2', [rid, b.id, kind, recipe, name, price, starts, ends, JSON.stringify(wd ?? []), s(b.note, 500) ?? null]);
      return send(res, 200, { ok: true }), true;
    }
    await db.query('INSERT INTO floor_features (restaurant_id, kind, recipe_id, name, price, starts_on, ends_on, weekdays, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT array_agg(x::int) FROM jsonb_array_elements_text($8::jsonb) x), $9, $10)', [rid, kind, recipe, name, price, starts, ends, JSON.stringify(wd ?? []), s(b.note, 500) ?? null, who.staffId]);
    return send(res, 201, { ok: true }), true;
  }

  if (method === 'POST' && path === '/api/floor/pushes') {
    const b = await body(req);
    if (typeof b.id === 'string' && b.remove === true) { await db.query('DELETE FROM floor_pushes WHERE restaurant_id = $1 AND id = $2', [rid, b.id]); return send(res, 200, { ok: true }), true; }
    const name = s(b.name, 120);
    if (!name) throw new HttpError(400, 'What should they talk up?');
    const recipe = typeof b.recipeId === 'string' && /^[0-9a-f-]{36}$/.test(b.recipeId) ? b.recipeId : null;
    await db.query('INSERT INTO floor_pushes (restaurant_id, name, recipe_id, why, ends_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [rid, name, recipe, s(b.why, 300) ?? null, day(b.endsOn) ?? null, who.staffId]);
    return send(res, 201, { ok: true }), true;
  }

  if (method === 'POST' && path === '/api/floor/gelato') {
    const b = await body(req);
    const flavors = (Array.isArray(b.flavors) ? b.flavors : []).map((f: any) => ({ name: s(f?.name, 80), vegan: f?.vegan === true })).filter((f: { name?: string }) => f.name);
    if (!flavors.length) throw new HttpError(400, 'Add the flavors.');
    const pans = (Array.isArray(b.panChanges) ? b.panChanges : []).map((p: any) => ({ from: s(p?.from, 80), to: s(p?.to, 80), ...(s(p?.size, 20) ? { size: s(p?.size, 20) } : {}) })).filter((p: { from?: string; to?: string }) => p.from && p.to);
    await db.query('INSERT INTO floor_gelato (restaurant_id, flavors, pan_changes, pans_on, set_by) VALUES ($1, $2, $3, $4, $5)', [rid, JSON.stringify(flavors), JSON.stringify(pans), pans.length ? ctx.today : null, who.staffId]);
    return send(res, 200, { ok: true }), true;
  }

  if (method === 'POST' && path === '/api/floor/settings') {
    const b = await body(req);
    if (typeof b.allergyNote === 'string') await db.query("UPDATE restaurants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{allergyNote}', to_jsonb($2::text)) WHERE id = $1", [rid, s(b.allergyNote, 1000) ?? '']);
    if (Array.isArray(b.readOnlyLists)) {
      const lists = [...new Set(b.readOnlyLists.map(String).filter((k: string) => ['opening', 'closing', 'slow'].includes(k)))];
      await db.query("UPDATE restaurants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{readOnlyLists}', $2::jsonb) WHERE id = $1", [rid, JSON.stringify(lists)]);
    }
    if (Array.isArray(b.swaps)) {
      const swaps = b.swaps.map((w: any) => ({ from: String(w?.from ?? ''), to: String(w?.to ?? ''), label: s(w?.label, 60) ?? '' }))
        .filter((w: Swap) => /^[0-9a-f-]{36}$/.test(w.from) && /^[0-9a-f-]{36}$/.test(w.to) && w.from !== w.to && w.label).slice(0, 10);
      await db.query("UPDATE restaurants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{swaps}', $2::jsonb) WHERE id = $1", [rid, JSON.stringify(swaps)]);
    }
    return send(res, 200, { ok: true }), true;
  }

  // Tonight's OpenTable report: a CSV is read here and now; a printout or the digest by Claude.
  if (method === 'POST' && path === '/api/floor/reports') {
    const b = await body(req, 20 * 1024 * 1024);
    if (typeof b.csv === 'string') {
      let book: Book;
      try { book = readOpenTableCsv(b.csv); } catch (err) { throw new HttpError(400, (err as Error).message); }
      const asOf = new Date().toISOString();
      const r = await db.query<{ id: string }>("INSERT INTO floor_reports (restaurant_id, day, source, as_of, status, result, uploaded_by) VALUES ($1, $2, 'csv', now(), 'read', $3, $4) RETURNING id", [rid, ctx.today, JSON.stringify({ book, asOf }), who.staffId]);
      return send(res, 200, { id: r.rows[0]!.id, status: 'read', reservations: book.reservations.length, covers: book.covers }), true;
    }
    const mediaType = String(b.mediaType ?? ''), data = Buffer.from(String(b.data ?? ''), 'base64');
    if (!MEDIA.has(mediaType)) throw new HttpError(400, 'A PDF, a photo, or the CSV export.');
    if (data.length < 100 || data.length > 15 * 1024 * 1024) throw new HttpError(400, 'That file is too big or empty.');
    const r = await db.query<{ id: string }>("INSERT INTO floor_reports (restaurant_id, day, source, file, media_type, uploaded_by) VALUES ($1, $2, 'digest', $3, $4, $5) RETURNING id", [rid, ctx.today, data, mediaType, who.staffId]);
    void readReport(db, r.rows[0]!.id);
    return send(res, 200, { id: r.rows[0]!.id, status: 'reading', connected: Boolean(claudeOptions()) }), true;
  }
  const reportPath = path.match(/^\/api\/floor\/reports\/([0-9a-f-]{36})$/);
  if (method === 'GET' && reportPath) {
    const r = (await db.query<{ status: string; error: string | null; result: unknown }>('SELECT status, error, result FROM floor_reports WHERE restaurant_id = $1 AND id = $2', [rid, reportPath[1]])).rows[0];
    if (!r) throw new HttpError(404, 'No such report.');
    const read = r.result ? js<{ book: Book }>(r.result) : undefined;
    return send(res, 200, { status: r.status, ...(r.error ? { error: r.error } : {}), ...(read ? { reservations: read.book.reservations.length, covers: read.book.covers } : {}) }), true;
  }

  // Allergens and the names servers say.
  if (method === 'GET' && path === '/api/floor/ingredients') {
    const model = await getModel(db, rid, ctx.today);
    const used = new Map<string, Set<string>>();
    for (const r of model.recipes) for (const l of r.ingredients) if (l.item.kind === 'product' && !l.item.id.includes(':') && !l.item.id.startsWith('free-')) used.set(l.item.id, (used.get(l.item.id) ?? new Set()).add(r.name));
    const answers = new Map((await db.query<{ ingredient_id: string; allergens: string[] | null; allergens_suggested: string[] | null; guest_name: string | null; on_cards: boolean }>(
      'SELECT ingredient_id, allergens, allergens_suggested, guest_name, on_cards FROM ingredient_answers WHERE restaurant_id = $1', [rid])).rows.map((r) => [r.ingredient_id, r]));
    const cats = new Map(model.purchasing.products.map((p) => [p.externalId, p.category]));
    const ingredients = model.products.filter((p) => used.has(p.id)).map((p) => {
      const a = answers.get(p.id);
      return { id: p.id, name: p.name, category: cats.get(p.id) ?? null, usedIn: [...used.get(p.id)!].sort(), allergens: a?.allergens ?? null, suggested: a?.allergens_suggested ?? null, guestName: a?.guest_name ?? null, onCards: a?.on_cards ?? true, spoken: spokenName(p.name) };
    }).sort((x, y) => Number(x.allergens !== null) - Number(y.allergens !== null) || x.name.localeCompare(y.name));
    const preps = (await db.query<{ id: string; name: string; guest_name: string | null; recipe_type: string | null; category: string | null }>(
      "SELECT id, name, guest_name, recipe_type, category FROM recipes WHERE restaurant_id = $1 AND removed_at IS NULL AND (recipe_type ILIKE 'prep%' OR (category IS NOT NULL AND category NOT ILIKE '%menu%')) ORDER BY name", [rid])).rows;
    return send(res, 200, { ingredients, preps: preps.map((p) => ({ id: p.id, name: p.name, guestName: p.guest_name })), allergens: ALLERGEN_KEYS, canSuggest: Boolean(claudeOptions()) }), true;
  }

  // For the recipe editor: each ingredient's allergens by name, and each recipe's (worked out through its own).
  if (method === 'GET' && path === '/api/floor/allergen-map') {
    const model = await getModel(db, rid, ctx.today);
    const ra = await recipeAllergens(db, rid, model);
    return send(res, 200, {
      products: Object.fromEntries(model.products.map((p) => [p.name.toLowerCase(), { id: p.id, allergens: ra.tags.get(p.id) ?? null }])),
      recipes: Object.fromEntries([...model.book.recipes.values()].map((r) => { const a = ra.of(r.id); return [r.name.toLowerCase(), { contains: a.contains.map((c) => c.key), unchecked: a.unchecked }]; })),
      keys: ALLERGEN_KEYS,
    }), true;
  }

  const ingPath = path.match(/^\/api\/floor\/ingredients\/(.+)$/);
  if (method === 'POST' && path === '/api/floor/ingredients/suggest') {
    const opts = claudeOptions();
    if (!opts) throw new HttpError(409, 'Suggestions need ANTHROPIC_API_KEY in Render.');
    const model = await getModel(db, rid, ctx.today);
    const usedIds = new Set<string>();
    for (const r of model.recipes) for (const l of r.ingredients) if (l.item.kind === 'product' && !l.item.id.includes(':') && !l.item.id.startsWith('free-')) usedIds.add(l.item.id);
    const checked = new Set((await db.query<{ ingredient_id: string }>('SELECT ingredient_id FROM ingredient_answers WHERE restaurant_id = $1 AND (allergens IS NOT NULL OR allergens_suggested IS NOT NULL)', [rid])).rows.map((r) => r.ingredient_id));
    const cats = new Map(model.purchasing.products.map((p) => [p.externalId, p.category]));
    const todo = model.products.filter((p) => usedIds.has(p.id) && !checked.has(p.id)).slice(0, 150).map((p) => ({ id: p.id, name: p.name, ...(cats.get(p.id) ? { category: cats.get(p.id)! } : {}) }));
    if (!todo.length) return send(res, 200, { suggested: 0 }), true;
    const examples = (await db.query<{ guest_name: string }>('SELECT guest_name FROM ingredient_answers WHERE restaurant_id = $1 AND guest_name IS NOT NULL LIMIT 20', [rid])).rows.map((r) => r.guest_name);
    const r = await suggestIngredients(todo, opts, examples.length ? examples : ['Fior di Latte', 'Pomodoro Base', 'Fresh Garlic', 'Banana Pepper', 'Coppa Picante', 'Urfa Biber Spice']);
    for (const x of r.suggestions) {
      await db.query(`INSERT INTO ingredient_answers (restaurant_id, ingredient_id, allergens_suggested, guest_name, on_cards) VALUES ($1, $2, (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($3::jsonb) x), $4, $5)
        ON CONFLICT (restaurant_id, ingredient_id) DO UPDATE SET allergens_suggested = EXCLUDED.allergens_suggested, guest_name = coalesce(ingredient_answers.guest_name, EXCLUDED.guest_name),
          on_cards = CASE WHEN ingredient_answers.guest_name IS NULL THEN EXCLUDED.on_cards ELSE ingredient_answers.on_cards END, updated_at = now()`,
        [rid, x.id, JSON.stringify(x.allergens), x.guestName ?? null, x.showOnCards]);
    }
    return send(res, 200, { suggested: r.suggestions.length, left: Math.max(0, model.products.filter((p) => usedIds.has(p.id) && !checked.has(p.id)).length - todo.length) }), true;
  }
  if (method === 'POST' && ingPath) {
    const id = decodeURIComponent(ingPath[1]!);
    const b = await body(req);
    const allergens = Array.isArray(b.allergens) ? [...new Set(b.allergens.map(String).filter((k: string) => ALLERGEN_KEYS.includes(k)))] : undefined;
    const guest = typeof b.guestName === 'string' ? (b.guestName.trim().slice(0, 80) || null) : undefined;
    await db.query(`INSERT INTO ingredient_answers (restaurant_id, ingredient_id, allergens, guest_name, on_cards) VALUES ($1, $2, CASE WHEN $6 THEN (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($3::jsonb) x) END, $4, coalesce($5, true))
      ON CONFLICT (restaurant_id, ingredient_id) DO UPDATE SET allergens = CASE WHEN $6 THEN EXCLUDED.allergens ELSE ingredient_answers.allergens END,
        guest_name = CASE WHEN $7 THEN EXCLUDED.guest_name ELSE ingredient_answers.guest_name END, on_cards = coalesce($5, ingredient_answers.on_cards), updated_at = now()`,
      [rid, id, JSON.stringify(allergens ?? []), guest ?? null, typeof b.onCards === 'boolean' ? b.onCards : null, allergens !== undefined, guest !== undefined]);
    return send(res, 200, { ok: true }), true;
  }
  const prepPath = path.match(/^\/api\/floor\/preps\/([0-9a-f-]{36})$/);
  if (method === 'POST' && prepPath) {
    const b = await body(req);
    await db.query('UPDATE recipes SET guest_name = $3 WHERE restaurant_id = $1 AND id = $2', [rid, prepPath[1], typeof b.guestName === 'string' && b.guestName.trim() ? b.guestName.trim().slice(0, 80) : null]);
    return send(res, 200, { ok: true }), true;
  }

  // Wines.
  if (method === 'GET' && path === '/api/floor/wines') {
    const model = await getModel(db, rid, ctx.today);
    const { byId, dishes } = await dishIndex(db, rid, model);
    const firstSold = new Map((await db.query<{ item_name: string; first: string }>(FIRST_SOLD, [rid])).rows.map((r) => [r.item_name, r.first]));
    const lastSold = new Map((await db.query<{ catalog_id: string; last: string }>('SELECT catalog_id, max(day)::text AS last FROM pos_item_sales_daily WHERE restaurant_id = $1 AND catalog_id IS NOT NULL AND quantity > 0 GROUP BY catalog_id', [rid])).rows.map((r) => [r.catalog_id, r.last]));
    const rows = (await db.query<WineRow>(`SELECT ${WINE_COLS} FROM wine_cards WHERE restaurant_id = $1 AND active ORDER BY name`, [rid])).rows;
    const areaOf = await loadAreas(db, rid);
    const buttons = wineButtons(model, areaOf);
    const linked = new Set(rows.flatMap((w) => w.catalog_ids));
    const scans = (await db.query<{ id: string; status: string; error: string | null; uploaded_at: string }>("SELECT id, status, error, uploaded_at::text AS uploaded_at FROM wine_sheet_scans WHERE restaurant_id = $1 AND status IN ('reading', 'read', 'failed') AND uploaded_at > now() - interval '7 days' ORDER BY uploaded_at DESC", [rid])).rows;
    return send(res, 200, {
      wines: rows.map((w) => {
        const last = w.catalog_ids.map((c) => lastSold.get(c)).filter(Boolean).sort().at(-1);
        const view = wineView(w, buttons, byId, firstSold, ctx.today);
        // Here the approved pairings and the suggestions are kept apart (the board falls back to suggestions).
        return { ...view, pairings: view.pairings.filter((p) => !('suggested' in p)), suggested: w.suggested ? js<{ recipeId: string; why: string }[]>(w.suggested).map((p) => ({ ...p, name: byId.get(p.recipeId)?.name })).filter((p) => p.name) : null,
          ...(last ? { lastSold: last } : {}), stopped: Boolean(last && last < addDays(ctx.today, -30)), unlinked: !w.catalog_ids.length };
      }),
      buttons: buttons.map((b) => ({ catalogId: b.catalogId, name: b.name, price: b.price })), notCarded: [...new Set(buttons.filter((b) => !linked.has(b.catalogId) && (lastSold.get(b.catalogId) ?? '') >= addDays(ctx.today, -60)).map((b) => wineBase(b.itemName)))].sort().map((name) => ({ name })), scans, dishes: dishes.filter((d) => d.kind === 'dish').map((d) => ({ id: d.id, name: d.name })),
      canRead: Boolean(claudeOptions()),
    }), true;
  }

  if (method === 'POST' && path === '/api/floor/wines/scan') {
    const b = await body(req, 25 * 1024 * 1024);
    const mediaType = String(b.mediaType ?? ''), data = Buffer.from(String(b.data ?? ''), 'base64');
    // A cards file already written (the same fields a tech sheet is read into): straight to review.
    if (mediaType === 'application/json') {
      const wines = readCardsFile(data.toString('utf8'));
      const r = await db.query<{ id: string }>("INSERT INTO wine_sheet_scans (restaurant_id, status, file, media_type, result, uploaded_by) VALUES ($1, 'read', '\\x00'::bytea, $2, $3, $4) RETURNING id", [rid, mediaType, JSON.stringify(wines), who.staffId]);
      return send(res, 200, { id: r.rows[0]!.id, connected: true }), true;
    }
    if (!MEDIA.has(mediaType)) throw new HttpError(400, 'A PDF or photos of the tech sheets.');
    if (data.length < 100 || data.length > 20 * 1024 * 1024) throw new HttpError(400, 'That file is too big or empty.');
    const r = await db.query<{ id: string }>('INSERT INTO wine_sheet_scans (restaurant_id, file, media_type, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id', [rid, data, mediaType, who.staffId]);
    void readSheets(db, r.rows[0]!.id, rid);
    return send(res, 200, { id: r.rows[0]!.id, connected: Boolean(claudeOptions()) }), true;
  }
  const scanPath = path.match(/^\/api\/floor\/wines\/scan\/([0-9a-f-]{36})(\/save)?$/);
  if (scanPath && method === 'GET') {
    const r = (await db.query<{ status: string; error: string | null; result: unknown }>('SELECT status, error, result FROM wine_sheet_scans WHERE restaurant_id = $1 AND id = $2', [rid, scanPath[1]])).rows[0];
    if (!r) throw new HttpError(404, 'No such upload.');
    const model = await getModel(db, rid, ctx.today);
    const buttons = wineButtons(model, await loadAreas(db, rid)).map((m) => ({ catalogId: m.catalogId, name: m.itemName }));
    const read = r.result ? js<WineSheet[]>(r.result) : undefined;
    const fits = read ? buttonsForWines(read.map((w) => w.name), buttons) : [];
    const wines = read?.map((w, k) => ({ ...w, catalogIds: fits[k]! }));
    return send(res, 200, { status: r.status, ...(r.error ? { error: r.error } : {}), ...(wines ? { wines } : {}) }), true;
  }
  if (scanPath && method === 'POST' && scanPath[2]) {
    const b = await body(req, 2 * 1024 * 1024);
    const wines = (Array.isArray(b.wines) ? b.wines : []) as any[];
    // Dishes a cards file pairs it with, by name: they wait as suggestions for a manager to approve.
    const dishByName = wines.some((w) => Array.isArray(w?.dishPairings) && w.dishPairings.length)
      ? new Map((await dishIndex(db, rid, await getModel(db, rid, ctx.today))).dishes.filter((d) => d.kind === 'dish').map((d) => [d.name.toLowerCase().trim(), d.id]))
      : new Map<string, string>();
    let saved = 0;
    for (const w of wines) {
      const name = s(w?.name, 160);
      if (!name) continue;
      const catalog = (Array.isArray(w.catalogIds) ? w.catalogIds : []).map(String).slice(0, 10);
      const fields = [s(w.producer, 160), s(w.region, 80), s(w.place, 120), s(w.grapes, 160), s(w.vessel, 120), s(w.style, 20), s(w.tastingNotes, 600), s(w.story, 2000)];
      // The same wine again (a newer sheet): its card is updated, links and pairings kept.
      const r = await db.query<{ id: string }>(`INSERT INTO wine_cards (restaurant_id, name, producer, region, place, grapes, vessel, style, tasting_notes, story, facts, sheet_pairings, ingredient_pairings, catalog_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($14::jsonb) x))
        ON CONFLICT (restaurant_id, lower(name)) WHERE active DO UPDATE SET producer = EXCLUDED.producer, region = EXCLUDED.region, place = EXCLUDED.place, grapes = EXCLUDED.grapes, vessel = EXCLUDED.vessel,
          style = EXCLUDED.style, tasting_notes = EXCLUDED.tasting_notes, story = EXCLUDED.story, facts = EXCLUDED.facts, sheet_pairings = EXCLUDED.sheet_pairings, ingredient_pairings = EXCLUDED.ingredient_pairings,
          catalog_ids = CASE WHEN cardinality(EXCLUDED.catalog_ids) > 0 THEN EXCLUDED.catalog_ids ELSE wine_cards.catalog_ids END, updated_at = now() RETURNING id`,
        [rid, name, ...fields.map((f) => f ?? null), JSON.stringify((Array.isArray(w.facts) ? w.facts : []).map(String).slice(0, 12)), JSON.stringify((Array.isArray(w.menuPairings) ? w.menuPairings : []).map(String).slice(0, 12)), JSON.stringify((Array.isArray(w.ingredientPairings) ? w.ingredientPairings : []).map(String).slice(0, 12)), JSON.stringify(catalog)]);
      if (r.rows[0]) {
        saved++;
        const suggested = (Array.isArray(w.dishPairings) ? w.dishPairings : []).flatMap((p: any) => {
          const id = dishByName.get(String(p?.dish ?? '').toLowerCase().trim());
          return id ? [{ recipeId: id, why: s(p.why, 200) ?? '' }] : [];
        }).slice(0, 10);
        if (suggested.length) await db.query("UPDATE wine_cards SET suggested = $3 WHERE restaurant_id = $1 AND id = $2 AND pairings = '[]'::jsonb", [rid, r.rows[0].id, JSON.stringify(suggested)]);
      }
    }
    await db.query("UPDATE wine_sheet_scans SET status = 'saved', file = '\\x00'::bytea WHERE restaurant_id = $1 AND id = $2", [rid, scanPath[1]]);
    return send(res, 200, { saved }), true;
  }

  const winePath = path.match(/^\/api\/floor\/wines\/([0-9a-f-]{36})(?:\/(suggest|pairings))?$/);
  if (winePath && method === 'POST') {
    const id = winePath[1]!;
    const w = (await db.query<WineRow>(`SELECT ${WINE_COLS} FROM wine_cards WHERE restaurant_id = $1 AND id = $2`, [rid, id])).rows[0];
    if (!w) throw new HttpError(404, 'No such wine.');
    if (winePath[2] === 'suggest') {
      const opts = claudeOptions();
      if (!opts) throw new HttpError(409, 'Suggestions need ANTHROPIC_API_KEY in Render.');
      const model = await getModel(db, rid, ctx.today);
      const { dishes } = await dishIndex(db, rid, model);
      const menu = dishes.filter((d) => d.kind === 'dish').map((d) => ({ id: d.id, name: d.name, lines: d.lines }));
      const r = await suggestPairings({ name: w.name, ...(w.style ? { style: w.style } : {}), ...(w.grapes ? { grapes: w.grapes } : {}), ...(w.tasting_notes ? { tastingNotes: w.tasting_notes } : {}), ingredientPairings: js<string[]>(w.ingredient_pairings ?? []) }, menu, opts);
      await db.query('UPDATE wine_cards SET suggested = $3, updated_at = now() WHERE restaurant_id = $1 AND id = $2', [rid, id, JSON.stringify(r.pairings.map((p) => ({ recipeId: p.dishId, why: p.why })))]);
      return send(res, 200, { suggested: r.pairings.length }), true;
    }
    const b = await body(req, 8 * 1024 * 1024);
    if (winePath[2] === 'pairings') {
      const clean = (v: unknown) => (Array.isArray(v) ? v : []).filter((p: any) => /^[0-9a-f-]{36}$/.test(String(p?.recipeId))).map((p: any) => ({ recipeId: String(p.recipeId), why: s(p.why, 200) ?? '' }));
      const list = clean(b.pairings).filter((p, i, a) => a.findIndex((x) => x.recipeId === p.recipeId) === i).slice(0, 12);
      // Suggestions still waiting stay, unless they're now approved (or none are sent).
      const waiting = Array.isArray(b.suggested) ? clean(b.suggested).filter((p) => !list.some((x) => x.recipeId === p.recipeId)) : [];
      await db.query('UPDATE wine_cards SET pairings = $3, suggested = $4, updated_at = now() WHERE restaurant_id = $1 AND id = $2', [rid, id, JSON.stringify(list), waiting.length ? JSON.stringify(waiting) : null]);
      return send(res, 200, { ok: true }), true;
    }
    if (b.active === false) { await db.query('UPDATE wine_cards SET active = false, updated_at = now() WHERE restaurant_id = $1 AND id = $2', [rid, id]); return send(res, 200, { ok: true }), true; }
    if (Array.isArray(b.catalogIds)) await db.query('UPDATE wine_cards SET catalog_ids = (SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text($3::jsonb) x), updated_at = now() WHERE restaurant_id = $1 AND id = $2', [rid, id, JSON.stringify(b.catalogIds.map(String).slice(0, 10))]);
    if (typeof b.photo === 'string' && MEDIA.has(String(b.photoType)) && b.photoType !== 'application/pdf') {
      const img = Buffer.from(b.photo, 'base64');
      if (img.length > 100 && img.length < 4 * 1024 * 1024) await db.query('UPDATE wine_cards SET photo = $3, photo_type = $4 WHERE restaurant_id = $1 AND id = $2', [rid, id, img, b.photoType]);
    }
    const map: Record<string, string> = { name: 'name', producer: 'producer', region: 'region', place: 'place', grapes: 'grapes', vessel: 'vessel', style: 'style', tastingNotes: 'tasting_notes', story: 'story' };
    for (const [k, col] of Object.entries(map)) if (typeof b[k] === 'string') await db.query(`UPDATE wine_cards SET ${col} = $3, updated_at = now() WHERE restaurant_id = $1 AND id = $2`, [rid, id, k === 'name' ? (s(b[k], 160) ?? w.name) : (s(b[k], 2000) ?? null)]);
    if (Array.isArray(b.facts)) await db.query('UPDATE wine_cards SET facts = $3 WHERE restaurant_id = $1 AND id = $2', [rid, id, JSON.stringify(b.facts.map(String).filter(Boolean).slice(0, 12))]);
    return send(res, 200, { ok: true }), true;
  }

  throw new HttpError(404, 'Not found.');
}
