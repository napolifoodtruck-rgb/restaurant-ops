-- Orders were read as closed checks only, less automatic gratuity; Square's Net sales counts every
-- order (a gelato at the counter, an online pickup, paid but never marked done) with the gratuity.
-- Emptied so the next nightly sync reads every order again, the way Square counts them.
DELETE FROM pos_orders;
DELETE FROM pos_order_lines;
DELETE FROM pos_sales_hourly;
