BEGIN;

ALTER TABLE product_snapshots
  ADD COLUMN currency TEXT;

COMMIT;
