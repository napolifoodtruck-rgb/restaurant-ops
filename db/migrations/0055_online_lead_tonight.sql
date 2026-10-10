-- "Ready in" changed from a board counts for that night only; the next day starts again from the
-- default (online_lead_minutes, set in Online ordering settings).
ALTER TABLE restaurants ADD COLUMN online_lead_tonight integer CHECK (online_lead_tonight BETWEEN 5 AND 120), ADD COLUMN online_lead_day date;
