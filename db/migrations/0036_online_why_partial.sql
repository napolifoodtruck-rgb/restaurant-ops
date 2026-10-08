-- The "Why partially cooked?" panel on the order page, in the manager's own words (null: the usual words).
ALTER TABLE online_page ADD COLUMN why_partial_text text;
