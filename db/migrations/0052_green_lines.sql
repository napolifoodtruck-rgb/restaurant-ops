-- How trustworthy green is: of the lines that came up green on an invoice, how many a manager
-- changed (ingredient, amount or total) before saving it. Toward saving all-green invoices unchecked.
ALTER TABLE invoice_scans ADD COLUMN green_lines integer, ADD COLUMN green_changed integer;
