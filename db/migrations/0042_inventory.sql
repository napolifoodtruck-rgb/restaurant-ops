-- Inventory counts: where things are kept (areas and their shelves, in counting order), what sits
-- where, and each count as counted ("2 cases + 5 lb"), with what it comes to in the item's own unit
-- and in dollars at the time.

-- A count list (Kitchen, Alcohol, Other) and who counts it: the chef, the bar manager, the FOH manager.
CREATE TABLE storage_areas (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name            text NOT NULL,
  counted_by      text NOT NULL DEFAULT 'kitchen' CHECK (counted_by IN ('kitchen', 'foh', 'bar')),
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id)
);
CREATE UNIQUE INDEX storage_areas_name ON storage_areas (restaurant_id, lower(name)) WHERE active;

-- A section of a list: where things are kept, in the order they're counted ("Walk-in · top shelf").
CREATE TABLE storage_spots (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  area_id         uuid NOT NULL,
  name            text NOT NULL,
  holds           text,                                -- what's usually there, to suggest items: "vegetables"
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, area_id) REFERENCES storage_areas (restaurant_id, id) ON DELETE CASCADE
);

-- What's kept where: an ingredient (or a prep) on a spot, in shelf order. One place per item.
CREATE TABLE storage_items (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  item_kind       text NOT NULL CHECK (item_kind IN ('product', 'recipe')),
  item_id         text NOT NULL,                       -- an ingredient id, or a recipe id
  spot_id         uuid NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, item_kind, item_id),
  FOREIGN KEY (restaurant_id, spot_id) REFERENCES storage_spots (restaurant_id, id) ON DELETE CASCADE
);

-- A count of one area on one day.
CREATE TABLE inventory_counts (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  area_id         uuid NOT NULL,
  day             date NOT NULL,
  started_by      uuid,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_by     uuid,
  finished_at     timestamptz,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, area_id) REFERENCES storage_areas (restaurant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inventory_counts_once ON inventory_counts (area_id, day);

-- One item as counted: the parts as said ([{amount: 2, unit: "case"}, {amount: 5, unit: "lb"}]),
-- what that is in the item's own unit, and its value then (null when it has no price yet).
CREATE TABLE inventory_count_lines (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  count_id        uuid NOT NULL,
  item_kind       text NOT NULL CHECK (item_kind IN ('product', 'recipe')),
  item_id         text NOT NULL,
  name            text NOT NULL,
  parts           jsonb NOT NULL,
  amount          numeric,                             -- in base_unit; null when a part doesn't convert
  base_unit       text,
  value           numeric,
  counted_by      uuid,
  counted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, item_kind, item_id),
  FOREIGN KEY (restaurant_id, count_id) REFERENCES inventory_counts (restaurant_id, id) ON DELETE CASCADE,
  CHECK (amount IS NULL OR amount >= 0)
);
