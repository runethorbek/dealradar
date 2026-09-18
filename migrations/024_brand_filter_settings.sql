BEGIN;

ALTER TABLE application_settings
ADD COLUMN brand_filter JSONB NOT NULL DEFAULT '{"preferredBrands":[]}'::JSONB;

COMMIT;
