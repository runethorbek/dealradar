BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN notification_claim_token TEXT;

UPDATE evaluation_runs
SET notification_client_message_id = concat(
  substr(md5('dealradar:evaluation-run:' || id::TEXT), 1, 8), '-',
  substr(md5('dealradar:evaluation-run:' || id::TEXT), 9, 4), '-4',
  substr(md5('dealradar:evaluation-run:' || id::TEXT), 14, 3), '-8',
  substr(md5('dealradar:evaluation-run:' || id::TEXT), 18, 3), '-',
  substr(md5('dealradar:evaluation-run:' || id::TEXT), 21, 12)
)
WHERE notification_client_message_id IS NOT NULL;

COMMIT;
