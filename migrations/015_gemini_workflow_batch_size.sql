BEGIN;

ALTER TABLE application_settings
ALTER COLUMN gemini SET DEFAULT '{"automaticEvaluationLimit":50,"workflowBatchSize":5}'::JSONB;

COMMIT;
