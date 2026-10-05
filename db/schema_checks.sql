-- Sanity checks for schema.sql: loads sample rows and confirms the guard rails hold.
-- Run with scripts/check-schema.sh. Any failed check raises an error.

\set ON_ERROR_STOP on

INSERT INTO restaurants (id, name) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Our restaurant'),
  ('00000000-0000-0000-0000-00000000000b', 'Another restaurant');

INSERT INTO vendors (id, restaurant_id, name, order_email) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Produce Co', 'orders@example.com');

INSERT INTO products (id, restaurant_id, name, base_unit, count_policy) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Garlic', 'lb', 'occasional'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Heavy cream', 'qt', 'must_count');

INSERT INTO recipes (id, restaurant_id, name, kind, yield_amount, yield_unit, shelf_life_days, status) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Chopped garlic', 'prep', 1, 'cup', 3, 'complete'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Vodka sauce', 'prep', 4, 'qt', 5, 'partial'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Rigatoni alla vodka', 'dish', 1, 'each', NULL, 'draft');

INSERT INTO recipe_ingredients (restaurant_id, recipe_id, product_id, sub_recipe_id, amount, unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', NULL, 0.5, 'lb'),
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', NULL, '30000000-0000-0000-0000-000000000001', 0.25, 'cup'),
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', NULL, 1, 'qt'),
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', NULL, '30000000-0000-0000-0000-000000000002', 1, 'cup');

INSERT INTO custom_units (restaurant_id, recipe_id, name, amount, unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', 'sixth pan', 2, 'qt');

INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, status, matched_by) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', 'item', 'Rigatoni alla vodka', 'linked', 'name'),
  -- Same POS id, renamed to a dish with no recipe yet: its own row.
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'penne arrabbiata', 'item', 'Penne Arrabbiata', 'awaiting_recipe', 'name');
INSERT INTO menu_link_components (restaurant_id, pos_catalog_id, pos_name_key, effective_from, recipe_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', '-infinity', '30000000-0000-0000-0000-000000000003');
-- A seasonal version of the same button from a later date.
INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, matched_by, effective_from) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', 'item', 'Rigatoni alla vodka', 'name', '2026-09-15');
-- A half portion sold as a size, and a deli salad sold by the pound.
INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, matched_by, sale_unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI-HALF', 'rigatoni alla vodka half', 'item', 'Rigatoni alla vodka (Half)', 'name', NULL),
  ('00000000-0000-0000-0000-00000000000a', 'SQ-SAUCE-LB', 'vodka sauce by lb', 'item', 'Vodka sauce by the lb', 'name', 'lb');
INSERT INTO menu_link_components (restaurant_id, pos_catalog_id, pos_name_key, effective_from, recipe_id, amount, unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI-HALF', 'rigatoni alla vodka half', '-infinity', '30000000-0000-0000-0000-000000000003', 0.5, 'each'),
  ('00000000-0000-0000-0000-00000000000a', 'SQ-SAUCE-LB', 'vodka sauce by lb', '-infinity', '30000000-0000-0000-0000-000000000002', 1, 'lb');
-- A cup of gelato built from a flavor choice: each flavor uses the cup's 4 oz.
INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, matched_by, choice_amount, choice_unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-GELATO-4', '4oz gelato', 'item', '4oz Gelato', 'name', 4, 'oz');

INSERT INTO modifier_effects (restaurant_id, modifier_key, effect, product_id, share_of_dish, source) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'topping|extra garlic', 'add', '20000000-0000-0000-0000-000000000001', 0.5, 'manager');
INSERT INTO modifier_effects (restaurant_id, modifier_key, effect, note) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'topping|lamb meatball', 'waiting', 'card not in yet');

INSERT INTO stations (id, restaurant_id, name, sort_order) VALUES
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Sauté', 1),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Prep', 2);
INSERT INTO job_title_permissions (restaurant_id, job_title, permissions, role_level) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Line Cook', '{prep.view,prep.log}', 'line'),
  ('00000000-0000-0000-0000-00000000000a', 'Chef', '{prep.view,prep.log,prep.all_stations}', 'chef');
