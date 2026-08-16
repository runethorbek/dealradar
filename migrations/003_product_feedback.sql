BEGIN;

CREATE TABLE product_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('like', 'dislike')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id)
);

COMMIT;
