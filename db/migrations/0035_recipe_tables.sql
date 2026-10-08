-- Recipes and managers' answers in their own tables, instead of four big documents in
-- kitchen_book. Each recipe has a permanent id: a line that uses another recipe, a dish linked
-- to a Square button, a station prep item or a menu plan points at it by id, so a rename is
-- one change. Every save of a recipe is kept as a dated version: who changed it, and how it read,
-- so a past period can be costed with the recipe as it was then.
--
-- The data moves over from kitchen_book the first time the app reads a restaurant's book after
-- this deploy (the move needs the app's own name matching). kitchen_book stays as it was, as an
-- archive, until a later cleanup.

CREATE TABLE recipes (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  position        integer NOT NULL DEFAULT 0,          -- the book's order
  category        text,                                -- "Menu items", "Prep"
  recipe_type     text,                                -- Pizza, Drink, Prep (bar)...
  yields          jsonb NOT NULL DEFAULT '[]',         -- everything a batch makes: [{amount, unit}]
  shelf_life_days numeric,
  menu_price      numeric,
  card_total      numeric,
  method          text,
  unread_lines    jsonb NOT NULL DEFAULT '[]',
  layout          text NOT NULL DEFAULT 'card' CHECK (layout IN ('card', 'costing')),
  rough           boolean NOT NULL DEFAULT false,      -- still being worked out: managers see it, cooks don't
  updated_at      timestamptz,
  updated_by      text,                                -- who, as shown ("Pat")
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,                         -- taken out of the book; kept for its history
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id)
);
-- One recipe of a name at a time.
CREATE UNIQUE INDEX recipes_name ON recipes (restaurant_id, lower(btrim(name))) WHERE removed_at IS NULL;

CREATE TABLE recipe_lines (
  recipe_id       uuid NOT NULL REFERENCES recipes ON DELETE CASCADE,
  line_number     integer NOT NULL,
  name            text NOT NULL,                       -- as written on the card
  amount          numeric NOT NULL DEFAULT 0,
  unit            text NOT NULL DEFAULT '',
  yield_percent   numeric NOT NULL DEFAULT 100,
  card_cost       numeric,
  type            text,
  note            text,
  -- What it is: another recipe, or an ingredient (by id). Neither: not matched yet.
  sub_recipe_id   uuid REFERENCES recipes,
  ingredient_id   text,
  PRIMARY KEY (recipe_id, line_number),
  CHECK (sub_recipe_id IS NULL OR ingredient_id IS NULL)
);
CREATE INDEX recipe_lines_sub ON recipe_lines (sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;

-- Every version of every recipe, as it read after each save.
CREATE TABLE recipe_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  recipe_id       uuid NOT NULL REFERENCES recipes ON DELETE CASCADE,
  saved_at        timestamptz NOT NULL DEFAULT now(),
  saved_by        uuid,                                -- staff id, when saved in the app
  saved_by_name   text,
  change          text NOT NULL CHECK (change IN ('created', 'edited', 'renamed', 'removed', 'restored', 'imported')),
  card            jsonb NOT NULL                       -- the recipe as it read: name, yields, lines...
);
CREATE INDEX recipe_versions_recipe ON recipe_versions (recipe_id, saved_at);

-- Which recipe a Square button sells (from a date, for seasonal versions), or that it's a new
-- dish waiting for its recipe, or not food at all (a fee, a gift card).
CREATE TABLE dish_links (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  position        integer NOT NULL DEFAULT 0,
  kind            text NOT NULL CHECK (kind IN ('recipe', 'newDish', 'notFood')),
  catalog_id      text NOT NULL,
  item_name       text NOT NULL,
  variation_name  text NOT NULL DEFAULT '',
  from_date       date,
  recipe_id       uuid,
  recipe_name     text,                                -- as answered, for a link whose recipe isn't in the book
  portion         jsonb,
  note            text,
  answered_at     timestamptz,
  answered_by     text,
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id),
  CHECK (kind = 'recipe' OR recipe_id IS NULL)
);
CREATE INDEX dish_links_recipe ON dish_links (recipe_id) WHERE recipe_id IS NOT NULL;

-- Checks a manager said were false alarms, by their key.
CREATE TABLE dismissed_checks (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  dedupe_key      text NOT NULL,
  position        integer NOT NULL DEFAULT 0,
  note            text,
  answered_at     timestamptz,
  answered_by     text,
  PRIMARY KEY (restaurant_id, dedupe_key)
);

