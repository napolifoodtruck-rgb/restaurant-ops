-- A fully refunded online order (refunded in Square, or cancelled from the POS) gives its pizzas
-- back to its pickup window.
ALTER TABLE online_orders DROP CONSTRAINT online_orders_status_check;
ALTER TABLE online_orders ADD CONSTRAINT online_orders_status_check CHECK (status IN ('held', 'paid', 'expired', 'failed', 'refunded'));
ALTER TABLE online_orders ADD COLUMN refunded_at timestamptz;

-- "Pause online orders" for a busy spell: no new online orders until `until`. Orders already
-- at checkout can still be paid.
CREATE TABLE online_pause (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  until               timestamptz NOT NULL,
  paused_by           uuid,
  paused_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id),
  FOREIGN KEY (restaurant_id, paused_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (paused_by)
);
