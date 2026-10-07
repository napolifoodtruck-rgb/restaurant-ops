-- Online ordering, part one: what's published online, and how many pizzas each pickup window takes.
-- Items and modifiers are Square catalog ids; Square stays the source of names and prices.

-- One row per Square item someone has touched; an item with no row isn't online.
CREATE TABLE online_items (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  item_id             text NOT NULL,                -- Square ITEM id
  published           boolean NOT NULL DEFAULT false,
  counts_as_pizza     boolean,                      -- NULL: from its category
  sold_out_on         date,                         -- sold out online for that day only
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (restaurant_id, item_id),
  FOREIGN KEY (restaurant_id, updated_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (updated_by)
);

-- How a modifier shows online: shown, hidden, or always on (put on every online order, not a choice).
CREATE TABLE online_modifiers (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  modifier_id         text NOT NULL,                -- Square MODIFIER id
  mode                text NOT NULL CHECK (mode IN ('shown', 'hidden', 'always')),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (restaurant_id, modifier_id),
  FOREIGN KEY (restaurant_id, updated_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (updated_by)
);

-- The weekly plan: pizzas each 20-minute pickup window takes, per weekday (0 = Sunday).
-- A window with no row takes none, so nothing is sold online until the plan is filled in.
CREATE TABLE pickup_window_plan (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  weekday             smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts              time NOT NULL,
  max_pizzas          integer NOT NULL CHECK (max_pizzas BETWEEN 0 AND 99),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (restaurant_id, weekday, starts),
  FOREIGN KEY (restaurant_id, updated_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (updated_by)
);

-- One date's own limits, over the plan: a holiday, an event, or tonight closed early.
CREATE TABLE pickup_window_days (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day                 date NOT NULL,
  starts              time NOT NULL,
  max_pizzas          integer NOT NULL CHECK (max_pizzas BETWEEN 0 AND 99),
  note                text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (restaurant_id, day, starts),
  FOREIGN KEY (restaurant_id, updated_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (updated_by)
);
