-- Sanity checks for db/migrations: loads sample rows and confirms the guard rails hold.
-- Run with scripts/check-schema.sh. Any failed check raises an error.

\set ON_ERROR_STOP on

INSERT INTO restaurants (id, name) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Our restaurant'),
  ('00000000-0000-0000-0000-00000000000b', 'Another restaurant');

INSERT INTO staff (id, restaurant_id, display_name, job_title) VALUES
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Sam', 'Line Cook');
INSERT INTO stations (id, restaurant_id, name, sort_order) VALUES
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Sauté', 1);

INSERT INTO vendors (id, restaurant_id, name, order_email, me_vendor_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Produce Co', 'orders@example.com', 'me-123'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Cheese Farm', NULL, NULL);
INSERT INTO vendors (id, restaurant_id, name, kind) VALUES
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Our garden', 'garden');

INSERT INTO ingredients (restaurant_id, id, name, base_unit, source) VALUES
  ('00000000-0000-0000-0000-00000000000a', '501', 'Basil, Fresh', 'lb', 'marginedge'),
  ('00000000-0000-0000-0000-00000000000a', 'app:1', 'Lemon verbena', 'g', 'app');

INSERT INTO supplier_invoices (id, restaurant_id, vendor_id, vendor_name, invoice_date, number, source, total) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'Produce Co', '2026-10-01', 'A-1', 'photo', 24),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003', 'Our garden', '2026-10-02', NULL, 'garden', 0);
INSERT INTO supplier_invoices (id, restaurant_id, me_vendor_id, vendor_name, invoice_date, source, me_invoice_id, total) VALUES
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'me-999', 'A MarginEdge vendor', '2026-09-30', 'marginedge', 'inv-1', 12);
INSERT INTO supplier_invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, unit_price, total, per_amount, per_unit) VALUES
  ('20000000-0000-0000-0000-000000000001', 1, '501', 'BASIL', 2, 'case', 12, 24, 1, 'lb'),
  ('20000000-0000-0000-0000-000000000001', 2, NULL, 'FUEL CHARGE', 1, 'each', 3, 3, 1, 'each'),
  ('20000000-0000-0000-0000-000000000002', 1, 'app:1', 'Lemon verbena', 200, 'g', 0, 0, 1, 'g');

INSERT INTO invoice_scans (id, restaurant_id, status, invoice_id) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'saved', '20000000-0000-0000-0000-000000000001');
INSERT INTO invoice_scan_pages (scan_id, page, media_type, data) VALUES
  ('30000000-0000-0000-0000-000000000001', 1, 'image/jpeg', '\xffd8ff'::bytea);

INSERT INTO vendor_item_matches (restaurant_id, vendor_id, item_key, product_id, unit, per) VALUES
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '#1001', '501', 'lb', 1),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', 'mozz fresh', 'app:1', 'lb', 1);

INSERT INTO invoice_comparisons (restaurant_id, me_invoice_id, invoice_id, result, lines, matching, totals_match) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'inv-0', '20000000-0000-0000-0000-000000000001', '{}', 1, 1, true);

