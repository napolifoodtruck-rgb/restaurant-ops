/**
 * What the Floor asks Claude for: tonight's reservations from an OpenTable report, wine cards from
 * producers' tech sheets, allergens and spoken names for ingredients, and wine pairings for dishes.
 * Each answer is tidied before anything is kept; suggestions wait for a manager.
 */

import { askWithTool, number, text, texts, type ClaudeOptions, type ClaudePage } from './claude.ts';
import { clock, tablesOf, type Book, type Reservation } from '../core/reservations.ts';
import { ALLERGEN_KEYS } from '../core/allergens.ts';

type Usage = { usage: { input: number; output: number }; model: string };

// ---------------------------------------------------------------- reservations

const RESERVATIONS_TOOL = {
  name: 'record_reservations',
  description: 'Record every reservation on this OpenTable report, as printed.',
  input_schema: {
    type: 'object',
    required: ['reservations'],
    properties: {
      date: { type: 'string', description: 'The shift date, YYYY-MM-DD.' },
      generatedAt: { type: 'string', description: 'When the report was made or the email sent, as printed (e.g. "Oct 7, 2026, 4:18 PM").' },
      totalCovers: { type: 'number' },
      reservations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['time', 'partySize', 'name'],
          properties: {
            time: { type: 'string', description: 'e.g. "5:30 PM"' },
            partySize: { type: 'number' },
            name: { type: 'string' },
            tables: { type: 'array', items: { type: 'string' }, description: 'Every table, e.g. ["T37","T36"]; "T2+" as printed.' },
            vip: { type: 'boolean', description: 'Starred, or a special relationship / regular.' },
            vipNote: { type: 'string', description: 'The special relationship note.' },
            occasions: { type: 'array', items: { type: 'string' }, description: 'Tags and special events: Birthday, Anniversary, Business Meal, Special Occasion...' },
            requests: { type: 'string', description: 'Guest requests.' },
            notes: { type: 'string', description: 'General notes or visit notes about the guest.' },
            visitsLastYear: { type: 'number' },
            lastVisit: { type: 'string', description: 'YYYY-MM-DD' },
            spendPerCover: { type: 'number' },
            cancelled: { type: 'boolean' },
          },
        },
      },
    },
  },
};

/** An OpenTable report (the pre-shift digest email or the reservations printout), as tonight's book. */
export async function readReservations(pages: readonly ClaudePage[], opts: ClaudeOptions): Promise<{ book: Book; generatedAt?: string } & Usage> {
  const prompt = [
    'This is an OpenTable report for a restaurant shift: either the "Pre-shift Digest" email or the printed reservations list. Record it with record_reservations.',
    'Include every reservation once, in order. Copy names, tables and notes as printed. Leave out phone numbers.',
    'A star next to a name, a "special relationship" note or a VIP mark means vip. Guest details like "12 Visits last year, Last visit: Sep 9, 2026, $54.56 average spend per cover" go in visitsLastYear, lastVisit and spendPerCover.',
    'Seating preferences (patio, dining room, outdoor booked) are not notes: leave them out.',
  ].join('\n');
  const a = await askWithTool<any>(pages, prompt, RESERVATIONS_TOOL, { ...opts, maxTokens: 12000 }, 'The report reader');
  const reservations: Reservation[] = [];
  for (const r of Array.isArray(a.input?.reservations) ? a.input.reservations : []) {
    const time = clock(text(r?.time) ?? '');
    const name = text(r?.name);
    if (!time || !name || r?.cancelled === true) continue;
    const t = tablesOf(texts(r.tables).join(','));
    const visits = number(r.visitsLastYear), spend = number(r.spendPerCover), last = text(r.lastVisit);
    reservations.push({
      time, name, partySize: number(r.partySize) ?? 0, tables: t.tables, ...(t.combined ? { combined: true } : {}),
      occasions: texts(r.occasions),
      ...(r.vip === true ? { vip: true } : {}), ...(text(r.vipNote) ? { vipNote: text(r.vipNote)! } : {}),
      ...(text(r.requests) ? { requests: text(r.requests)! } : {}), ...(text(r.notes) ? { notes: text(r.notes)! } : {}),
      ...(visits !== undefined ? { visitsLastYear: visits } : {}), ...(last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? { lastVisit: last } : {}), ...(spend !== undefined ? { spendPerCover: spend } : {}),
    });
  }
  const date = text(a.input?.date);
  const covers = number(a.input?.totalCovers);
  return {
    book: { ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { day: date } : {}), ...(covers !== undefined ? { covers } : { covers: reservations.reduce((s, r) => s + r.partySize, 0) }), reservations },
    ...(text(a.input?.generatedAt) ? { generatedAt: text(a.input.generatedAt)! } : {}),
    usage: a.usage, model: a.model,
  };
}

