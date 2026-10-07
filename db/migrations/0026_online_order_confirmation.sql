-- The order confirmation email: claimed (set) just before it's sent, so it goes out once; set back
-- to NULL if the send fails, so a later look at the order can try again, up to a few tries.
ALTER TABLE online_orders ADD COLUMN confirmation_sent_at timestamptz;
ALTER TABLE online_orders ADD COLUMN confirmation_tries integer NOT NULL DEFAULT 0;

-- Orders from before the email existed don't get one now.
UPDATE online_orders SET confirmation_sent_at = paid_at WHERE paid_at IS NOT NULL;
