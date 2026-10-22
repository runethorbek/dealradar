BEGIN;

-- Daily summaries (#80, design D11 and D13). One row per Europe/Copenhagen
-- summary date, so at most one summary exists and at most one is sent per
-- date. content is the selection and message persisted before the first send
-- attempt, so a retry resends the same content with the same
-- client_message_id. A send attempt claims the row with claimed_at and
-- claim_token (a lease, as for evaluation-run notifications); a failed send
-- releases the claim. Additive only.
CREATE TABLE daily_summaries (
  summary_date DATE PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent')),
  content JSONB NOT NULL,
  client_message_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT daily_summaries_sent_at_check CHECK (
    (status = 'sent') = (sent_at IS NOT NULL)
  )
);

COMMIT;
