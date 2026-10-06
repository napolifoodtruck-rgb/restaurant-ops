-- Ideas a manager set aside: "Not now" (back after a while) or "Done" (back only if it gets clearly
-- worse). Kept with what it was worth then, so a bigger version of the same idea comes back.
CREATE TABLE idea_dismissals (
  restaurant_id uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  idea_key      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('later', 'done')),
  until         timestamptz,
  monthly       numeric(12,2) NOT NULL DEFAULT 0,
  title         text NOT NULL DEFAULT '',
  dismissed_by  uuid,
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, idea_key),
  FOREIGN KEY (restaurant_id, dismissed_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (dismissed_by)
);
