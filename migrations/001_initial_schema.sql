BEGIN;

CREATE TABLE products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  external_url TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  current_price NUMERIC(12, 2) NOT NULL,
  original_price NUMERIC(12, 2),
  currency TEXT,
  discount_percent NUMERIC(5, 2),
  target_size TEXT,
  available BOOLEAN,
  brand TEXT,
  category TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX products_source_external_url_idx
  ON products (source, external_url);

CREATE INDEX products_last_seen_at_idx
  ON products (last_seen_at DESC);

CREATE TABLE product_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_price NUMERIC(12, 2) NOT NULL,
  original_price NUMERIC(12, 2),
  discount_percent NUMERIC(5, 2),
  available BOOLEAN
);

CREATE INDEX product_snapshots_product_observed_at_idx
  ON product_snapshots (product_id, observed_at DESC);

CREATE INDEX product_snapshots_observed_at_idx
  ON product_snapshots (observed_at DESC);

COMMIT;
