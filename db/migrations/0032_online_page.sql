-- The online order page's own content: a header photo and a line of text over it. One row per
-- restaurant, once someone sets either.
CREATE TABLE online_page (
  restaurant_id            uuid PRIMARY KEY REFERENCES restaurants ON DELETE CASCADE,
  header_text              text,
  header_image             bytea,
  header_image_type        text CHECK (header_image_type IN ('image/png', 'image/jpeg', 'image/webp')),
  header_image_updated_at  timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  FOREIGN KEY (restaurant_id, updated_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (updated_by)
);
