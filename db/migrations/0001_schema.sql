-- Restaurant operations: back-of-house schema (PostgreSQL 16+)
--
-- Built for many restaurants from the start: every table carries restaurant_id,
-- and references between tables include it (composite foreign keys), so a row
-- can never point at another restaurant's data.
--
-- Quantities are numeric with an explicit unit; conversions follow
-- src/core/units.ts. Money is numeric(12,4) dollars, so per-unit costs like
-- $0.0469 per oz keep their precision.

CREATE TABLE restaurants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  timezone            text NOT NULL DEFAULT 'America/New_York',
  pos_system          text NOT NULL DEFAULT 'square' CHECK (pos_system IN ('square', 'toast')),
  pos_merchant_id     text,
  pos_location_id     text,
  -- House conventions, learned from a restaurant's first answers rather than written into the code:
  -- {"staffMealPattern": "\\bshift\\b", "extraShare": 0.5, "modifierWords": {...}}.
  settings            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pos_system, pos_merchant_id, pos_location_id)
);

-- People ----------------------------------------------------------------------

CREATE TABLE staff (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  pos_team_member_id  text,                       -- Square team member id
  display_name        text NOT NULL,
  job_title           text,                       -- from Square; sets default permissions
  pin_hash            text,                       -- our own PIN; Square passcodes aren't available
  extra_permissions   text[] NOT NULL DEFAULT '{}',
  removed_permissions text[] NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, pos_team_member_id)
);

-- Default permissions for each job title, e.g. 'Line Cook' → {prep.view, prep.log, counts.prep}.
-- The role level sets what a job title sees beyond its own station: a line cook sees their
-- station; a sous chef or chef sees every station live; managers and owners also see trends.
CREATE TABLE job_title_permissions (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  job_title           text NOT NULL,
  permissions         text[] NOT NULL DEFAULT '{}',
  role_level          text NOT NULL DEFAULT 'line' CHECK (role_level IN ('line', 'lead', 'sous', 'chef', 'manager', 'owner')),
  PRIMARY KEY (restaurant_id, job_title)
);

-- Stations ----------------------------------------------------------------------
-- Where work happens: pizza, sauté, garde manger, pastry, bar, prep. Prep lists, counts and
-- to-do items are built per station, so whoever works a station tonight sees its work.

CREATE TABLE stations (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

-- Which stations a job title works by default (a Square job title such as 'Pizza Cook').
CREATE TABLE job_title_stations (
  restaurant_id       uuid NOT NULL,
  job_title           text NOT NULL,
  station_id          uuid NOT NULL,
  PRIMARY KEY (restaurant_id, job_title, station_id),
  FOREIGN KEY (restaurant_id, job_title) REFERENCES job_title_permissions (restaurant_id, job_title) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE CASCADE
);

-- Who works which station on a given day: from the Square schedule, or set by hand.
CREATE TABLE station_assignments (
  restaurant_id       uuid NOT NULL,
  business_date       date NOT NULL,
  station_id          uuid NOT NULL,
  staff_id            uuid NOT NULL,
  source              text NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule', 'manual')),
  PRIMARY KEY (restaurant_id, business_date, station_id, staff_id),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, staff_id) REFERENCES staff (restaurant_id, id) ON DELETE CASCADE
);

-- Vendors and products ---------------------------------------------------------

CREATE TABLE vendors (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,
  ordering_method     text NOT NULL DEFAULT 'email' CHECK (ordering_method IN ('email', 'phone', 'website', 'other')),
  order_email         text,
  minimum_order       numeric(12,2),
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id)
);

-- Delivery days are inferred from invoice dates; cutoffs are confirmed by a manager.
CREATE TABLE vendor_delivery_days (
  restaurant_id       uuid NOT NULL,
  vendor_id           uuid NOT NULL,
  delivery_weekday    smallint NOT NULL CHECK (delivery_weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  cutoff_weekday      smallint CHECK (cutoff_weekday BETWEEN 0 AND 6),
  cutoff_time         time,
  source              text NOT NULL DEFAULT 'inferred' CHECK (source IN ('inferred', 'confirmed')),
  PRIMARY KEY (vendor_id, delivery_weekday),
  FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id) ON DELETE CASCADE
);

