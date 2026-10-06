-- Containers the kitchen uses (1/9 pan, deep 1/9 pan, deli quart, Cambros…), one list for the restaurant
-- so everyone means the same pan; and what a full one of each prep item weighs. Weight is the base: a
-- container's volume only says what it holds of a liquid, so each item's own weight in it is what counts.
CREATE TABLE unit_containers (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name          text NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  volume_ml     numeric(12,2),
  note          text,
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, name)
);

-- What one unit of a station item weighs (a full 1/9 pan of marinara): weighed on the scale by someone.
ALTER TABLE station_items ADD COLUMN unit_grams numeric(12,2) CHECK (unit_grams IS NULL OR unit_grams > 0);
