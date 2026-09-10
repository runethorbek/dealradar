BEGIN;

ALTER TABLE products
  DROP COLUMN target_size,
  DROP COLUMN category;

COMMIT;
