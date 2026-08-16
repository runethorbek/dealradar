BEGIN;

ALTER TABLE products
  ALTER COLUMN image_url DROP NOT NULL,
  ALTER COLUMN current_price DROP NOT NULL;

ALTER TABLE product_snapshots
  ALTER COLUMN current_price DROP NOT NULL;

DROP INDEX IF EXISTS product_snapshots_product_observed_at_idx;

CREATE UNIQUE INDEX product_snapshots_product_observed_at_idx
  ON product_snapshots (product_id, observed_at);

COMMIT;
