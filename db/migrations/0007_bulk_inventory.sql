-- Bulk prep as inventory. A bulk item is kept in a storage unit (qt, lb, each) and a batch
-- makes a known amount; a station container filled from it holds a known amount. On hand
-- moves on its own: a batch checked off adds, a station fill checked off takes out, a count
-- (when someone does one) resets it.
ALTER TABLE station_items
  ADD COLUMN bulk_unit        text,                                              -- bulk items: the unit it's kept in
  ADD COLUMN batch_yield      numeric CHECK (batch_yield IS NULL OR batch_yield > 0), -- bulk items: one batch makes this many bulk units
  ADD COLUMN holds            numeric CHECK (holds IS NULL OR holds > 0);         -- filled items: one station unit holds this many of the bulk's units

CREATE TABLE bulk_ledger (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  item_id             uuid NOT NULL,                  -- the bulk item
  at                  timestamptz NOT NULL DEFAULT now(),
  kind                text NOT NULL CHECK (kind IN ('made', 'filled', 'counted', 'waste')),
  change              numeric,                        -- made: +, filled and waste: −
  set_to              numeric CHECK (set_to IS NULL OR set_to >= 0),  -- counted: the new on hand
  list_id             uuid,                           -- the list line that caused it, so an undo can reverse it
  line_item_id        uuid,
  by_staff            uuid,
  CHECK ((kind = 'counted') = (set_to IS NOT NULL)),
  CHECK ((kind = 'counted') = (change IS NULL)),
  FOREIGN KEY (restaurant_id, item_id) REFERENCES station_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, by_staff) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (by_staff)
);
CREATE INDEX bulk_ledger_item ON bulk_ledger (restaurant_id, item_id, at);
CREATE UNIQUE INDEX bulk_ledger_line ON bulk_ledger (list_id, line_item_id, item_id, kind) WHERE list_id IS NOT NULL AND kind <> 'counted';
