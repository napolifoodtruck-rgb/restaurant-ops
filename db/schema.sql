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
CREATE TABLE job_title_permissions (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  job_title           text NOT NULL,
  permissions         text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (restaurant_id, job_title)
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
  kind                text NOT NULL CHECK (kind IN ('prep', 'dish', 'modifier')),
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
  CHECK (kind = 'prep' OR yield_unit = 'each')
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

-- POS menu items and modifiers attach straight to recipes: no separate dish to create.
-- Links are kept by the POS id, so a rename in the POS never breaks them. Square keeps the
-- id when an item is renamed (and restaurants reuse items for rotating specials), so a
-- link also records the name it was confirmed under: a sale under a new name asks once
-- whether it is still the same dish, and a different dish gets its own row.
CREATE TABLE menu_links (
  restaurant_id       uuid NOT NULL,
  pos_catalog_id      text NOT NULL,              -- Square catalog object id (item variation or modifier)
  pos_name_key        text NOT NULL,              -- the name, normalized by the app (menuLinks.nameKey)
  kind                text NOT NULL CHECK (kind IN ('item', 'modifier')),
  pos_name            text NOT NULL,              -- the name as the POS showed it
  recipe_id           uuid,                       -- NULL: confirmed as no food cost (gift card, fee)
  portion_amount      numeric CHECK (portion_amount > 0),  -- NULL: one yield of the recipe
  portion_unit        text,
  matched_by          text NOT NULL CHECK (matched_by IN ('name', 'alias', 'manager')),
  confirmed_by        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, pos_catalog_id, pos_name_key),
  CHECK ((portion_amount IS NULL) = (portion_unit IS NULL)),
  CHECK (portion_amount IS NULL OR recipe_id IS NOT NULL),
  CHECK (matched_by <> 'manager' OR confirmed_by IS NOT NULL),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, confirmed_by) REFERENCES staff (restaurant_id, id)
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
