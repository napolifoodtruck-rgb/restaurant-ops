-- An emailed invoice is counted on its own (a vendor we know, every line matched before) or waits to
-- be checked, saying why.
ALTER TABLE inbox_emails DROP CONSTRAINT inbox_emails_status_check;
ALTER TABLE inbox_emails ADD CONSTRAINT inbox_emails_status_check CHECK (status IN ('read', 'reading', 'dropped', 'failed', 'code', 'counted', 'waiting'));
