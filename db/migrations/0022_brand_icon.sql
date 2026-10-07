-- The home-screen icon: the logo centered on a square, made in the browser from the uploaded logo.
ALTER TABLE restaurants ADD COLUMN icon bytea, ADD COLUMN icon_updated_at timestamptz;