CREATE TABLE products (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,
  category            text,                       -- protein, produce, dairy, dry goods, alcohol...
  base_unit           text NOT NULL,              -- unit usage and stock are tracked in
  grams_per_ml        numeric CHECK (grams_per_ml > 0),
  grams_per_each      numeric CHECK (grams_per_each > 0),
  -- How often to count: must_count (high value), occasional, or expensed when purchased.
  count_policy        text NOT NULL DEFAULT 'occasional' CHECK (count_policy IN ('must_count', 'occasional', 'expense_on_purchase')),
  preferred_vendor_id uuid,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, preferred_vendor_id) REFERENCES vendors (restaurant_id, id) ON DELETE SET NULL (preferred_vendor_id)
);

-- Each vendor's own item, matched to one of our products ("ONION YEL JBO 50#" → Yellow onions).
CREATE TABLE vendor_items (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  vendor_id           uuid NOT NULL,
  product_id          uuid,                       -- null until matched
  vendor_sku          text,
  description         text NOT NULL,
  pack_amount         numeric CHECK (pack_amount > 0),   -- 50 (lb) in a case
  pack_unit           text,
  match_source        text CHECK (match_source IN ('suggested', 'confirmed')),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (vendor_id, vendor_sku),
  FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id) ON DELETE SET NULL (product_id)
);

-- Invoices -----------------------------------------------------------------------

CREATE TABLE invoices (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  vendor_id           uuid,
  invoice_number      text,
  invoice_date        date,
  total               numeric(12,2),
  file_path           text,                       -- the original photo or PDF
  status              text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'needs_review', 'complete')),
  uploaded_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id),
  FOREIGN KEY (restaurant_id, uploaded_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (uploaded_by)
);

CREATE TABLE invoice_lines (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  line_number         integer NOT NULL,
  raw_description     text NOT NULL,
  vendor_sku          text,
  vendor_item_id      uuid,
  quantity            numeric,
  unit_price          numeric(12,4),
  line_total          numeric(12,2),
  match_confidence    numeric CHECK (match_confidence BETWEEN 0 AND 1),
  -- auto: passed every check. needs_review: a person should look. uncertain: flagged but nobody reviewed.
  review_status       text NOT NULL DEFAULT 'auto' CHECK (review_status IN ('auto', 'needs_review', 'confirmed', 'uncertain')),
  review_reason       text,                       -- e.g. "price up 30% from last invoice"
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (invoice_id, line_number),
  FOREIGN KEY (restaurant_id, invoice_id) REFERENCES invoices (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, vendor_item_id) REFERENCES vendor_items (restaurant_id, id)
);

-- Price history, one row per product per invoice line.
CREATE TABLE product_prices (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  product_id          uuid NOT NULL,
  vendor_id           uuid,
  invoice_line_id     uuid,
  price               numeric(12,4) NOT NULL CHECK (price >= 0),
  per_amount          numeric NOT NULL CHECK (per_amount > 0),
  per_unit            text NOT NULL,
  effective_date      date NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id),
  FOREIGN KEY (restaurant_id, invoice_line_id) REFERENCES invoice_lines (restaurant_id, id) ON DELETE SET NULL (invoice_line_id)
);
CREATE INDEX product_prices_latest ON product_prices (restaurant_id, product_id, effective_date DESC);

-- Recipes --------------------------------------------------------------------------

CREATE TABLE recipes (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,
  -- breakdown: one thing in, several weighed things out (a whole fish into fillets, trim,
  -- bones and waste); its outputs are in breakdown_outputs, its input in recipe_ingredients.
  kind                text NOT NULL CHECK (kind IN ('prep', 'dish', 'modifier', 'breakdown')),
  station_id          uuid,                       -- the station that makes it (prep lists go there)
  yield_amount        numeric NOT NULL CHECK (yield_amount > 0),
  yield_unit          text NOT NULL,
  grams_per_ml        numeric CHECK (grams_per_ml > 0),
  grams_per_each      numeric CHECK (grams_per_each > 0),
  shelf_life_days     numeric CHECK (shelf_life_days > 0),
  -- draft: proposed by the system. partial: main components only. complete: confirmed by the chef.
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'partial', 'complete')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  -- Dishes and modifiers yield portions.
  CHECK (kind IN ('prep', 'breakdown') OR yield_unit = 'each'),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE SET NULL (station_id)
);

