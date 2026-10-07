-- The order of the online menu, as a manager arranged it: categories, and items within them.
-- Anything never arranged comes after, alphabetically.
ALTER TABLE online_items ADD COLUMN position integer;

CREATE TABLE online_categories (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,                  -- the Square category's name, as the menu shows it
  position            integer NOT NULL,
  PRIMARY KEY (restaurant_id, name)
);