-- Each check below must be rejected. The helper raises if a statement succeeds.
CREATE FUNCTION pg_temp.must_fail(label text, statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ok: % (rejected: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'check failed: % was accepted', label;
END $$;

SELECT pg_temp.must_fail('a vendor is a vendor or the garden',
  $$INSERT INTO vendors (restaurant_id, name, kind) VALUES ('00000000-0000-0000-0000-00000000000a', 'Farmers market', 'market')$$);

SELECT pg_temp.must_fail('one vendor per MarginEdge vendor',
  $$INSERT INTO vendors (restaurant_id, name, me_vendor_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'Produce Company', 'me-123')$$);

SELECT pg_temp.must_fail('an ingredient comes from MarginEdge or the app',
  $$INSERT INTO ingredients (restaurant_id, id, name, source) VALUES ('00000000-0000-0000-0000-00000000000a', 'x', 'Salt', 'guess')$$);

SELECT pg_temp.must_fail('ingredient ids are unique per restaurant',
  $$INSERT INTO ingredients (restaurant_id, id, name, source) VALUES ('00000000-0000-0000-0000-00000000000a', '501', 'Basil again', 'app')$$);

SELECT pg_temp.must_fail('an invoice says how it came in',
  $$INSERT INTO supplier_invoices (restaurant_id, vendor_name, invoice_date, source) VALUES ('00000000-0000-0000-0000-00000000000a', 'X', '2026-10-01', 'fax')$$);

SELECT pg_temp.must_fail('a MarginEdge invoice is stored once',
  $$INSERT INTO supplier_invoices (restaurant_id, me_vendor_id, vendor_name, invoice_date, source, me_invoice_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'me-999', 'X', '2026-09-30', 'marginedge', 'inv-1')$$);

SELECT pg_temp.must_fail('an invoice cannot use another restaurant''s vendor',
  $$INSERT INTO supplier_invoices (restaurant_id, vendor_id, vendor_name, invoice_date) VALUES ('00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', 'Produce Co', '2026-10-01')$$);

SELECT pg_temp.must_fail('line numbers are unique on an invoice',
  $$INSERT INTO supplier_invoice_lines (invoice_id, line_number, description, quantity, unit, total) VALUES ('20000000-0000-0000-0000-000000000001', 1, 'Again', 1, 'each', 1)$$);

SELECT pg_temp.must_fail('a photo is a scan status from the list',
  $$INSERT INTO invoice_scans (restaurant_id, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'lost')$$);

SELECT pg_temp.must_fail('invoice pages are photos or PDFs',
  $$INSERT INTO invoice_scan_pages (scan_id, page, media_type, data) VALUES ('30000000-0000-0000-0000-000000000001', 2, 'text/html', '\x00'::bytea)$$);

SELECT pg_temp.must_fail('a learned line holds something',
  $$INSERT INTO vendor_item_matches (restaurant_id, vendor_id, item_key, product_id, unit, per) VALUES ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '#2002', '501', 'lb', 0)$$);

SELECT pg_temp.must_fail('a learned line is for one of our own vendors',
  $$INSERT INTO vendor_item_matches (restaurant_id, vendor_id, item_key, product_id, unit) VALUES ('00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', '#1001', '501', 'lb')$$);

SELECT pg_temp.must_fail('one learned answer per vendor and item',
  $$INSERT INTO vendor_item_matches (restaurant_id, vendor_id, item_key, product_id, unit) VALUES ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '#1001', 'app:1', 'g')$$);

SELECT pg_temp.must_fail('a vendor with invoices cannot be deleted',
  $$DELETE FROM vendors WHERE id = '10000000-0000-0000-0000-000000000001'$$);

-- A vendor without invoices can go, and what was learned for it goes with it.
DELETE FROM vendors WHERE id = '10000000-0000-0000-0000-000000000002';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM vendor_item_matches WHERE item_key = 'mozz fresh') THEN
    RAISE EXCEPTION 'check failed: a removed vendor left its learned lines behind';
  END IF;
  RAISE NOTICE 'ok: removing a vendor removes what was learned for it';
END $$;