CREATE TABLE recipe_ingredients (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  recipe_id           uuid NOT NULL,
  product_id          uuid,
  sub_recipe_id       uuid,
  amount              numeric NOT NULL,           -- negative only in modifiers (e.g. "no parmesan")
  unit                text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CHECK (num_nonnulls(product_id, sub_recipe_id) = 1),
  CHECK (sub_recipe_id IS DISTINCT FROM recipe_id),  -- longer loops are caught by the recipe engine
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sub_recipe_id) REFERENCES recipes (restaurant_id, id)
);
CREATE INDEX recipe_ingredients_recipe ON recipe_ingredients (restaurant_id, recipe_id);

-- Item-specific units: "sixth pan" = 2 qt of aioli, "case" = 50 lb of onions.
CREATE TABLE custom_units (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  product_id          uuid,
  recipe_id           uuid,
  name                text NOT NULL,
  amount              numeric NOT NULL CHECK (amount > 0),
  unit                text NOT NULL,
  PRIMARY KEY (id),
  CHECK (num_nonnulls(product_id, recipe_id) = 1),
  UNIQUE NULLS NOT DISTINCT (product_id, recipe_id, name),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE
);

-- What a breakdown yields, as shares of the input's weight. The input's cost is split by
-- valuing by-products first (bones at $0/lb, trim at what it's worth to you) and letting the
-- main cuts carry the rest, in proportion to weight × relative value. Waste is an output
-- too, so it shows instead of hiding in a yield percentage.
CREATE TABLE breakdown_outputs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  recipe_id           uuid NOT NULL,              -- the breakdown
  name                text NOT NULL,              -- 'Fillets', 'Trim', 'Bones & heads', 'Waste'
  output_product_id   uuid,                       -- what it becomes in inventory
  output_recipe_id    uuid,
  standard_share      numeric NOT NULL CHECK (standard_share > 0 AND standard_share <= 1),
  valuation           text NOT NULL CHECK (valuation IN ('main', 'fixed', 'waste')),
  relative_value      numeric NOT NULL DEFAULT 1 CHECK (relative_value > 0),  -- among main cuts
  fixed_price         numeric(12,4) CHECK (fixed_price >= 0),                 -- per fixed_per_unit
  fixed_per_unit      text,
  sort_order          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (recipe_id, name),
  CHECK (num_nonnulls(output_product_id, output_recipe_id) <= 1),
  CHECK (valuation <> 'waste' OR num_nonnulls(output_product_id, output_recipe_id) = 0),
  CHECK (valuation <> 'fixed' OR (fixed_price IS NOT NULL AND fixed_per_unit IS NOT NULL)),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, output_product_id) REFERENCES products (restaurant_id, id),
  FOREIGN KEY (restaurant_id, output_recipe_id) REFERENCES recipes (restaurant_id, id)
);

-- Each real breakdown, weighed: actual yields against the standard ("fillet yield fell to 38%").
CREATE TABLE breakdown_logs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  recipe_id           uuid NOT NULL,
  input_amount        numeric NOT NULL CHECK (input_amount > 0),
  input_unit          text NOT NULL,
  invoice_line_id     uuid,                       -- the delivery it came from, for supplier comparisons
  performed_by        uuid,
  performed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, invoice_line_id) REFERENCES invoice_lines (restaurant_id, id) ON DELETE SET NULL (invoice_line_id),
  FOREIGN KEY (restaurant_id, performed_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (performed_by)
);

CREATE TABLE breakdown_log_outputs (
  restaurant_id       uuid NOT NULL,
  log_id              uuid NOT NULL,
  output_id           uuid NOT NULL,
  amount              numeric NOT NULL CHECK (amount >= 0),
  unit                text NOT NULL,
  PRIMARY KEY (log_id, output_id),
  FOREIGN KEY (restaurant_id, log_id) REFERENCES breakdown_logs (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, output_id) REFERENCES breakdown_outputs (restaurant_id, id) ON DELETE CASCADE
);