// ---------------------------------------------------------------- wine tech sheets

export interface WineSheet {
  name: string; producer?: string; region?: string; place?: string; grapes?: string; vessel?: string; style?: string;
  tastingNotes?: string; story?: string; facts: string[]; menuPairings: string[]; ingredientPairings: string[];
}

const WINES_TOOL = {
  name: 'record_wines',
  description: 'Record each wine described in these tech sheets.',
  input_schema: {
    type: 'object',
    required: ['wines'],
    properties: {
      wines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'The wine as it would be listed: producer and wine, e.g. "Tenuta degli Ultimi Tramonto Sparkling Rosé". Read it from the label in the photo if the text doesn’t say.' },
            producer: { type: 'string' },
            region: { type: 'string', description: 'The Italian region in Italian: Toscana, Piemonte, Veneto, Sicilia, Puglia, Friuli-Venezia Giulia...' },
            place: { type: 'string', description: 'Town or area, e.g. "Gambassi Terme".' },
            grapes: { type: 'string' },
            vessel: { type: 'string' },
            style: { type: 'string', enum: ['red', 'white', 'rosé', 'sparkling', 'orange', 'dessert'] },
            tastingNotes: { type: 'string' },
            story: { type: 'string', description: 'The story worth telling at the table, a few sentences, in the sheet’s words.' },
            facts: { type: 'array', items: { type: 'string' } },
            menuPairings: { type: 'array', items: { type: 'string' }, description: 'Dishes on the restaurant’s menu the sheet names.' },
            ingredientPairings: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

export async function readWineSheets(pages: readonly ClaudePage[], opts: ClaudeOptions, wineList: readonly string[] = []): Promise<{ wines: WineSheet[] } & Usage> {
  const prompt = [
    'These are tech sheets for wines on an Italian restaurant’s list, one or more per page. Record each wine with record_wines.',
    'Copy the sheet’s own words for tasting notes, pairings and facts; don’t invent anything the sheet doesn’t say, except the region and style when the producer or grape make them clear.',
    wineList.length ? `Wines on the restaurant's list (use the matching name when a sheet is one of these): ${wineList.join('; ')}.` : '',
  ].filter(Boolean).join('\n');
  const a = await askWithTool<any>(pages, prompt, WINES_TOOL, { ...opts, maxTokens: 12000 }, 'The tech sheet reader');
  const wines: WineSheet[] = [];
  for (const w of Array.isArray(a.input?.wines) ? a.input.wines : []) {
    const name = text(w?.name);
    if (!name) continue;
    const o: WineSheet = { name, facts: texts(w.facts), menuPairings: texts(w.menuPairings), ingredientPairings: texts(w.ingredientPairings) };
    for (const k of ['producer', 'region', 'place', 'grapes', 'vessel', 'style', 'tastingNotes', 'story'] as const) { const v = text(w[k]); if (v) o[k] = v; }
    wines.push(o);
  }
  return { wines, usage: a.usage, model: a.model };
}

// ---------------------------------------------------------------- allergens and spoken names

export interface IngredientSuggestion { id: string; allergens: string[]; guestName?: string; showOnCards: boolean }

const ALLERGENS_TOOL = {
  name: 'record_ingredients',
  description: 'For each ingredient: its allergens, the name servers say at the table, and whether it belongs on a menu card.',
  input_schema: {
    type: 'object',
    required: ['ingredients'],
    properties: {
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'allergens', 'showOnCards'],
          properties: {
            id: { type: 'string' },
            allergens: { type: 'array', items: { type: 'string', enum: [...ALLERGEN_KEYS] } },
            guestName: { type: 'string', description: 'How a server says it to a guest: "Fior di Latte", "Calabrian Chili", "San Marzano Tomatoes". Omit when the name already reads well.' },
            showOnCards: { type: 'boolean', description: 'False for things a guest wouldn’t expect listed: salt, oil for cooking, water, yeast, flour in a dough, sugar in a syrup.' },
          },
        },
      },
    },
  },
};

