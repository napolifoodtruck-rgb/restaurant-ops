-- A checklist item can be a reminder to read rather than a box to tick (no PIN, no credit).
-- A whole list can be read-only too (restaurants.settings.readOnlyLists); that wins over the item.
ALTER TABLE floor_checklists ADD COLUMN read_only boolean NOT NULL DEFAULT false;
