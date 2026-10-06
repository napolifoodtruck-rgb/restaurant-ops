-- Orders from Square, one row each, for reports: table, covers, server, how it was ordered, and
-- what it brought in. Sales leave out automatic gratuity, which is counted with tips.
CREATE TABLE pos_orders (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  order_id        text NOT NULL,
  day             date NOT NULL,
  table_name      text,
  fulfillment     text,                 -- the dining option: "For Here", "Pickup"...
  source          text,                 -- where it was placed: "Point of Sale", "Square Online"...
  server_id       text,                 -- Square team member it's attributed to
  server_name     text,
  covers          integer NOT NULL DEFAULT 0,
  net_sales       numeric NOT NULL DEFAULT 0,
  tips            numeric NOT NULL DEFAULT 0,
  auto_gratuity   numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, order_id)
);
CREATE INDEX pos_orders_day ON pos_orders (restaurant_id, day);

-- What was on each order.
CREATE TABLE pos_order_lines (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  order_id        text NOT NULL,
  day             date NOT NULL,
  catalog_id      text,
  item_name       text NOT NULL,
  variation_name  text,
  category        text,
  quantity        numeric NOT NULL DEFAULT 0,
  net_sales       numeric NOT NULL DEFAULT 0
);
CREATE INDEX pos_order_lines_day ON pos_order_lines (restaurant_id, day);
CREATE INDEX pos_order_lines_order ON pos_order_lines (restaurant_id, order_id);
