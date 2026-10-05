-- Operational visibility and bounded retention.

-- Each running worker writes a heartbeat here (about every 10 s). Readiness of the database says
-- nothing about whether a worker is alive; this table does.
CREATE TABLE worker_heartbeats (
  worker_id          text PRIMARY KEY,
  started_at         timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at         timestamptz,
  concurrency        integer NOT NULL CHECK (concurrency >= 1),
  in_flight          integer NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  attempts_finished  bigint NOT NULL DEFAULT 0 CHECK (attempts_finished >= 0)
);

-- Deliveries whose session expired before they finished are cancelled with this reason.
ALTER TABLE deliveries DROP CONSTRAINT deliveries_failure_reason_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_failure_reason_check
  CHECK (failure_reason IN ('non_retryable', 'attempts_exhausted', 'session_expired'));

-- (Cleanup finds expired sessions oldest first via demo_sessions_expires_at_idx from migration 001.)
