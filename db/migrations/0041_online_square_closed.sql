-- When an online order that was never paid was cancelled in Square, so the POS stops counting its items as committed.
ALTER TABLE online_orders ADD COLUMN square_closed_at timestamptz;
