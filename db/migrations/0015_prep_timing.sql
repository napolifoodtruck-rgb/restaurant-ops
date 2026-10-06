-- How long prep takes. A station taps "Start prep" when it begins (the list's own clock), and
-- each line keeps how much was actually made when it was checked off (the suggestion isn't
-- stored otherwise), so item times can be compared like for like.
ALTER TABLE prep_lists
  ADD COLUMN work_started_at timestamptz,
  ADD COLUMN work_started_by uuid,
  ADD CONSTRAINT prep_lists_work_started_by_fkey FOREIGN KEY (restaurant_id, work_started_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (work_started_by);
ALTER TABLE prep_list_lines ADD COLUMN made numeric CHECK (made IS NULL OR made >= 0);
CREATE INDEX prep_lists_recent ON prep_lists (restaurant_id, for_date);
