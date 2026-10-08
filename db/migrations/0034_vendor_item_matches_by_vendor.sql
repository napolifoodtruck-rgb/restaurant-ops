-- What a vendor's line means (learned when a manager confirms a photo invoice), keyed by the
-- vendor itself rather than its name: a vendor renamed, or spelled two ways on its invoices,
-- keeps what was learned. Rows learned so far are carried over by matching the name the same
-- way the app does (lower case, punctuation and "Inc", "LLC", "Co"... dropped).

ALTER TABLE vendor_item_matches ADD COLUMN vendor_id uuid;

UPDATE vendor_item_matches m SET vendor_id = v.id
  FROM (
    SELECT DISTINCT ON (restaurant_id, key) restaurant_id, key, id
      FROM (SELECT restaurant_id, id, me_vendor_id, btrim(regexp_replace(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g'),
                     '\y(inc|llc|co|corp|ltd|company|the)\y', '', 'g'), '\s+', ' ', 'g')) AS key
              FROM vendors) k
     ORDER BY restaurant_id, key, (me_vendor_id IS NULL), id
  ) v
 WHERE v.restaurant_id = m.restaurant_id AND v.key = m.vendor_key;

-- A learned row for a vendor that no longer exists has nothing to attach to.
DELETE FROM vendor_item_matches WHERE vendor_id IS NULL;

-- One answer per vendor and item: when two old name spellings land on the same vendor, the
-- latest confirmation wins.
DELETE FROM vendor_item_matches m USING vendor_item_matches n
 WHERE m.restaurant_id = n.restaurant_id AND m.vendor_id = n.vendor_id AND m.item_key = n.item_key
   AND (m.confirmed_at, m.vendor_key) < (n.confirmed_at, n.vendor_key);

ALTER TABLE vendor_item_matches DROP CONSTRAINT vendor_item_matches_pkey;
ALTER TABLE vendor_item_matches DROP COLUMN vendor_key;
ALTER TABLE vendor_item_matches ALTER COLUMN vendor_id SET NOT NULL;
ALTER TABLE vendor_item_matches ADD PRIMARY KEY (restaurant_id, vendor_id, item_key);
ALTER TABLE vendor_item_matches ADD FOREIGN KEY (restaurant_id, vendor_id) REFERENCES vendors (restaurant_id, id) ON DELETE CASCADE;
