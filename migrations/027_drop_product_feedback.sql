BEGIN;

-- Like / Not for me feedback was removed from DealRadar (#66). Apply only
-- after the application that no longer reads product_feedback is deployed,
-- and after the existing Not for me products have been reviewed for the
-- preference profile. This permanently deletes the stored feedback rows.
DROP TABLE product_feedback;

COMMIT;
