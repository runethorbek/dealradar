BEGIN;

CREATE TABLE product_evaluations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  preference_score INTEGER NOT NULL CHECK (preference_score BETWEEN 0 AND 10),
  deal_score INTEGER NOT NULL CHECK (deal_score BETWEEN 0 AND 10),
  reason TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id)
);

COMMIT;
