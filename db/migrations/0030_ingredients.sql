-- The app's own ingredient list. Started as a copy of MarginEdge's products (same ids, so every
-- recipe line and price keeps pointing at the same thing); a MarginEdge sync only adds new ones
-- and keeps their details current; ingredients made in the app (from an invoice, say) have
-- app:<uuid> ids. Without MarginEdge the list stays as it is.
CREATE TABLE ingredients (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  id              text NOT NULL,
  name            text NOT NULL,
  base_unit       text,
  raw_unit        text,
  conversions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  category        text,
  category_type   text,                  -- FOOD, WINE, BEER, LIQUOR, NA_BEVERAGES or OTHER
  reference_price numeric,               -- MarginEdge's last price per base unit, when it had one
  source          text NOT NULL CHECK (source IN ('marginedge', 'app')),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id)
);