INSERT INTO job_title_stations (restaurant_id, job_title, station_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Line Cook', '60000000-0000-0000-0000-000000000001');
INSERT INTO staff (id, restaurant_id, display_name, job_title) VALUES
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Sam', 'Line Cook');
INSERT INTO station_assignments (restaurant_id, business_date, station_id, staff_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', current_date, '60000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001');
UPDATE recipes SET station_id = '60000000-0000-0000-0000-000000000002' WHERE id = '30000000-0000-0000-0000-000000000002';

INSERT INTO menus (id, restaurant_id, name) VALUES
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Dinner');
INSERT INTO menu_entries (restaurant_id, menu_id, recipe_id, section, starts_on, ends_on, dates_from) VALUES
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Pasta', '2026-05-26', '2026-08-15', 'sales');

-- A whole fish broken down into fillets, trim, bones and waste.
INSERT INTO products (id, restaurant_id, name, base_unit) VALUES
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Snapper, whole', 'lb'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Snapper fillet', 'lb'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'Snapper bones', 'lb');
INSERT INTO recipes (id, restaurant_id, name, kind, yield_amount, yield_unit, station_id) VALUES
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Snapper breakdown', 'breakdown', 10, 'lb', '60000000-0000-0000-0000-000000000002');
INSERT INTO recipe_ingredients (restaurant_id, recipe_id, product_id, amount, unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000003', 10, 'lb');
INSERT INTO breakdown_outputs (id, restaurant_id, recipe_id, name, output_product_id, standard_share, valuation, fixed_price, fixed_per_unit) VALUES
  ('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 'Fillets', '20000000-0000-0000-0000-000000000004', 0.45, 'main', NULL, NULL),
  ('90000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 'Bones & heads', '20000000-0000-0000-0000-000000000005', 0.25, 'fixed', 0, 'lb'),
  ('90000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 'Waste', NULL, 0.20, 'waste', NULL, NULL);
INSERT INTO breakdown_logs (id, restaurant_id, recipe_id, input_amount, input_unit, performed_by) VALUES
  ('91000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 12, 'lb', '70000000-0000-0000-0000-000000000001');
INSERT INTO breakdown_log_outputs (restaurant_id, log_id, output_id, amount, unit) VALUES
  ('00000000-0000-0000-0000-00000000000a', '91000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 4.6, 'lb');

INSERT INTO prep_tasks (restaurant_id, business_date, station_id, recipe_id, amount, unit, suggested_order, status, completed_at, completed_by) VALUES
  ('00000000-0000-0000-0000-00000000000a', current_date, '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 1, 'sixth pan', 1, 'done', now(), '70000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', current_date, '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 1, 'cup', 2, 'open', NULL, NULL);
INSERT INTO menu_name_aliases (restaurant_id, name_key, recipe_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'rigatoni vodka', '30000000-0000-0000-0000-000000000003');

INSERT INTO prep_batches (id, restaurant_id, recipe_id, amount, unit, use_by) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', 1, 'sixth pan', now() + interval '5 days');

INSERT INTO count_sessions (id, restaurant_id, kind, business_date) VALUES
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'prep_nightly', current_date);
INSERT INTO count_lines (restaurant_id, session_id, recipe_id, prep_batch_id, amount, unit, expected_amount) VALUES
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 0.5, 'sixth pan', 0.6);

INSERT INTO waste_entries (restaurant_id, recipe_id, prep_batch_id, amount, unit, reason) VALUES
  ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 0.5, 'sixth pan', 'expired');

INSERT INTO todo_items (restaurant_id, category, title, required_permission, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'prep', 'Vodka sauce expires tomorrow', 'prep.view', 'expiring:40000000-0000-0000-0000-000000000001');

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

SELECT pg_temp.must_fail('another restaurant cannot use our product',
  $q$INSERT INTO recipe_ingredients (restaurant_id, recipe_id, product_id, amount, unit)
     VALUES ('00000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'lb')$q$);

SELECT pg_temp.must_fail('an ingredient must be a product or a recipe, not both',
  $q$INSERT INTO recipe_ingredients (restaurant_id, recipe_id, product_id, sub_recipe_id, amount, unit)
     VALUES ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'lb')$q$);

SELECT pg_temp.must_fail('a recipe cannot contain itself directly',
  $q$INSERT INTO recipe_ingredients (restaurant_id, recipe_id, sub_recipe_id, amount, unit)
     VALUES ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 1, 'qt')$q$);

SELECT pg_temp.must_fail('dishes yield portions',
  $q$INSERT INTO recipes (restaurant_id, name, kind, yield_amount, yield_unit)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'Soup of the day', 'dish', 1, 'qt')$q$);

SELECT pg_temp.must_fail('only one open to-do item per problem',
  $q$INSERT INTO todo_items (restaurant_id, category, title, required_permission, dedupe_key)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'prep', 'Duplicate', 'prep.view', 'expiring:40000000-0000-0000-0000-000000000001')$q$);

SELECT pg_temp.must_fail('waste needs a reason from the list',
  $q$INSERT INTO waste_entries (restaurant_id, product_id, amount, unit, reason)
     VALUES ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000001', 1, 'lb', 'vibes')$q$);

SELECT pg_temp.must_fail('a component amount needs a unit',
  $$INSERT INTO menu_link_components (restaurant_id, pos_catalog_id, pos_name_key, effective_from, recipe_id, amount)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', '-infinity', '30000000-0000-0000-0000-000000000002', 2)$$);

SELECT pg_temp.must_fail('a component is a recipe or a product, not both',
  $$INSERT INTO menu_link_components (restaurant_id, pos_catalog_id, pos_name_key, effective_from, recipe_id, product_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', '-infinity', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001')$$);

SELECT pg_temp.must_fail('a manager answer records who answered',
  $$INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, matched_by)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'SQ-SIDE', 'side sauce', 'item', 'Side sauce', 'manager')$$);

SELECT pg_temp.must_fail('a menu link component cannot point at another restaurant''s recipe',
  $$INSERT INTO menu_link_components (restaurant_id, pos_catalog_id, pos_name_key, effective_from, recipe_id)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'SQ-RIGATONI', 'rigatoni alla vodka', '-infinity', '30000000-0000-0000-0000-000000000003')$$);

SELECT pg_temp.must_fail('an add-on says how much: an amount or a share of the dish',
  $$INSERT INTO modifier_effects (restaurant_id, modifier_key, effect, product_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'topping|extra cream', 'add', '20000000-0000-0000-0000-000000000002')$$);

SELECT pg_temp.must_fail('waste is not an inventory item',
  $$INSERT INTO breakdown_outputs (restaurant_id, recipe_id, name, output_product_id, standard_share, valuation)
    VALUES ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 'Scales', '20000000-0000-0000-0000-000000000005', 0.05, 'waste')$$);