/** Suggestions for ingredients nobody has checked yet. A manager confirms each. */
export async function suggestIngredients(items: readonly { id: string; name: string; category?: string }[], opts: ClaudeOptions, examples: readonly string[] = []): Promise<{ suggestions: IngredientSuggestion[] } & Usage> {
  const prompt = [
    'These are ingredients an Italian pizzeria buys (names as they appear on invoices). For each, record with record_ingredients:',
    `- allergens, from this list only: milk (any dairy), egg, wheat (gluten: wheat, barley, rye, spelt; malt), soy, peanut, treenut (almond, hazelnut, pistachio, walnut, pine nut...), sesame, fish, shellfish (crustaceans and molluscs), allium (garlic, onion, shallot, leek, chive, scallion). Think about what a prepared product usually contains (salami often has garlic; pesto has pine nuts and cheese; some sausages have milk powder). If it commonly contains an allergen, include it.`,
    '- guestName: the name a server would say, in the style of the restaurant’s cards.',
    '- showOnCards.',
    examples.length ? `How the restaurant writes its cards (for the style): ${examples.join('; ')}.` : '',
    `Ingredients:\n${items.map((i) => `${i.id}: ${i.name}${i.category ? ` (${i.category})` : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n');
  const a = await askWithTool<any>([], prompt, ALLERGENS_TOOL, { ...opts, maxTokens: 16000 }, 'The ingredient helper');
  const ids = new Set(items.map((i) => i.id));
  const suggestions = (Array.isArray(a.input?.ingredients) ? a.input.ingredients : [])
    .filter((s: any) => ids.has(String(s?.id)))
    .map((s: any): IngredientSuggestion => ({ id: String(s.id), allergens: texts(s.allergens).filter((k) => ALLERGEN_KEYS.includes(k)), ...(text(s.guestName) ? { guestName: text(s.guestName)! } : {}), showOnCards: s.showOnCards !== false }));
  return { suggestions, usage: a.usage, model: a.model };
}

// ---------------------------------------------------------------- pairings

const PAIRINGS_TOOL = {
  name: 'record_pairings',
  description: 'The menu dishes this wine pairs best with, and why in one short line a server can say.',
  input_schema: {
    type: 'object',
    required: ['pairings'],
    properties: {
      pairings: {
        type: 'array',
        items: { type: 'object', required: ['dishId', 'why'], properties: { dishId: { type: 'string' }, why: { type: 'string' } } },
      },
    },
  },
};

export async function suggestPairings(wine: { name: string; style?: string; grapes?: string; tastingNotes?: string; ingredientPairings?: string[] }, dishes: readonly { id: string; name: string; lines: string[] }[], opts: ClaudeOptions): Promise<{ pairings: { dishId: string; why: string }[] } & Usage> {
  const prompt = [
    `Wine: ${wine.name}${wine.style ? ` (${wine.style})` : ''}${wine.grapes ? `, ${wine.grapes}` : ''}. ${wine.tastingNotes ? `Tasting notes: ${wine.tastingNotes}.` : ''} ${wine.ingredientPairings?.length ? `The producer pairs it with: ${wine.ingredientPairings.join(', ')}.` : ''}`,
    'Pick the 3 to 5 dishes on this menu it pairs best with, from their ingredients, and say why in one short line a server can say at the table. Record with record_pairings.',
    `Menu:\n${dishes.map((d) => `${d.id}: ${d.name} — ${d.lines.join(', ')}`).join('\n')}`,
  ].join('\n');
  const a = await askWithTool<any>([], prompt, PAIRINGS_TOOL, { ...opts, maxTokens: 2000 }, 'The pairing helper');
  const ids = new Set(dishes.map((d) => d.id));
  const pairings = (Array.isArray(a.input?.pairings) ? a.input.pairings : []).filter((p: any) => ids.has(String(p?.dishId)) && text(p?.why)).slice(0, 6).map((p: any) => ({ dishId: String(p.dishId), why: text(p.why)! }));
  return { pairings, usage: a.usage, model: a.model };
}
