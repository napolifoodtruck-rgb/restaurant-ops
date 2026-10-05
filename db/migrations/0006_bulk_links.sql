-- A station item filled from a bulk batch (pizza's 1/6 pans of Spinach Panna come from the
-- Spinach Panna batch on the bulk list), and how many station units one batch fills.
ALTER TABLE station_items
  ADD COLUMN source_item_id   uuid,
  ADD COLUMN per_batch        numeric CHECK (per_batch IS NULL OR per_batch > 0),
  ADD FOREIGN KEY (restaurant_id, source_item_id) REFERENCES station_items (restaurant_id, id) ON DELETE SET NULL (source_item_id);
