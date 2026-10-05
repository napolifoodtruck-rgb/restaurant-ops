-- Kitchen and bar: each POS category belongs to one side of the menu (or neither: merch,
-- gift cards), and each person works one side or both. Categories with no row here fall back
-- to a guess from their name (Beer, Wine, Cocktails, … are bar).
CREATE TABLE category_areas (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  category            text NOT NULL,
  area                text NOT NULL CHECK (area IN ('kitchen', 'bar', 'none')),
  PRIMARY KEY (restaurant_id, category)
);

ALTER TABLE staff ADD COLUMN area text NOT NULL DEFAULT 'both' CHECK (area IN ('kitchen', 'bar', 'both'));
