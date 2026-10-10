-- A vendor's item a manager left out of an invoice (unticked: supplies nobody costs, a fee) is
-- remembered as such: no ingredient. Next time it's left out again without asking.
ALTER TABLE vendor_item_matches ALTER COLUMN product_id DROP NOT NULL;
