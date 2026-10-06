-- Online orders, from checkout to paid. A held order keeps its pizzas in its pickup window for a
-- few minutes while the customer pays; if they leave, the hold lapses and the room goes back.
CREATE TABLE online_orders (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day                 date NOT NULL,
  window_starts       time NOT NULL,
  pizzas              integer NOT NULL CHECK (pizzas >= 0),
  status              text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'paid', 'expired', 'failed')),
  hold_until          timestamptz NOT NULL,
  customer_name       text NOT NULL,
  customer_phone      text NOT NULL,
  customer_email      text,
  lines               jsonb NOT NULL,                 -- the priced cart, as it was ordered
  subtotal_cents      integer NOT NULL,
  tax_cents           integer NOT NULL DEFAULT 0,
  total_cents         integer NOT NULL,               -- what Square says the order comes to, before tip
  tip_cents           integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  understood_partial  boolean NOT NULL,               -- ticked "partially cooked, finished at home"
  square_order_id     text,
  square_payment_id   text,
  receipt_url         text,
  failure             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  PRIMARY KEY (id),
  CHECK (status <> 'paid' OR (square_payment_id IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX online_orders_window ON online_orders (restaurant_id, day, window_starts) WHERE status IN ('held', 'paid');
CREATE UNIQUE INDEX online_orders_square ON online_orders (square_order_id) WHERE square_order_id IS NOT NULL;