-- Menus ---------------------------------------------------------------------------------
-- The app's menu is the source of truth for the food: which dishes are on, which recipe
-- version, since when. Square stays read-only and supplies buttons, prices and sales;
-- anything that doesn't line up becomes a to-do item.

CREATE TABLE menus (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,              -- 'Dinner', 'Brunch', 'Bar', 'Tasting'
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

-- A dish on a menu for a stretch of time. Seasonal versions are separate entries (and
-- separate recipes), so they never overlap and can be compared fairly.
CREATE TABLE menu_entries (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  menu_id             uuid NOT NULL,
  recipe_id           uuid,                       -- NULL while the dish's card isn't in yet
  name                text NOT NULL,
  section             text,                       -- 'Pizza', 'Apps', 'Specials'
  starts_on           date NOT NULL,
  ends_on             date,                       -- NULL: still on
  -- How the dates were set: by a manager, or from the first and last day it sold.
  dates_from          text NOT NULL DEFAULT 'manager' CHECK (dates_from IN ('manager', 'sales')),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (restaurant_id, menu_id) REFERENCES menus (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id)
);
CREATE INDEX menu_entries_current ON menu_entries (restaurant_id, menu_id) WHERE ends_on IS NULL;

-- POS links -----------------------------------------------------------------------------

-- POS menu items and modifiers attach straight to recipes: no separate dish to create.
-- Links are kept by the POS id, so a rename in the POS never breaks them. Square keeps the
-- id when an item is renamed (and restaurants reuse items for rotating specials), so a
-- link also records the name it was confirmed under: a sale under a new name asks once
-- whether it is still the same dish, and a different dish gets its own row.
CREATE TABLE menu_links (
  restaurant_id       uuid NOT NULL,
  pos_catalog_id      text NOT NULL,              -- Square catalog object id (item variation or modifier)
  pos_name_key        text NOT NULL,              -- the name, normalized by the app (menuLinks.nameKey)
  -- Seasonal versions share one POS button: each recipe version starts on its own date, and
  -- a sale is costed with the version in force that day. -infinity: from the beginning.
  effective_from      date NOT NULL DEFAULT '-infinity',
  kind                text NOT NULL CHECK (kind IN ('item', 'modifier')),
  pos_name            text NOT NULL,              -- the name as the POS showed it
  -- linked: costs through menu_link_components. no_food_cost: a gift card, a fee.
  -- awaiting_recipe: a new dish whose card isn't in yet.
  status              text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'no_food_cost', 'awaiting_recipe')),
  -- What one sale counts in: NULL for each, or 'lb' / 'oz' / 'kg' for a deli sold by weight.
  -- Component amounts are per one sale unit.
  sale_unit           text,
  -- For items built from choices ("4oz Gelato" + a flavor, "pick two sides"): how much of
  -- each chosen recipe one choice uses, unless the choice's own link says otherwise.
  choice_amount       numeric CHECK (choice_amount > 0),
  choice_unit         text,
  matched_by          text NOT NULL CHECK (matched_by IN ('name', 'alias', 'manager')),
  confirmed_by        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, pos_catalog_id, pos_name_key, effective_from),
  CHECK ((choice_amount IS NULL) = (choice_unit IS NULL)),
  CHECK (matched_by <> 'manager' OR confirmed_by IS NOT NULL),
  FOREIGN KEY (restaurant_id, confirmed_by) REFERENCES staff (restaurant_id, id)
);

-- What one sale uses: usually one recipe portion, but a size (0.75× the recipe), a set
-- (a tasting menu, a combo, a party package), a glass from a bottle, or a canned drink
-- with no recipe at all are just different component lists.
CREATE TABLE menu_link_components (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  pos_catalog_id      text NOT NULL,
  pos_name_key        text NOT NULL,
  effective_from      date NOT NULL,
  recipe_id           uuid,
  product_id          uuid,
  amount              numeric CHECK (amount > 0), -- NULL: one yield of the recipe (or the item's choice amount)
  unit                text,
  PRIMARY KEY (id),
  CHECK (num_nonnulls(recipe_id, product_id) = 1),
  CHECK ((amount IS NULL) = (unit IS NULL)),
  FOREIGN KEY (restaurant_id, pos_catalog_id, pos_name_key, effective_from)
    REFERENCES menu_links (restaurant_id, pos_catalog_id, pos_name_key, effective_from) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id)
);