-- Deleting an invoice takes its lines and comparisons, and the photo forgets it.
DELETE FROM supplier_invoices WHERE id = '20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM supplier_invoice_lines WHERE invoice_id = '20000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'check failed: lines outlived their invoice'; END IF;
  IF EXISTS (SELECT 1 FROM invoice_comparisons WHERE me_invoice_id = 'inv-0') THEN RAISE EXCEPTION 'check failed: a comparison outlived its invoice'; END IF;
  IF (SELECT invoice_id FROM invoice_scans WHERE id = '30000000-0000-0000-0000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'check failed: the photo still points at a deleted invoice'; END IF;
  RAISE NOTICE 'ok: deleting an invoice takes its lines and comparisons';
END $$;

-- Recipes: one of a name at a time, lines point at what they are, prep items and plans follow by id.
INSERT INTO recipes (restaurant_id, id, name, yields) VALUES
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001', 'Pizza Dough', '[{"amount": 30, "unit": "each"}]'),
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000002', 'Margherita', '[{"amount": 1, "unit": "each"}]');
INSERT INTO recipe_lines (recipe_id, line_number, name, amount, unit, sub_recipe_id) VALUES
  ('40000000-0000-0000-0000-000000000002', 1, 'Pizza Dough', 1, 'each', '40000000-0000-0000-0000-000000000001');
INSERT INTO station_items (restaurant_id, station_id, name, kind, recipe_name) VALUES
  ('00000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001', 'Dough balls', 'count', 'pizza dough');

SELECT pg_temp.must_fail('one recipe of a name at a time',
  $$INSERT INTO recipes (restaurant_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', ' pizza dough')$$);
SELECT pg_temp.must_fail('a line is a recipe or an ingredient, not both',
  $$INSERT INTO recipe_lines (recipe_id, line_number, name, sub_recipe_id, ingredient_id) VALUES ('40000000-0000-0000-0000-000000000002', 2, 'X', '40000000-0000-0000-0000-000000000001', '501')$$);
SELECT pg_temp.must_fail('a dish link is for a recipe of our own',
  $$INSERT INTO dish_links (restaurant_id, kind, catalog_id, item_name, recipe_id) VALUES ('00000000-0000-0000-0000-00000000000b', 'recipe', 'SQ-1', 'Margherita', '40000000-0000-0000-0000-000000000002')$$);
SELECT pg_temp.must_fail('only a recipe link names a recipe',
  $$INSERT INTO dish_links (restaurant_id, kind, catalog_id, item_name, recipe_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'notFood', 'SQ-1', 'Gift card', '40000000-0000-0000-0000-000000000002')$$);

UPDATE recipes SET name = 'Neapolitan Dough' WHERE id = '40000000-0000-0000-0000-000000000001';
-- Taken out, its name is free again.
UPDATE recipes SET removed_at = now() WHERE id = '40000000-0000-0000-0000-000000000002';
INSERT INTO recipes (restaurant_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Margherita');
DO $$ BEGIN
  IF (SELECT recipe_id FROM station_items WHERE name = 'Dough balls') IS DISTINCT FROM '40000000-0000-0000-0000-000000000001' THEN RAISE EXCEPTION 'check failed: a prep item didn''t find its recipe by name'; END IF;
  IF (SELECT recipe_name FROM station_items WHERE name = 'Dough balls') <> 'Neapolitan Dough' THEN RAISE EXCEPTION 'check failed: a prep item kept the old recipe name'; END IF;
  RAISE NOTICE 'ok: prep items find their recipe, and follow a rename';
END $$;

-- The first sketch's tables are gone.
DO $$ BEGIN
  IF to_regclass('public.products') IS NOT NULL OR to_regclass('public.recipe_ingredients') IS NOT NULL OR to_regclass('public.invoices') IS NOT NULL
     OR to_regclass('public.todo_items') IS NOT NULL OR to_regclass('public.menu_links') IS NOT NULL THEN
    RAISE EXCEPTION 'check failed: unused first-sketch tables are still there';
  END IF;
  RAISE NOTICE 'ok: the unused first-sketch tables are gone';
END $$;

SELECT 'all schema checks passed' AS result;

-- The Floor: posts belong to one restaurant, a checklist item is ticked once a night, and an iPad
-- set to a removed post goes back to not being set.
INSERT INTO floor_posts (id, restaurant_id, name, kind, tables) VALUES
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Patio', 'room', '{T1,T2}');
INSERT INTO floor_checklists (id, restaurant_id, post_id, kind, name) VALUES
  ('81000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', 'opening', 'Wipe the tables');
INSERT INTO floor_checks (restaurant_id, checklist_id, day, done_by) VALUES
  ('00000000-0000-0000-0000-00000000000a', '81000000-0000-0000-0000-000000000001', '2026-10-08', '70000000-0000-0000-0000-000000000001');
INSERT INTO devices (id, restaurant_id, name, token_hash, floor_post_id) VALUES
  ('82000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Patio iPad', 'x', '80000000-0000-0000-0000-000000000001');

SELECT pg_temp.must_fail('a post is a room, the bar, the counter or the host stand',
  $$INSERT INTO floor_posts (restaurant_id, name, kind) VALUES ('00000000-0000-0000-0000-00000000000a', 'Kitchen', 'kitchen')$$);
SELECT pg_temp.must_fail('one post of a name',
  $$INSERT INTO floor_posts (restaurant_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'patio')$$);
SELECT pg_temp.must_fail('an iPad cannot be set to another restaurant''s post',
  $$INSERT INTO devices (restaurant_id, name, token_hash, floor_post_id) VALUES ('00000000-0000-0000-0000-00000000000b', 'Theirs', 'y', '80000000-0000-0000-0000-000000000001')$$);
SELECT pg_temp.must_fail('a checklist item is ticked once a night',
  $$INSERT INTO floor_checks (restaurant_id, checklist_id, day) VALUES ('00000000-0000-0000-0000-00000000000a', '81000000-0000-0000-0000-000000000001', '2026-10-08')$$);
SELECT pg_temp.must_fail('a note cannot end before it starts',
  $$INSERT INTO floor_notes (restaurant_id, starts_on, ends_on, body) VALUES ('00000000-0000-0000-0000-00000000000a', '2026-10-08', '2026-10-07', 'x')$$);
SELECT pg_temp.must_fail('a report says where it came from',
  $$INSERT INTO floor_reports (restaurant_id, day, source) VALUES ('00000000-0000-0000-0000-00000000000a', '2026-10-08', 'fax')$$);

DELETE FROM floor_posts WHERE id = '80000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF (SELECT floor_post_id FROM devices WHERE id = '82000000-0000-0000-0000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'check failed: an iPad still points at a removed post'; END IF;
  IF EXISTS (SELECT 1 FROM floor_checks WHERE checklist_id = '81000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'check failed: a removed post''s checklist outlived it'; END IF;
  IF NOT EXISTS (SELECT 1 FROM devices WHERE id = '82000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'check failed: removing a post removed its iPad'; END IF;
  RAISE NOTICE 'ok: removing a post unsets its iPad and takes its checklists';
END $$;
