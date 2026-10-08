-- The tip already picked when a customer reaches checkout on the order page, in percent (0: No tip).
ALTER TABLE online_page ADD COLUMN default_tip smallint NOT NULL DEFAULT 0;
