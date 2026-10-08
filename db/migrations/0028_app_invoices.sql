-- Invoices typed into the app: a garden harvest, a farmers-market or cash buy, a vendor that isn't
-- on MarginEdge. They price ingredients just like the invoices read from MarginEdge.
-- A vendor is either one of ours (vendors.id) or a MarginEdge vendor (its external id); the name
-- is kept as entered so the invoice reads the same if either goes away.
ALTER TABLE vendors ADD COLUMN kind text NOT NULL DEFAULT 'vendor' CHECK (kind IN ('vendor', 'garden'));

CREATE TABLE app_invoices (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  vendor_id       uuid,
  me_vendor_id    text,
  vendor_name     text NOT NULL,
  invoice_date    date NOT NULL,
  number          text,
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id),
  CHECK (vendor_id IS NOT NULL OR me_vendor_id IS NOT NULL)
);
CREATE INDEX app_invoices_day ON app_invoices (restaurant_id, invoice_date);

CREATE TABLE app_invoice_lines (
  invoice_id      uuid NOT NULL REFERENCES app_invoices ON DELETE CASCADE,
  line_number     integer NOT NULL,
  product_id      text NOT NULL,          -- the ingredient (a MarginEdge product id)
  description     text NOT NULL,
  quantity        numeric NOT NULL CHECK (quantity > 0),
  unit            text NOT NULL,
  total           numeric NOT NULL CHECK (total >= 0),   -- 0 for the garden
  PRIMARY KEY (invoice_id, line_number)
);
