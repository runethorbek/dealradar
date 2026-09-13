BEGIN;

CREATE TABLE application_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  vinted JSONB NOT NULL DEFAULT '{"minimumCondition":null,"excludedBrands":[]}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO application_settings (id)
VALUES (1);

COMMIT;