-- What a modifier does to food, for every dish or one dish: an add-on, a "no X", a swap.
-- Proposed portions are applied and marked 'assumed' for review; answers are 'manager'.
CREATE TABLE modifier_effects (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  modifier_key        text NOT NULL,              -- list + name, normalized (modifiers.modifierKey)
  dish_recipe_id      uuid,                       -- NULL: every dish
  effect              text NOT NULL CHECK (effect IN ('add', 'remove', 'none', 'waiting')),
  recipe_id           uuid,
  product_id          uuid,
  amount              numeric CHECK (amount > 0),
  unit                text,
  share_of_dish       numeric CHECK (share_of_dish > 0),  -- extra = half again the dish's own portion
  source              text NOT NULL DEFAULT 'manager' CHECK (source IN ('assumed', 'manager')),
  note                text,
  PRIMARY KEY (id),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, modifier_key, dish_recipe_id, effect, recipe_id, product_id),
  CHECK (num_nonnulls(recipe_id, product_id) <= 1),
  CHECK (effect IN ('none', 'waiting') OR num_nonnulls(recipe_id, product_id) = 1),
  CHECK (effect <> 'add' OR num_nonnulls(amount, share_of_dish) = 1),
  CHECK ((amount IS NULL) = (unit IS NULL)),
  FOREIGN KEY (restaurant_id, dish_recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id)
);

-- Names a manager has confirmed, so the same name links elsewhere without asking again.
CREATE TABLE menu_name_aliases (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name_key            text NOT NULL,
  recipe_id           uuid,                       -- NULL: no food cost
  PRIMARY KEY (restaurant_id, name_key),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE
);

-- Prep -------------------------------------------------------------------------------

