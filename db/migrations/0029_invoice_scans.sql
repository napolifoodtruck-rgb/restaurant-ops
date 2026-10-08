-- Invoices read from a photo: the pages as taken (kept, so a line can be checked against the
-- paper later), what was read from them, and where it went once a manager saved it.
CREATE TABLE invoice_scans (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'read', 'failed', 'saved', 'discarded')),
  result          jsonb,                 -- what was read: vendor, date, number, lines, totals
  error           text,
  usage           jsonb,                 -- tokens in and out, for the cost
  app_invoice_id  uuid REFERENCES app_invoices ON DELETE SET NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_scans_recent ON invoice_scans (restaurant_id, created_at DESC);

CREATE TABLE invoice_scan_pages (
  scan_id         uuid NOT NULL REFERENCES invoice_scans ON DELETE CASCADE,
  page            integer NOT NULL,
  media_type      text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  data            bytea NOT NULL,
  PRIMARY KEY (scan_id, page)
);

-- What a vendor's line means, learned from every line a manager confirms: next time the same
-- description from the same vendor is that ingredient, counted that way.
CREATE TABLE vendor_item_matches (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  vendor_key      text NOT NULL,          -- lower-cased vendor name
  item_key        text NOT NULL,          -- the vendor's item code, or its description, normalised
  product_id      text NOT NULL,
  unit            text NOT NULL,          -- what one "quantity" on that line is, in the ingredient's terms
  per             numeric NOT NULL DEFAULT 1 CHECK (per > 0),  -- how many of `unit` in one
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, vendor_key, item_key)
);

ALTER TABLE app_invoices ADD COLUMN scan_id uuid REFERENCES invoice_scans ON DELETE SET NULL;
