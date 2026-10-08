-- Square's "items sold" count turns each share of a split check into a whole item (a bottle split
-- eight ways counted as eight bottles). Quantities now come from Square's real quantity
-- (net_quantity), and rows saved the old way are marked so the next sync pulls them again.
ALTER TABLE pos_item_sales_daily ADD COLUMN true_quantity boolean NOT NULL DEFAULT false;
ALTER TABLE pos_order_lines ADD COLUMN true_quantity boolean NOT NULL DEFAULT false;
