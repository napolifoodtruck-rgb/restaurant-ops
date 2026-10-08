-- The "Do you have gluten-free?" panel on the order page, in the manager's own words (null: the usual words).
ALTER TABLE online_page ADD COLUMN gluten_free_text text;
