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
| `src/core/menuLinks.ts` | Links POS items to recipes by POS id, so renames never break them. Exact names link on their own; the rest become one-tap questions, best sellers first. A renamed item keeps its link but asks once whether it is still the same dish. Seasonal dishes keep one button with dated recipe versions, so each sale is costed with the version served that day and versions compare as separate dishes. Answers become aliases. |
| `src/core/margins.ts` | Real margins from POS sales: average price actually collected, food cost at today's invoice prices, food cost % (period and at today's list price), contribution per plate and in total, and each dish's role within its category judged by total money brought in (earner, sell more, minor). Staff meals and unlinked items are kept apart. |
| `src/core/modifiers.ts` | What POS modifiers do to food cost, read from their wording: "++ Extra Mozzarella" adds (portion proposed from the dishes that use it), "-- No Chorizo" takes the dish's own line off, "Sub" does both, "OTS" and cooking notes change nothing. Anything unclear is one question, most used first. Feeds theoretical usage and per-dish margins. |
| `src/core/breakdowns.ts` | Breakdowns: one thing in, several weighed things out (whole fish → fillets, trim, bones, waste). By-products are valued first and main cuts carry the rest; waste is its own output; logged breakdowns show real yields against the standard. |
| `src/core/menu.ts` | The menu: dishes on and off with dates, seasonal version switches that move the Square button to the new recipe, entries proposed from the first and last day each dish sold, and mismatch checks (new button, sold while off the menu, on the menu but not selling, a dish's own modifier buttons changing) as ranked to-do items. |
| `src/core/variance.ts` | Counts and variance: a running on-hand estimate between counts (last real count + purchases − expected use − waste), variance between real counts with skipped counts folded in, ranked by dollars with where to look and recount suggestions. |
| `src/core/ordering.ts` | Ordering: delivery days learned from invoice dates, the next order's delivery and deadline from the vendor's cutoff, recommended packs to last until the following delivery (on hand and incoming first, more safety when on hand is estimated, capped by shelf life), and drafts that can't be emailed until a manager approves them. |
| `src/core/portionCheck.ts` | Real portions from purchases: for an ingredient in only one selling dish, months of purchases against servings give the real portion (pepperoni 1.75 oz, not the card's 3). While some dishes have no card, only buying less than the card is conclusive, unless a manager says the ingredient goes nowhere else. |
| `src/core/prep.ts` | Prep batches with use-by dates from shelf life, the nightly count sheet (walk-in order, oldest first, expiring batches flagged), and one-tap discards that log waste. |
| `src/core/forecast.ts` | Sales forecast per menu item from the same weekday in recent weeks, open days only; specials only on days they're available; a reservation adjustment. |
| `src/core/prepList.ts` | Tomorrow's prep list: forecast demand + buffer − usable on hand, in whole batches, with sub-preps (chopped garlic for the sauce) listed first. Bigger buffer when the count was skipped. |
| `src/core/stationLists.ts` | Station prep lists as kitchens run them: par for the busiest day scaled to each day's usual sales, to make = par minus the nightly count, with the reason shown. |
| `src/core/stationPrep.ts` | Prep by station, live: line cooks see their station, sous chefs and up see every station with work left and projected finish against service. Learns task times from check-offs (start taps or gaps, batch check-offs left out), shows suggested vs actual order and per-cook pace on the same task. |
| `src/core/prepChecks.ts` | Surplus-special suggestions for batches that won't sell through before their use-by, and the daily prep check ranked by dollar value. |
| `src/connectors/marginedge.ts` | Reads a MarginEdge export into vendors, products, pack sizes, invoices and price history, and runs the invoice self-checks (line math, invoice totals, unknown units, missing pack sizes). |
| `src/core/purchasing.ts` | What the restaurant buys, in the app's own terms: suppliers, purchased products (the ingredient list), invoices with lines, price points, and recent prices blended by what was bought. Every way an invoice comes in lands in these shapes. |
| `src/core/recipeCards.ts` | Recipe cards (how the kitchen book holds a recipe) and how a set of them links up into nested, costed recipes, with yield %, several yields and shelf life. |
| `src/connectors/marginedgeRecipes.ts` | Reads MarginEdge's printed recipe cards and costing PDFs (text, or OCR when the PDF fonts are garbled) into recipe cards. |
| `src/connectors/square.ts` | Square's catalog (one menu item per variation, staff-meal buttons spotted) and Reporting API item sales, in the neutral shapes above. |
| `scripts/marginedge-export.mjs` | One-off export from MarginEdge's read-only API, run on the restaurant's own computer. The API key is typed at a hidden prompt and never saved. |
| `src/server/db.ts` | Database interface (driver kept at the edge: `pg` in production) and the migration runner over `db/migrations`. |
| `src/server/auth.ts` | Sign-ins: PIN on an enrolled iPad for the kitchen, email and password for managers; scrypt hashes, hashed session and device tokens, 5-try lockout. |
| `src/server/app.ts` | JSON API on node:http: health, first-owner setup, sign-in and out, iPad enrollment, PINs. |
| `src/connectors/squareApi.ts` | Square REST client, read-only by construction: locations, catalog, team and job titles, Reporting API queries with paging and retries. |
| `src/server/squareSync.ts` | Nightly copy from Square into the database: location, catalog, team (job titles become role levels to confirm), item and modifier sales by day; recent days are refreshed. |
| `src/connectors/marginedgeApi.ts` | MarginEdge read-only API client (the export script's calls, from the server): incremental invoice refresh, pack sizes fetched once per vendor item. |
| `src/server/marginedgeSync.ts` | Nightly copy from MarginEdge into the database, in the export's shape. |
| `src/server/model.ts` | Rebuilds the restaurant from stored data (MarginEdge, Square, recipe cards, managers' answers) for the screens; cached until the next sync or saved answer. Also the kitchen book: recipe cards and answers, with history. |
| `src/server/book.ts` | The kitchen book in its own tables: recipes with permanent ids and a line per ingredient, every save kept as a dated version (history, and costing a past period with the recipe as it was), and managers' answers (dish links, menu status, ingredient answers, modifier answers). Moves the old single-document book over on first read, checked recipe by recipe. |
| `src/server/views.ts` | What the Margins and Menu screens show, shaped from the model. |
| `src/server/scheduler.ts` | Runs the Square and MarginEdge syncs after 4 am in the restaurant's time zone, from inside the web app. |
| `web/` | The web app: first-time setup, manager sign-in, kitchen iPad name-and-PIN sign-in, Settings (Square sync, team PINs, iPad setup). Plain modules, no build step. |
| `src/server/prep.ts` | Prep lists over HTTP: nightly count, chef review and approval, next-day check-offs, cleaning checklists, editing lists, importing them. |
| `src/server/http.ts` | Small HTTP helpers shared by the routes. |
| `src/server/plans.ts` | Dishes coming to the menu, planned before they sell: their preps join station lists the day before the start, the replaced dish's own preps come off. |
| `src/core/onlineMenu.ts` | The online menu: every Square item with whether it's sold online, whether it counts as a pizza (from its category unless set), sold out tonight, and how each option shows online (shown, hidden, or always on, like "partially cooked"). Flags a published item whose required choice has nothing left to pick. |
| `src/core/pickupWindows.ts` | Online pickup windows: 20 minutes each from 5 to 9 pm, each taking so many pizzas from a weekly plan, with a date's own limits on top. An order goes in the first window with room for all its pizzas; more than any window takes means a phone call. |
| `src/server/online.ts` | Online ordering settings over HTTP (managers): publishing items, option modes, the weekly window plan, and a date's own limits or closing the rest of tonight. Shown on the Menu screen under Online and Pickup windows. |
| `src/core/onlineCart.ts` | The customer's menu and cart: published items with the options offered online, always-on options listed as notes. A cart is re-priced from the catalog and refused by name if something isn't offered any more. |
| `src/connectors/squareCheckout.ts` | Square writes for online orders only: a scheduled pickup order, and its payment from the card token the Web Payments SDK made in the browser. Card numbers never reach the app. |
| `src/server/onlineCheckout.ts` | Customer ordering at `/order` (public): the menu, tonight's windows, checkout that holds the pizzas for 10 minutes and creates the Square order, and payment. |
| `web/order.html`, `order.js`, `order.css` | The customer ordering page: menu, cart with the earliest pickup, checkout with the pickup time and the partially-cooked confirmation, Square card form. |
| `src/server/main.ts` | Starts the app: connect, migrate, listen. |
| `render.yaml` | Render Blueprint: web service plus PostgreSQL. Secrets are entered in the Render dashboard. |
| `db/migrations/` | PostgreSQL schema, applied in order at startup (`0001_schema.sql` is the base; later files add to it) for restaurants, staff, stations and roles, vendors, products, invoices, price history, recipes and breakdowns, menus, POS links with components, modifier effects, prep batches and timed prep tasks, counts, waste, to-do items and questions. Built for many restaurants: every reference includes the restaurant. |

## Running checks

Needs Node.js 22.18 or newer (runs TypeScript directly) and, for the schema check, PostgreSQL 16+.

```sh
npm test                    # unit tests (Node's built-in test runner)
npm install && npm run typecheck
scripts/check-schema.sh     # loads the schema into a throwaway database and checks its rules
```

## Principles

Every feature should give the person using it more than it asks of them that same day. See the design doc for the full list.
