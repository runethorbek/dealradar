BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN notification_client_message_id TEXT;

CREATE UNIQUE INDEX evaluation_runs_notification_client_message_id_idx
  ON evaluation_runs (notification_client_message_id)
  WHERE notification_client_message_id IS NOT NULL;

COMMIT;
