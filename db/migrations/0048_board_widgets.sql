-- Each Service post's board: the widgets a manager chose, in order, each small or wide
-- ([{ "type": "dough", "size": "wide" }, { "type": "sales", "size": "small", "category": "Cocktails" }]).
-- Null: the defaults for the post's kind (core/widgets.ts).
ALTER TABLE floor_posts ADD COLUMN widgets jsonb CHECK (widgets IS NULL OR jsonb_typeof(widgets) = 'array');
