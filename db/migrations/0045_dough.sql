-- The dough count. The settings: which recipes are the dough and the gluten-free dough (unset: by
-- name) and the takeout pizzas for each weekday (Sunday first; null: no takeout number that day).
CREATE TABLE dough_settings (
  restaurant_id   uuid NOT NULL PRIMARY KEY REFERENCES restaurants ON DELETE CASCADE,
  dough_recipe_id uuid,
  gf_recipe_id    uuid,
  takeout_by_weekday jsonb NOT NULL DEFAULT '[null, null, null, null, null, null, null]',
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(takeout_by_weekday) = 'array' AND jsonb_array_length(takeout_by_weekday) = 7)
);

-- Each night: the dough balls and gluten-free crusts it started with (left from last night plus
-- made today, counted by hand), entered on a kitchen iPad, and the takeout number if it's not the weekday's (set in Settings, or changed by the
-- kitchen during service).
CREATE TABLE dough_nights (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day             date NOT NULL,
  left_over       integer CHECK (left_over >= 0),
  made            integer CHECK (made >= 0),
  gf_left_over    integer CHECK (gf_left_over >= 0),
  gf_made         integer CHECK (gf_made >= 0),
  start_by        uuid,
  start_at        timestamptz,
  takeout         integer CHECK (takeout >= 0),
  takeout_by      uuid,
  takeout_at      timestamptz,
  PRIMARY KEY (restaurant_id, day)
);