-- Discount buttons: kept as their own item (split), or folded into another by hand (merge).
CREATE TABLE price_folds (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('split', 'merge')),
  catalog_id      text NOT NULL,
  into_catalog_id text,
  position        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, kind, catalog_id),
  CHECK ((kind = 'merge') = (into_catalog_id IS NOT NULL))
);

-- Managers' word on what's on the menu: came off on a day, still on, back on. One per dish
-- (a recipe id, or pos:<catalog id> for a button with no recipe).
CREATE TABLE menu_status (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  subject         text NOT NULL,
  position        integer NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('off', 'on', 'stillOn')),
  day             date NOT NULL,
  name            text,
  answered_at     timestamptz,
  answered_by     text,
  PRIMARY KEY (restaurant_id, subject)
);

-- What managers told about an ingredient: its units, a price when no invoice gives one, that
-- it goes into one dish only, that it's partly grown. Kept apart from the list itself, so a
-- sync refreshing the list never touches an answer.
CREATE TABLE ingredient_answers (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  ingredient_id   text NOT NULL,
  conversions     jsonb,
  manual_price    jsonb,                               -- {price, per: {amount, unit}, date, note}
  exclusive       boolean NOT NULL DEFAULT false,
  partly_grown    jsonb,                               -- {note}
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, ingredient_id)
);

-- A name written on recipes that means a particular ingredient ("Spice, Sea Salt" is the dough salt).
CREATE TABLE ingredient_aliases (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name_key        text NOT NULL,
  name            text NOT NULL,
  ingredient_id   text NOT NULL,
  PRIMARY KEY (restaurant_id, name_key)
);

-- A confirmed real portion: this recipe really uses this much of this ingredient.
CREATE TABLE confirmed_portions (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  recipe_id       uuid NOT NULL,
  ingredient_id   text NOT NULL,
  amount          numeric NOT NULL CHECK (amount > 0),
  unit            text NOT NULL,
  source          text,
  PRIMARY KEY (restaurant_id, recipe_id, ingredient_id),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE
);

-- Add-ons and swaps on the POS: what one use adds, what it takes off a dish, or why it can't be costed yet.
CREATE TABLE modifier_answers (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('add', 'remove', 'waiting')),
  key             text NOT NULL,
  answer          jsonb NOT NULL,
  PRIMARY KEY (restaurant_id, kind, key)
);

-- Answers that only mean something to an importer (MarginEdge's pack sizes and product merges);
-- they go when the importer does.
CREATE TABLE importer_answers (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  source          text NOT NULL,
  answers         jsonb NOT NULL,
  PRIMARY KEY (restaurant_id, source)
);

-- When each part of the book last changed (for the model's cache and the Settings list), and
-- when the move from kitchen_book happened.
CREATE TABLE book_state (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  part            text NOT NULL CHECK (part IN ('converted', 'history', 'recipeCards', 'importAnswers', 'linkAnswers', 'modifierAnswers')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  PRIMARY KEY (restaurant_id, part)
);

-- Station prep items and menu plans point at their recipe by id. The name stays on the row for
-- the screens, kept in step: set the name and the id follows; rename the recipe and the name follows.
ALTER TABLE station_items ADD COLUMN recipe_id uuid;
ALTER TABLE menu_plans ADD COLUMN recipe_id uuid;

CREATE FUNCTION recipe_id_from_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipe_name IS NULL OR btrim(NEW.recipe_name) = '' THEN
    NEW.recipe_id := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.recipe_name IS DISTINCT FROM OLD.recipe_name OR NEW.recipe_id IS NULL THEN
    NEW.recipe_id := (SELECT id FROM recipes WHERE restaurant_id = NEW.restaurant_id AND lower(btrim(name)) = lower(btrim(NEW.recipe_name)) AND removed_at IS NULL LIMIT 1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER station_items_recipe BEFORE INSERT OR UPDATE OF recipe_name, recipe_id ON station_items FOR EACH ROW EXECUTE FUNCTION recipe_id_from_name();
CREATE TRIGGER menu_plans_recipe BEFORE INSERT OR UPDATE OF recipe_name, recipe_id ON menu_plans FOR EACH ROW EXECUTE FUNCTION recipe_id_from_name();

CREATE FUNCTION recipe_name_follows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE station_items SET recipe_name = NEW.name WHERE restaurant_id = NEW.restaurant_id AND recipe_id = NEW.id;
    UPDATE menu_plans SET recipe_name = NEW.name WHERE restaurant_id = NEW.restaurant_id AND recipe_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipes_name_follows AFTER UPDATE OF name ON recipes FOR EACH ROW EXECUTE FUNCTION recipe_name_follows();
