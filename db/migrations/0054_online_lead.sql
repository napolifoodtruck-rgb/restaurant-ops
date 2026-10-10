-- How long an online order takes to make: a pickup time can't be sooner than this. Changed from the
-- online orders widget when the kitchen is slammed (or quiet).
ALTER TABLE restaurants ADD COLUMN online_lead_minutes integer NOT NULL DEFAULT 20 CHECK (online_lead_minutes BETWEEN 5 AND 120);
