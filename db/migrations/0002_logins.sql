-- Logins ------------------------------------------------------------------------
-- Kitchen staff sign in on an enrolled iPad: tap their name, enter a PIN. Managers and owners
-- can also sign in anywhere with email and password. Secrets are stored as scrypt hashes;
-- session and device tokens are stored as SHA-256 hashes, so a database leak reveals no
-- usable credential.

ALTER TABLE staff
  ADD COLUMN email             text,
  ADD COLUMN password_hash     text,
  ADD COLUMN failed_logins     integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until      timestamptz;
CREATE UNIQUE INDEX staff_email ON staff (lower(email)) WHERE email IS NOT NULL;

-- iPads a manager has enrolled. Only an enrolled device can list staff names or take PINs.
CREATE TABLE devices (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  name                text NOT NULL,              -- "Pizza station iPad"
  token_hash          text NOT NULL UNIQUE,
  enrolled_by         uuid,
  enrolled_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, enrolled_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (enrolled_by)
);

CREATE TABLE sessions (
  token_hash          text PRIMARY KEY,
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  staff_id            uuid NOT NULL,
  device_id           uuid,                       -- set for PIN sign-ins
  method              text NOT NULL CHECK (method IN ('pin', 'password')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  FOREIGN KEY (restaurant_id, staff_id) REFERENCES staff (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, device_id) REFERENCES devices (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Each nightly sync from Square or MarginEdge, so a manager can see when data last came in.
CREATE TABLE sync_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  source              text NOT NULL CHECK (source IN ('square', 'marginedge')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  detail              jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX sync_runs_latest ON sync_runs (restaurant_id, source, started_at DESC);
