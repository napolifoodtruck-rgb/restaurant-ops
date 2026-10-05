-- MarginEdge data as last synced, in the API's own shape (one row per part: categories,
-- products, vendors, vendorItems, invoices). The import code reads it as is.
CREATE TABLE marginedge_data (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  part                text NOT NULL CHECK (part IN ('categories', 'products', 'vendors', 'vendorItems', 'invoices')),
  data                jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, part)
);

-- The kitchen's own knowledge, as documents during the pilot: recipe cards and the answers
-- managers have given (dish links, portions, product merges, modifier effects). Each save
-- keeps the previous version so an answer can be traced or undone.
CREATE TABLE kitchen_book (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  key                 text NOT NULL CHECK (key IN ('recipeCards', 'importAnswers', 'linkAnswers', 'modifierAnswers')),
  value               jsonb NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (restaurant_id, key)
);

CREATE TABLE kitchen_book_history (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  key                 text NOT NULL,
  value               jsonb NOT NULL,
  saved_at            timestamptz NOT NULL DEFAULT now(),
  saved_by            uuid
);