SELECT pg_temp.must_fail('a by-product valued at a fixed price says the price',
  $$INSERT INTO breakdown_outputs (restaurant_id, recipe_id, name, standard_share, valuation)
    VALUES ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', 'Trim', 0.1, 'fixed')$$);

SELECT pg_temp.must_fail('a finished prep task records who finished it',
  $$INSERT INTO prep_tasks (restaurant_id, business_date, recipe_id, amount, unit, suggested_order, status, completed_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', current_date, '30000000-0000-0000-0000-000000000001', 1, 'cup', 3, 'done', now())$$);

SELECT pg_temp.must_fail('a menu entry cannot end before it starts',
  $$INSERT INTO menu_entries (restaurant_id, menu_id, recipe_id, starts_on, ends_on)
    VALUES ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '2026-08-18', '2026-08-15')$$);

SELECT pg_temp.must_fail('a station belongs to its own restaurant''s job titles',
  $$INSERT INTO job_title_stations (restaurant_id, job_title, station_id)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'Line Cook', '60000000-0000-0000-0000-000000000001')$$);

SELECT pg_temp.must_fail('custom unit names are unique per item',
  $q$INSERT INTO custom_units (restaurant_id, recipe_id, name, amount, unit)
     VALUES ('00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', 'sixth pan', 3, 'qt')$q$);

-- Deleting a vendor that a product prefers clears the preference but keeps the product.
UPDATE products SET preferred_vendor_id = '10000000-0000-0000-0000-000000000001' WHERE name = 'Garlic';
DELETE FROM vendors WHERE id = '10000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF (SELECT restaurant_id FROM products WHERE name = 'Garlic') IS NULL THEN
    RAISE EXCEPTION 'check failed: clearing a preferred vendor cleared the restaurant';
  END IF;
  RAISE NOTICE 'ok: removing a vendor keeps the product and its restaurant';
END $$;

-- A done item frees the key for a new open item.
UPDATE todo_items SET status = 'done' WHERE dedupe_key = 'expiring:40000000-0000-0000-0000-000000000001';
INSERT INTO todo_items (restaurant_id, category, title, required_permission, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'prep', 'New batch expiring', 'prep.view', 'expiring:40000000-0000-0000-0000-000000000001');

SELECT 'all schema checks passed' AS result;
