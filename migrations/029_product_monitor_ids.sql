BEGIN;

-- Product-monitor membership (#78, design D5): the monitors that observed
-- the product in its latest imported scan. The importer overwrites it on
-- every upsert from the feed product's monitor_ids.
ALTER TABLE products
  ADD COLUMN monitor_ids TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX products_monitor_ids_idx
  ON products USING GIN (monitor_ids);

-- Backfill from the preserved feed object with the same rules as the
-- importer (normalizeProductMonitorIds in lib/monitor-definitions.mts):
-- only string entries of at most 120 characters matching the monitor ID
-- pattern are kept, in feed order, and at most the first 20 of them. A
-- missing or non-array raw_data.monitor_ids keeps the '{}' default. Only
-- the new column is written.
UPDATE products
SET monitor_ids = ARRAY(
  SELECT entry.value #>> '{}'
  FROM jsonb_array_elements(products.raw_data -> 'monitor_ids')
    WITH ORDINALITY AS entry(value, position)
  WHERE jsonb_typeof(entry.value) = 'string'
    AND char_length(entry.value #>> '{}') <= 120
    AND (entry.value #>> '{}') ~ '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$'
  ORDER BY entry.position
  LIMIT 20
)
WHERE jsonb_typeof(raw_data -> 'monitor_ids') = 'array';

COMMIT;
