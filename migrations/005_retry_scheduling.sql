-- Durable retry scheduling: failed attempts can be rescheduled; the database holds the schedule.

-- The due time is now explicitly "when the next attempt may start".
ALTER TABLE deliveries RENAME COLUMN available_at TO next_attempt_at;

ALTER TABLE deliveries DROP CONSTRAINT deliveries_state_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_state_check
  CHECK (state IN ('pending', 'retry_scheduled', 'in_progress', 'delivered', 'failed'));

-- Why a delivery ended in 'failed'. NULL for deliveries that failed before this stage existed.
ALTER TABLE deliveries ADD COLUMN failure_reason text
  CHECK (failure_reason IN ('non_retryable', 'attempts_exhausted'));
ALTER TABLE deliveries ADD CONSTRAINT deliveries_failure_reason_matches_state
  CHECK (failure_reason IS NULL OR state = 'failed');

-- Workers look for due work in both waiting states.
DROP INDEX deliveries_due_idx;
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at)
  WHERE state IN ('pending', 'retry_scheduled');

-- Whether a failed attempt's result was worth retrying (NULL when not applicable or unknown).
ALTER TABLE delivery_attempts ADD COLUMN retryable boolean;
