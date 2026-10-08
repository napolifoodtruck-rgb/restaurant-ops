-- Pickup windows go from 20 to 15 minutes (the chef asked). Each new window starts with the limit of
-- the old window its start fell in: 5:00 and 5:15 take what 5:00 took, 5:30 what 5:20 took, 5:45
-- what 5:40 took. Then the old 5:20 and 5:40 style rows go. Orders keep the time they were given.
WITH new_starts AS (
  SELECT time '17:00' + i * interval '15 minutes' AS starts FROM generate_series(0, 15) AS i
)
INSERT INTO pickup_window_plan (restaurant_id, weekday, starts, max_pizzas, updated_by)
SELECT p.restaurant_id, p.weekday, n.starts, p.max_pizzas, p.updated_by
FROM pickup_window_plan p JOIN new_starts n ON n.starts >= p.starts AND n.starts < p.starts + interval '20 minutes'
ON CONFLICT (restaurant_id, weekday, starts) DO NOTHING;
DELETE FROM pickup_window_plan WHERE extract(minute FROM starts)::int % 15 <> 0;

WITH new_starts AS (
  SELECT time '17:00' + i * interval '15 minutes' AS starts FROM generate_series(0, 15) AS i
)
INSERT INTO pickup_window_days (restaurant_id, day, starts, max_pizzas, note, updated_by)
SELECT d.restaurant_id, d.day, n.starts, d.max_pizzas, d.note, d.updated_by
FROM pickup_window_days d JOIN new_starts n ON n.starts >= d.starts AND n.starts < d.starts + interval '20 minutes'
ON CONFLICT (restaurant_id, day, starts) DO NOTHING;
DELETE FROM pickup_window_days WHERE extract(minute FROM starts)::int % 15 <> 0;
