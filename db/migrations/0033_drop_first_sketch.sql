-- Tables from the very first sketch of the schema that the app never came to use: recipes,
-- products and invoices now live in the kitchen book, the ingredient list and the one invoice
-- store (supplier_invoices); prep, counts and to-dos have their own tables since 0005.
--
-- Nothing ever wrote to them, so they should be empty. If one somehow isn't, it's moved to the
-- `retired` schema rather than dropped, so nothing is lost.

DO $$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'breakdown_log_outputs', 'breakdown_logs', 'breakdown_outputs',
    'count_lines', 'count_sessions', 'waste_entries', 'prep_tasks', 'prep_batches',
    'menu_link_components', 'menu_links', 'menu_entries', 'menus', 'menu_name_aliases', 'modifier_effects',
    'custom_units', 'recipe_ingredients', 'product_prices', 'invoice_lines', 'invoices', 'vendor_items',
    'recipes', 'products', 'vendor_delivery_days', 'station_assignments', 'job_title_stations',
    'todo_items', 'questions'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
    IF has_rows THEN
      CREATE SCHEMA IF NOT EXISTS retired;
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA retired', t);
      RAISE NOTICE 'kept %: it has rows, moved to retired.%', t, t;
    ELSE
      EXECUTE format('DROP TABLE public.%I CASCADE', t);
    END IF;
  END LOOP;
END $$;
