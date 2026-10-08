-- One place for every invoice, whatever brought it in: a photo, typed in, the garden, or (while
-- it still runs) MarginEdge's sync. Prices are worked out from these lines. MarginEdge becomes
-- an importer: its invoices are stored here once, or compared with ours when we already have them.

ALTER TABLE app_invoices RENAME TO supplier_invoices;
ALTER TABLE app_invoice_lines RENAME TO supplier_invoice_lines;
ALTER INDEX app_invoices_day RENAME TO supplier_invoices_day;

ALTER TABLE supplier_invoices
  ADD COLUMN source text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed', 'garden', 'photo', 'marginedge')),
  ADD COLUMN me_invoice_id text,
  ADD COLUMN tax numeric NOT NULL DEFAULT 0,
  ADD COLUMN delivery numeric NOT NULL DEFAULT 0,
  ADD COLUMN other_charges numeric NOT NULL DEFAULT 0,
  ADD COLUMN credit numeric NOT NULL DEFAULT 0,
  ADD COLUMN total numeric,
  ADD COLUMN is_credit boolean NOT NULL DEFAULT false;
ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS app_invoices_check;
CREATE UNIQUE INDEX supplier_invoices_me ON supplier_invoices (restaurant_id, me_invoice_id) WHERE me_invoice_id IS NOT NULL;
UPDATE supplier_invoices i SET source = CASE WHEN i.scan_id IS NOT NULL THEN 'photo' WHEN v.kind = 'garden' THEN 'garden' ELSE 'typed' END
  FROM vendors v WHERE v.id = i.vendor_id;
UPDATE supplier_invoices SET source = 'photo' WHERE scan_id IS NOT NULL;

-- A line keeps what was printed (code, quantity, unit price, total) and what it means: the
-- ingredient, and what one purchased unit holds (per_amount per_unit, e.g. 30 lb for a case).
ALTER TABLE supplier_invoice_lines
  ADD COLUMN code text,
  ADD COLUMN unit_price numeric,
  ADD COLUMN per_amount numeric NOT NULL DEFAULT 1,
  ADD COLUMN per_unit text,
  ADD COLUMN per_base numeric,                              -- base units in one purchased unit, when the importer worked it out
  ADD COLUMN priced boolean NOT NULL DEFAULT true,         -- counts toward prices
  ADD COLUMN pack_source text;                              -- how the pack was known (manager, pack, calibrated...)
ALTER TABLE supplier_invoice_lines ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE supplier_invoice_lines DROP CONSTRAINT IF EXISTS app_invoice_lines_quantity_check;
ALTER TABLE supplier_invoice_lines DROP CONSTRAINT IF EXISTS app_invoice_lines_total_check;
UPDATE supplier_invoice_lines SET per_unit = unit WHERE per_unit IS NULL;

ALTER TABLE invoice_scans RENAME COLUMN app_invoice_id TO invoice_id;

-- Vendors are ours; one MarginEdge also knows carries its id there while both run.
ALTER TABLE vendors ADD COLUMN me_vendor_id text;
CREATE UNIQUE INDEX vendors_me ON vendors (restaurant_id, me_vendor_id) WHERE me_vendor_id IS NOT NULL;

-- The same invoice from both: ours (photo or typed) against MarginEdge's, line by line.
CREATE TABLE invoice_comparisons (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  me_invoice_id   text NOT NULL,
  invoice_id      uuid NOT NULL REFERENCES supplier_invoices ON DELETE CASCADE,
  result          jsonb NOT NULL,         -- per line: matched, ingredient, quantity and total each side
  lines           integer NOT NULL,
  matching        integer NOT NULL,
  totals_match    boolean NOT NULL,
  compared_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, me_invoice_id)
);

-- What the MarginEdge importer last read in, so it runs again only when something changed.
CREATE TABLE importer_state (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  source          text NOT NULL,
  stamp           text NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, source)
);
