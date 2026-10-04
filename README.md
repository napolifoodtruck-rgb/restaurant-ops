# Restaurant ops

A restaurant operations system that runs on top of Square's POS: recipes, inventory, prep, ordering, FOH performance and server briefings in one web app for every device. Square keeps the POS, payments and hardware; this system adds everything around them.

The full design lives in the design doc: [Restaurant Management System: Design](https://claude.ai/code/artifact/a89e16b4-2bf4-4a76-9364-f3a5b5dcc79a).

## What's here so far

Back-of-house foundation:

| Path | What it is |
| --- | --- |
| `src/core/units.ts` | Kitchen units and conversions: standard units, spellings like "lbs" or "#", per-item units like "sixth pan", and weight ↔ volume ↔ count conversions that name the missing fact when they can't be done. |
| `src/core/recipes.ts` | The recipe engine: nested recipes (garlic → chopped garlic → vodka sauce → dish), yields, breakdown to raw products, cost roll-up, food cost %, loop detection. Gaps become issues, never crashes. |
| `src/core/sales.ts` | Turns POS sales (items and modifiers) into theoretical usage, ranks menu items still missing a recipe, and reports how much of sales recipes cover. |
| `src/core/prep.ts` | Prep batches with use-by dates from shelf life, the nightly count sheet (walk-in order, oldest first, expiring batches flagged), and one-tap discards that log waste. |
| `src/core/forecast.ts` | Sales forecast per menu item from the same weekday in recent weeks, open days only; specials only on days they're available; a reservation adjustment. |
| `src/core/prepList.ts` | Tomorrow's prep list: forecast demand + buffer − usable on hand, in whole batches, with sub-preps (chopped garlic for the sauce) listed first. Bigger buffer when the count was skipped. |
| `src/core/prepChecks.ts` | Surplus-special suggestions for batches that won't sell through before their use-by, and the daily prep check ranked by dollar value. |
| `src/connectors/marginedge.ts` | Reads a MarginEdge export into vendors, products, pack sizes, invoices and price history, and runs the invoice self-checks (line math, invoice totals, unknown units, missing pack sizes). |
| `scripts/marginedge-export.mjs` | One-off export from MarginEdge's read-only API, run on the restaurant's own computer. The API key is typed at a hidden prompt and never saved. |
| `db/schema.sql` | PostgreSQL schema for restaurants, staff, vendors, products, invoices, price history, recipes, menu links, prep batches, counts, waste, to-do items and questions. Built for many restaurants: every reference includes the restaurant. |

## Running checks

Needs Node.js 22.18 or newer (runs TypeScript directly) and, for the schema check, PostgreSQL 16+.

```sh
npm test                    # unit tests (Node's built-in test runner)
npm install && npm run typecheck
scripts/check-schema.sh     # loads the schema into a throwaway database and checks its rules
```

## Principles

Every feature should give the person using it more than it asks of them that same day. See the design doc for the full list.
