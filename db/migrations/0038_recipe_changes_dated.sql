-- A saved recipe is either a fix (it was always meant to read this way: past periods use it too)
-- or a real change from that day on (a new dough: periods before it keep the old recipe).
-- Everything saved so far counts as a fix.
ALTER TABLE recipe_versions ADD COLUMN dated boolean NOT NULL DEFAULT false;
