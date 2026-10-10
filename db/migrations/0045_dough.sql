-- The dough count. The settings: which recipe is the dough (unset: the one named "Pizza Dough") and
-- the takeout pizzas for each weekday (Sunday first; null: no takeout number that day).
CREATE TABLE dough_settings (
  restaurant_id   uuid NOT NULL PRIMARY KEY REFERENCES restaurants ON DELETE CASCADE,
  dough_recipe_id uuid,
  takeout_by_weekday integer[] NOT NULL DEFAULT '{NULL,NULL,NULL,NULL,NULL,NULL,NULL}',
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(takeout_by_weekday) = 7)
);

-- Each night: the dough balls it started with (left from last night plus made today), entered on a
-- kitchen iPad, and the takeout number if it's not the weekday's (set in Settings, or changed by the
-- kitchen during service).
CREATE TABLE dough_nights (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day             date NOT NULL,
  left_over       integer CHECK (left_over >= 0),
  made            integer CHECK (made >= 0),
  start_by        uuid,
  start_at        timestamptz,
  takeout         integer CHECK (takeout >= 0),
  takeout_by      uuid,
  takeout_at      timestamptz,
  PRIMARY KEY (restaurant_id, day)
);
