-- Station prep lists -------------------------------------------------------------
-- Each station keeps a list of items with a unit and a par, like the paper sheet. At night
-- the closer counts; the app drafts what to make tomorrow; a chef approves; the station cook
-- works the list the next day, cleaning tasks last.

CREATE TABLE station_items (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  station_id          uuid NOT NULL,
  name                text NOT NULL,
  unit                text,                       -- 'bottle', '1/6 pan', 'deep 1/9 pan', 'portion'...
  -- count: count it, make par minus count. task: just do it (daily). batch: made as needed (bulk).
  kind                text NOT NULL DEFAULT 'count' CHECK (kind IN ('count', 'task', 'batch')),
  par                 numeric CHECK (par IS NULL OR par >= 0),  -- the busiest day's par (Friday at Napoli)
  weekdays            integer[],                  -- only on these days (0 = Sunday); NULL = every day
  recipe_name         text,                       -- the recipe card it's made from, when linked
  note                text,
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX station_items_station ON station_items (restaurant_id, station_id, sort_order) WHERE active;

CREATE TABLE station_checklist (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  station_id          uuid NOT NULL,
  name                text NOT NULL,
  frequency           text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
  weekday             integer CHECK (weekday BETWEEN 0 AND 6),  -- for weekly tasks; NULL = any day that week
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE CASCADE
);

CREATE TABLE prep_lists (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  station_id          uuid NOT NULL,
  for_date            date NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  counted_by          uuid,
  counted_at          timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, station_id, for_date),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, counted_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (counted_by),
  FOREIGN KEY (restaurant_id, approved_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (approved_by)
);

CREATE TABLE prep_list_lines (
  restaurant_id       uuid NOT NULL,
  list_id             uuid NOT NULL,
  item_id             uuid NOT NULL,
  counted             numeric CHECK (counted IS NULL OR counted >= 0),
  to_make             numeric CHECK (to_make IS NULL OR to_make >= 0),   -- set by a chef; NULL = the app's suggestion
  started_at          timestamptz,
  started_by          uuid,
  done_at             timestamptz,
  done_by             uuid,
  note                text,
  PRIMARY KEY (list_id, item_id),
  FOREIGN KEY (restaurant_id, list_id) REFERENCES prep_lists (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, item_id) REFERENCES station_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, started_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (started_by),
  FOREIGN KEY (restaurant_id, done_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (done_by)
);

CREATE TABLE prep_list_checks (
  restaurant_id       uuid NOT NULL,
  list_id             uuid NOT NULL,
  checklist_id        uuid NOT NULL,
  done_at             timestamptz NOT NULL DEFAULT now(),
  done_by             uuid,
  PRIMARY KEY (list_id, checklist_id),
  FOREIGN KEY (restaurant_id, list_id) REFERENCES prep_lists (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, checklist_id) REFERENCES station_checklist (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, done_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (done_by)
);
