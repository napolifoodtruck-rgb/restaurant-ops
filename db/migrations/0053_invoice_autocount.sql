-- Whether an invoice whose every line is matched (green) is saved without a check: off until a
-- manager turns it on (Invoices), for photos and emails alike.
ALTER TABLE restaurants ADD COLUMN invoice_autocount boolean NOT NULL DEFAULT false;
