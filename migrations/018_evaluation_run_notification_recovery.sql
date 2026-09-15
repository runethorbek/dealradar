BEGIN;

-- notification_sent means Slack delivery succeeded; claimed_at is a recoverable lease.
UPDATE evaluation_runs
SET notification_claimed_at = NULL
WHERE notification_sent = TRUE;

COMMIT;
