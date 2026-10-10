-- The dough count. The presets for each weekday (Sunday first; null: none that day): the dough balls
-- and gluten-free crusts a night starts with, and the takeout pizzas it sells.
CREATE TABLE dough_settings (
  restaurant_id   uuid NOT NULL PRIMARY KEY REFERENCES restaurants ON DELETE CASCADE,
  dough_by_weekday   jsonb NOT NULL DEFAULT '[null, null, null, null, null, null, null]',
  gf_by_weekday      jsonb NOT NULL DEFAULT '[null, null, null, null, null, null, null]',
  takeout_by_weekday jsonb NOT NULL DEFAULT '[null, null, null, null, null, null, null]',
  spare           integer NOT NULL DEFAULT 5 CHECK (spare >= 0),   -- dough balls kept back for remakes
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(dough_by_weekday) = 'array' AND jsonb_array_length(dough_by_weekday) = 7),
  CHECK (jsonb_typeof(gf_by_weekday) = 'array' AND jsonb_array_length(gf_by_weekday) = 7),
  CHECK (jsonb_typeof(takeout_by_weekday) = 'array' AND jsonb_array_length(takeout_by_weekday) = 7)
);

-- A night's counts where the kitchen changed them: what the night is counted from instead of the
-- weekday's preset. Typing "38 left" at 7pm sets it to 38 plus what's been used so far, so the count
-- carries on from 38. Nothing carries over to the next night.
CREATE TABLE dough_nights (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day             date NOT NULL,
  dough           numeric CHECK (dough >= 0),
  gf              numeric CHECK (gf >= 0),          -- by the quarter: a side of gluten-free bread
  takeout         numeric CHECK (takeout >= 0),
  changed_by      uuid,
  changed_at      timestamptz,
  PRIMARY KEY (restaurant_id, day)
);

-- A kitchen iPad can be a Service post too: its board opens on the dough count, which it can change
-- with no one signed in (the iPad is trusted, as for check-offs); prep is a PIN away.
ALTER TABLE floor_posts DROP CONSTRAINT floor_posts_kind_check;
ALTER TABLE floor_posts ADD CONSTRAINT floor_posts_kind_check CHECK (kind IN ('room', 'bar', 'counter', 'host', 'kitchen'));
