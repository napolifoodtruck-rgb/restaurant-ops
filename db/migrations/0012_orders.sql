-- Ordering. A vendor's delivery days are learned from invoice dates; a manager confirms them
-- and adds when orders are due and how they're sent. Orders are drafts until a manager
-- approves them, and are only marked sent after that.
CREATE TABLE vendor_settings (
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  vendor_id           text NOT NULL,                -- MarginEdge vendor id
  weekdays            integer[],                    -- confirmed delivery days (null: as learned)
  cutoff_days_before  integer CHECK (cutoff_days_before BETWEEN 0 AND 7),
  cutoff_time         text CHECK (cutoff_time ~ '^\d{2}:\d{2}$'),
  method              text CHECK (method IN ('email', 'text', 'phone', 'portal', 'rep', 'in person')),
  contact             text,
  minimum             numeric(10,2),
  active              boolean NOT NULL DEFAULT true,
  note                text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, vendor_id)
);

CREATE TABLE orders (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  vendor_id           text NOT NULL,
  vendor_name         text NOT NULL,
  delivery            date NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'cancelled')),
  lines               jsonb NOT NULL DEFAULT '[]',
  total               numeric(12,2),
  note                text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid,
  approved_at         timestamptz,
  sent_by             uuid,
  sent_at             timestamptz,
  PRIMARY KEY (id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, created_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (created_by),
  FOREIGN KEY (restaurant_id, approved_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (approved_by),
  FOREIGN KEY (restaurant_id, sent_by) REFERENCES staff (restaurant_id, id) ON DELETE SET NULL (sent_by)
);
-- One open order per vendor and delivery.
CREATE UNIQUE INDEX orders_open ON orders (restaurant_id, vendor_id, delivery) WHERE status <> 'cancelled';
