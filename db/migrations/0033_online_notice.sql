-- The order page's text is the notice in the dark box at the top of the menu (partially cooked
-- pizzas, in-person only items), not a line over the header photo. Lines set so far were header lines.
ALTER TABLE online_page RENAME COLUMN header_text TO notice_text;
UPDATE online_page SET notice_text = NULL;
