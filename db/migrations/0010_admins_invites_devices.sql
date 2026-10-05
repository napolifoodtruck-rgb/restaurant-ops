-- Administrators: what the account owner can do, given to others (except removing the owner).
ALTER TABLE staff DROP CONSTRAINT staff_access_check;
ALTER TABLE staff ADD CONSTRAINT staff_access_check CHECK (access IN ('staff', 'manager', 'admin', 'owner'));

-- Email sign-in by invitation: the owner or an administrator creates a link; the person opens
-- it and sets their own password. Only the token's hash is kept; links expire.
CREATE TABLE invites (
  token_hash          text PRIMARY KEY,
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  staff_id            uuid NOT NULL,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  FOREIGN KEY (restaurant_id, staff_id) REFERENCES staff (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (created_by)
);

-- A kitchen iPad can belong to a station: whoever signs in on it lands on that station's list.
ALTER TABLE devices ADD COLUMN station_id uuid,
  ADD FOREIGN KEY (restaurant_id, station_id) REFERENCES stations (restaurant_id, id) ON DELETE SET NULL (station_id);
