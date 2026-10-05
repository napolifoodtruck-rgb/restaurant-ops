-- POS data, copied nightly from Square (read-only on Square's side) --------------------
-- Sales are kept per day exactly as the POS reported them, so any report can be re-run
-- with today's recipes and answers without asking Square again.

CREATE TABLE pos_item_sales_daily (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day                 date NOT NULL,
  catalog_id          text NOT NULL DEFAULT '',   -- variation id; '' for custom amounts
  item_name           text NOT NULL DEFAULT '',
  variation_name      text NOT NULL DEFAULT '',
  category            text NOT NULL DEFAULT '',
  quantity            numeric NOT NULL,
  net_sales           numeric(12,2) NOT NULL,
  PRIMARY KEY (restaurant_id, day, catalog_id, item_name, variation_name, category)
);

CREATE TABLE pos_modifier_sales_daily (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day                 date NOT NULL,
  catalog_id          text NOT NULL DEFAULT '',
  item_name           text NOT NULL DEFAULT '',
  variation_name      text NOT NULL DEFAULT '',
  modifier_list       text NOT NULL DEFAULT '',
  modifier_name       text NOT NULL,
  quantity            numeric NOT NULL,
  gross_sales         numeric(12,2) NOT NULL,
  PRIMARY KEY (restaurant_id, day, catalog_id, item_name, variation_name, modifier_list, modifier_name)
);

-- The POS catalog as of the last sync: items with their variations, categories, modifier lists.
CREATE TABLE pos_catalog (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  object_id           text NOT NULL,
  type                text NOT NULL,
  data                jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, object_id)
);
