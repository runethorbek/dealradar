BEGIN;

ALTER TABLE application_settings
ADD COLUMN gemini JSONB NOT NULL DEFAULT '{"automaticEvaluationLimit":50}'::JSONB;

COMMIT;
