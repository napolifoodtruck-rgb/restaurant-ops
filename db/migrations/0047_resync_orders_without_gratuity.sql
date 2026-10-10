-- Sales leave out automatic gratuity after all (service charges are really tips): emptied again in
-- case a sync ran in between, so the next one reads every order without it.
DELETE FROM pos_orders;
DELETE FROM pos_order_lines;
DELETE FROM pos_sales_hourly;
