-- Email that comes in to the app (invoices@, reports@). Who may send to it: an address, or a whole
-- domain written "@vendor.com", for invoices, reports or both. Nothing else is taken.
CREATE TABLE inbox_senders (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  address         text NOT NULL CHECK (address ~ '^(@|[^@\s]+@)[a-z0-9.-]+\.[a-z]{2,}$'),
  inbox           text NOT NULL DEFAULT 'both' CHECK (inbox IN ('invoices', 'reports', 'both')),
  added_by        uuid,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, address)
);

-- Every email that came in, and what became of it: read into an invoice to check or tonight's book,
-- dropped (a sender not on the list, or one that failed the email checks), or a Gmail forwarding code.
CREATE TABLE inbox_emails (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  provider_id     text NOT NULL,                       -- Resend's id: an email is taken once
  received_at     timestamptz NOT NULL DEFAULT now(),
  inbox           text,
  from_address    text NOT NULL,
  subject         text,
  status          text NOT NULL CHECK (status IN ('read', 'reading', 'dropped', 'failed', 'code')),
  detail          text,
  scan_id         uuid REFERENCES invoice_scans ON DELETE SET NULL,
  report_id       uuid REFERENCES floor_reports ON DELETE SET NULL,
  code            text,                                -- Gmail's forwarding confirmation code
  UNIQUE (provider_id)
);
CREATE INDEX inbox_emails_recent ON inbox_emails (restaurant_id, received_at DESC);

-- An invoice or report from an email's text (no PDF attached) is read from the text.
ALTER TABLE invoice_scan_pages DROP CONSTRAINT invoice_scan_pages_media_type_check;
ALTER TABLE invoice_scan_pages ADD CONSTRAINT invoice_scan_pages_media_type_check CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'));
