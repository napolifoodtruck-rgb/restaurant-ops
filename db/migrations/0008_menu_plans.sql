-- Prep items with dates: a new dish's preps join a list the day before it starts; preps only a
-- replaced dish used come off when it ends.
ALTER TABLE station_items
  ADD COLUMN active_from      date,
  ADD COLUMN active_until     date,
  ADD CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from);

-- Dishes coming to the menu (or leaving it), planned ahead of the first sale.
CREATE TABLE menu_plans (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,
  recipe_name         text,                       -- its recipe card, when there is one
  section             text,
  starts_on           date NOT NULL,
  replaces            text,                       -- the current dish it replaces, by name
  note                text,
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'cancelled')),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, created_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (created_by)
);
