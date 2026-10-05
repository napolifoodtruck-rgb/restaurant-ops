-- Each restaurant's own look: its logo, uploaded in Settings (kept here, not in the app's code).
ALTER TABLE restaurants ADD COLUMN logo bytea, ADD COLUMN logo_type text CHECK (logo_type IN ('image/png', 'image/jpeg', 'image/webp')), ADD COLUMN logo_updated_at timestamptz;
