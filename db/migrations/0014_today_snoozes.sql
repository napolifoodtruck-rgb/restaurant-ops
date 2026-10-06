-- Snoozing a line on Today: hidden for the person who snoozed it until the time it comes back.
-- Per person, so one manager clearing their list doesn't hide anything from another.
CREATE TABLE today_snoozes (
  restaurant_id uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  staff_id      uuid NOT NULL,
  item_key      text NOT NULL,
  until         timestamptz NOT NULL,
  snoozed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, staff_id, item_key),
  FOREIGN KEY (restaurant_id, staff_id) REFERENCES staff (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX today_snoozes_until ON today_snoozes (until);
