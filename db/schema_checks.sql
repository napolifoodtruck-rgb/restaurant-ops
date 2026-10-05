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

INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, recipe_id, matched_by) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'rigatoni alla vodka', 'item', 'Rigatoni alla vodka', '30000000-0000-0000-0000-000000000003', 'name'),
  -- Same POS id, renamed to a dish with no recipe yet: its own row.
  ('00000000-0000-0000-0000-00000000000a', 'SQ-RIGATONI', 'penne arrabbiata', 'item', 'Penne Arrabbiata', NULL, 'name');
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

SELECT pg_temp.must_fail('a portion needs a unit',
  $$INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, recipe_id, portion_amount, matched_by)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'SQ-SIDE', 'side sauce', 'item', 'Side sauce', '30000000-0000-0000-0000-000000000002', 2, 'name')$$);

SELECT pg_temp.must_fail('a manager answer records who answered',
  $$INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, recipe_id, matched_by)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'SQ-SIDE', 'side sauce', 'item', 'Side sauce', '30000000-0000-0000-0000-000000000002', 'manager')$$);

SELECT pg_temp.must_fail('a menu link cannot point at another restaurant''s recipe',
  $$INSERT INTO menu_links (restaurant_id, pos_catalog_id, pos_name_key, kind, pos_name, recipe_id, matched_by)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'SQ-X', 'x', 'item', 'X', '30000000-0000-0000-0000-000000000003', 'name')$$);

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
