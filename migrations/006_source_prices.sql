BEGIN;

ALTER TABLE products
  ADD COLUMN source_current_price NUMERIC(12, 2),
  ADD COLUMN source_original_price NUMERIC(12, 2),
  ADD COLUMN source_currency TEXT;

ALTER TABLE product_snapshots
  ADD COLUMN source_current_price NUMERIC(12, 2),
  ADD COLUMN source_original_price NUMERIC(12, 2),
  ADD COLUMN source_currency TEXT;

COMMIT;
