-- The Floor: what the front of house needs for a shift, on the POS iPads. Built like Prep is for
-- the kitchen: each iPad is set to a post (a dining room, the bar, the counter, the host stand) and
-- shows that post's board: tonight's book, what's new and special, the gelato flight, what to talk
-- up, managers' notes, checklists, and a lookup for ingredients, allergens and wine.

-- Posts: where an iPad stands. A room covers tables (reservations land by table); the bar can
-- also show a prep station's list; the host stand sees every table.
CREATE TABLE floor_posts (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'room' CHECK (kind IN ('room', 'bar', 'counter', 'host')),
  tables          text[] NOT NULL DEFAULT '{}',        -- "T31", "T11"...; the host stand needs none
  station_id      uuid,                                -- the bar's prep list
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE SET NULL (station_id)
);
CREATE UNIQUE INDEX floor_posts_name ON floor_posts (restaurant_id, lower(name)) WHERE active;

ALTER TABLE devices ADD COLUMN floor_post_id uuid,
  ADD FOREIGN KEY (restaurant_id, floor_post_id) REFERENCES floor_posts (restaurant_id, id) ON DELETE SET NULL (floor_post_id);

-- Managers' notes for the team: for one night or a stretch, for every post or one.
CREATE TABLE floor_notes (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  post_id         uuid,                                -- NULL: everyone
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  weekdays        integer[],                           -- every Wednesday ("half-price wine"); NULL: every day
  body            text NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, post_id) REFERENCES floor_posts (restaurant_id, id) ON DELETE CASCADE,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX floor_notes_days ON floor_notes (restaurant_id, ends_on);

-- What's featured: a special (on the days it runs) or a new item, shown as a card from its
-- recipe. New items are also found from sales; a row here can hide one or keep one longer.
CREATE TABLE floor_features (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('special', 'new', 'hidden')),
  recipe_id       uuid,
  name            text NOT NULL,                       -- as servers say it
  price           numeric,                             -- when Square doesn't have it yet
  starts_on       date NOT NULL,
  ends_on         date,
  weekdays        integer[],                           -- 0 = Sunday; NULL: every day it runs
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE
);

-- Dishes and drinks a manager wants talked up (on top of the ones the numbers suggest).
CREATE TABLE floor_pushes (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name            text NOT NULL,
  recipe_id       uuid,
  why             text,
  ends_on         date,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, recipe_id) REFERENCES recipes (restaurant_id, id) ON DELETE CASCADE
);

-- The gelato flight (6 flavors, some vegan) and tonight's pan changes, as last set.
CREATE TABLE floor_gelato (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  flavors         jsonb NOT NULL,                      -- [{name, vegan}]
  pan_changes     jsonb NOT NULL DEFAULT '[]',         -- [{from, to}] for one night
  pans_on         date,
  set_by          uuid,
  set_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX floor_gelato_latest ON floor_gelato (restaurant_id, set_at DESC);

-- Checklists: opening and closing (every night), and "when it's slow" deep cleaning (due again
-- after so many days). A PIN marks who did it, so the credit goes to them.
CREATE TABLE floor_checklists (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  post_id         uuid,                                -- NULL: every post
  kind            text NOT NULL CHECK (kind IN ('opening', 'closing', 'slow')),
  name            text NOT NULL,
  every_days      integer CHECK (every_days IS NULL OR every_days > 0),  -- slow tasks: due again after
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, post_id) REFERENCES floor_posts (restaurant_id, id) ON DELETE CASCADE
);

CREATE TABLE floor_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  checklist_id    uuid NOT NULL,
  day             date NOT NULL,
  done_by         uuid,
  done_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, checklist_id) REFERENCES floor_checklists (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, done_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (done_by)
);
CREATE UNIQUE INDEX floor_checks_once ON floor_checks (checklist_id, day);

-- End of the night: what the managers should know (feedback, something broken, what ran low).
CREATE TABLE floor_handoffs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  post_id         uuid,
  day             date NOT NULL,
  body            text NOT NULL,
  written_by      uuid,
  written_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, post_id) REFERENCES floor_posts (restaurant_id, id) ON DELETE SET NULL (post_id),
  FOREIGN KEY (restaurant_id, written_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (written_by)
);

-- Tonight's book: an OpenTable report (the pre-shift digest, or a printout or CSV export) as read.
-- Guest details are kept for the night only: older reports are deleted.
CREATE TABLE floor_reports (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day             date NOT NULL,
  source          text NOT NULL CHECK (source IN ('digest', 'printout', 'csv')),
  as_of           timestamptz,                         -- when the report was made
  status          text NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'read', 'failed')),
  result          jsonb,                               -- reservations as read
  error           text,
  file            bytea,
  media_type      text,
  usage           jsonb,
  uploaded_by     uuid,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX floor_reports_day ON floor_reports (restaurant_id, day, uploaded_at DESC);

-- Wine cards: what servers need at the table, read from the producers' tech sheets.
CREATE TABLE wine_cards (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name            text NOT NULL,
  producer        text,
  region          text,                                -- Italian region: Toscana, Piemonte...
  place           text,                                -- town or hills, as the sheet says
  grapes          text,
  vessel          text,
  style           text,                                -- red, white, rosé, sparkling, orange
  tasting_notes   text,
  story           text,
  facts           jsonb NOT NULL DEFAULT '[]',
  sheet_pairings  jsonb NOT NULL DEFAULT '[]',         -- dishes the sheet names
  ingredient_pairings jsonb NOT NULL DEFAULT '[]',
  catalog_ids     text[] NOT NULL DEFAULT '{}',        -- its Square buttons (glass, bottle)
  pairings        jsonb NOT NULL DEFAULT '[]',         -- approved: [{recipeId, why}]
  suggested       jsonb,                               -- Claude's suggestions, waiting: [{recipeId, why}]
  photo           bytea,
  photo_type      text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wine_cards_name ON wine_cards (restaurant_id, lower(name)) WHERE active;

-- Tech sheets uploaded to be read into cards.
CREATE TABLE wine_sheet_scans (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'read', 'failed', 'saved')),
  file            bytea NOT NULL,
  media_type      text NOT NULL,
  result          jsonb,
  error           text,
  usage           jsonb,
  uploaded_by     uuid,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

-- Allergens (the major 9 and alliums) and the name servers say, per ingredient: allergens NULL
-- means not checked yet; an empty list means checked, none. Suggestions wait for a manager.
ALTER TABLE ingredient_answers
  ADD COLUMN allergens text[],
  ADD COLUMN allergens_suggested text[],
  ADD COLUMN guest_name text,
  ADD COLUMN on_cards boolean NOT NULL DEFAULT true;
-- A prep's name on the menu cards ("Pomodoro Base" for the Pomodoro Sauce).
ALTER TABLE recipes ADD COLUMN guest_name text;