CREATE TABLE prep_batches (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  recipe_id           uuid NOT NULL,
  amount              numeric NOT NULL CHECK (amount > 0),
  unit                text NOT NULL,
  prepped_at          timestamptz NOT NULL DEFAULT now(),
  use_by              timestamptz,                -- prepped_at + the recipe's shelf life
  prepped_by          uuid,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used_up', 'discarded')),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id),
  FOREIGN KEY (restaurant_id, prepped_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (prepped_by)
);
CREATE INDEX prep_batches_active ON prep_batches (restaurant_id, recipe_id, use_by) WHERE status = 'active';

-- The day's prep, one task per item per station, in the suggested order (sub-preps first,
-- what service needs earliest first, what's about to expire first). Every check-off keeps
-- who and when, so a chef sees each station live and the app learns how long tasks take.
CREATE TABLE prep_tasks (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  business_date       date NOT NULL,
  station_id          uuid,
  recipe_id           uuid NOT NULL,
  amount              numeric NOT NULL CHECK (amount > 0),
  unit                text NOT NULL,
  suggested_order     integer NOT NULL,
  needed_by           timestamptz,
  assigned_to         uuid,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'started', 'done', 'skipped')),
  started_at          timestamptz,                -- optional tap on long tasks
  started_by          uuid,
  completed_at        timestamptz,
  completed_by        uuid,
  prep_batch_id       uuid,                       -- the batch it produced
  note                text,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  CHECK (status <> 'done' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CHECK (status <> 'started' OR started_at IS NOT NULL),
  CHECK (started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE SET NULL (station_id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id),
  FOREIGN KEY (restaurant_id, assigned_to) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (assigned_to),
  FOREIGN KEY (restaurant_id, started_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (started_by),
  FOREIGN KEY (restaurant_id, completed_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (completed_by),
  FOREIGN KEY (restaurant_id, prep_batch_id) REFERENCES prep_batches (restaurant_id, id) ON DELETE SET NULL (prep_batch_id)
);
CREATE INDEX prep_tasks_day ON prep_tasks (restaurant_id, business_date, station_id, suggested_order);

-- Counts -----------------------------------------------------------------------------

CREATE TABLE count_sessions (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('prep_nightly', 'key_items', 'spot_check', 'full')),
  business_date       date NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  counted_by          uuid,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, counted_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (counted_by)
);

-- A count line is either a real count or an estimate filled in for a skipped count.
CREATE TABLE count_lines (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  session_id          uuid NOT NULL,
  product_id          uuid,
  recipe_id           uuid,
  prep_batch_id       uuid,
  amount              numeric NOT NULL CHECK (amount >= 0),
  unit                text NOT NULL,
  is_estimate         boolean NOT NULL DEFAULT false,
  expected_amount     numeric,                    -- what the running estimate said, in the same unit
  recounted           boolean NOT NULL DEFAULT false,
  counted_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CHECK (num_nonnulls(product_id, recipe_id) = 1),
  FOREIGN KEY (restaurant_id, session_id) REFERENCES count_sessions (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id),
  FOREIGN KEY (restaurant_id, prep_batch_id) REFERENCES prep_batches (restaurant_id, id) ON DELETE SET NULL (prep_batch_id)
);

-- Waste ------------------------------------------------------------------------------

CREATE TABLE waste_entries (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL,
  product_id          uuid,                       -- a raw product (spoiled spinach)
  recipe_id           uuid,                       -- a prepped item or a dish (a quart of sauce, a dropped plate)
  prep_batch_id       uuid,                       -- the batch, when an expired batch is discarded
  amount              numeric NOT NULL CHECK (amount > 0),
  unit                text NOT NULL,
  reason              text NOT NULL CHECK (reason IN ('expired', 'spoiled', 'dropped', 'mistake', 'comp', 'other')),
  note                text,
  logged_by           uuid,
  logged_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CHECK (num_nonnulls(product_id, recipe_id) = 1),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id),
  FOREIGN KEY (restaurant_id, prep_batch_id) REFERENCES prep_batches (restaurant_id, id) ON DELETE SET NULL (prep_batch_id),
  FOREIGN KEY (restaurant_id, logged_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (logged_by)
);
CREATE INDEX waste_entries_time ON waste_entries (restaurant_id, logged_at);

-- To-do lists and questions -------------------------------------------------------------

CREATE TABLE todo_items (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  category            text NOT NULL CHECK (category IN ('orders', 'prep', 'alerts', 'counts', 'questions', 'weekly_review')),
  title               text NOT NULL,
  detail              jsonb NOT NULL DEFAULT '{}',
  required_permission text NOT NULL,              -- who should see it
  assigned_to         uuid,                       -- optional: one person
  due_at              timestamptz,                -- deadlines rank first
  impact_cents        bigint NOT NULL DEFAULT 0,  -- then dollar impact
  push_notify         boolean NOT NULL DEFAULT false,
  -- The same problem updates the existing item instead of creating a new one.
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  dismiss_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id, assigned_to) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (assigned_to)
);
CREATE UNIQUE INDEX todo_items_one_open ON todo_items (restaurant_id, dedupe_key) WHERE status = 'open';
CREATE INDEX todo_items_open ON todo_items (restaurant_id, category, due_at) WHERE status = 'open';

-- Questions the system asks to fill gaps, a few per person per day, most valuable first.
CREATE TABLE questions (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  topic               text NOT NULL,              -- e.g. 'missing_conversion', 'recipe_draft', 'vendor_cutoff'
  subject_type        text,                       -- 'product', 'recipe', 'vendor', 'invoice_line'
  subject_id          uuid,
  prompt              text NOT NULL,              -- "How much does a cup of chopped garlic weigh?"
  proposed_answer     jsonb,                      -- the system's best guess, used until answered
  answer              jsonb,
  value_score         numeric NOT NULL DEFAULT 0, -- ranks which questions are worth asking first
  required_permission text NOT NULL,
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'asked', 'answered', 'dropped')),
  asked_at            timestamptz,
  answered_by         uuid,
  answered_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id, answered_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (answered_by)
);
CREATE UNIQUE INDEX questions_one_pending ON questions (restaurant_id, dedupe_key) WHERE status IN ('queued', 'asked');
