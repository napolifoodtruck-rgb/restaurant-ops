-- One payment at a time per order: set while a payment is with Square, so a second Pay (the
-- connection dropped, the customer pressed again) waits instead of charging twice.
ALTER TABLE online_orders ADD COLUMN paying_since timestamptz;

-- A hold given up: the customer went back to change their order. It can't be paid any more.
ALTER TABLE online_orders DROP CONSTRAINT online_orders_status_check;
ALTER TABLE online_orders ADD CONSTRAINT online_orders_status_check CHECK (status IN ('held', 'paid', 'expired', 'failed', 'refunded', 'released'));
