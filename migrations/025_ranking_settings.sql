BEGIN;

ALTER TABLE application_settings
ADD COLUMN ranking JSONB NOT NULL DEFAULT '{"preferenceWeightPercent":60}'::JSONB;

COMMIT;
