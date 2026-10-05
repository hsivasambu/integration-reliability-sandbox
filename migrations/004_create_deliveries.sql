-- Delivery state moves out of events: an event is immutable data; its delivery is a job with state.

-- One delivery job per event. PostgreSQL is the durable job store.
CREATE TABLE deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL UNIQUE REFERENCES events (id) ON DELETE CASCADE,
  state             text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'in_progress', 'delivered', 'failed')),
  -- When the job becomes due. Workers only claim pending jobs whose time has come.
  available_at      timestamptz NOT NULL DEFAULT now(),
  -- Set only while a worker holds the job. The token is unique per claim.
  claim_token       uuid,
  lease_expires_at  timestamptz,
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,

  -- A claim exists exactly when the job is in progress, and a finish time exactly when it is finished.
  CONSTRAINT deliveries_claim_matches_state CHECK (
    (state = 'in_progress') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT deliveries_completed_matches_state CHECK (
    (state IN ('delivered', 'failed')) = (completed_at IS NOT NULL))
);

CREATE INDEX deliveries_due_idx ON deliveries (available_at) WHERE state = 'pending';
CREATE INDEX deliveries_lease_idx ON deliveries (lease_expires_at) WHERE state = 'in_progress';

-- One row per HTTP attempt, written before the request is sent.
CREATE TABLE delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  attempt_number   integer NOT NULL CHECK (attempt_number >= 1),
  claim_token      uuid NOT NULL UNIQUE,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  -- lease_expired: the worker lost its lease before reporting; the real result is unknown.
  outcome          text NOT NULL DEFAULT 'in_progress'
                   CHECK (outcome IN ('in_progress', 'delivered', 'failed', 'lease_expired')),
  response_status  integer CHECK (response_status BETWEEN 100 AND 599),
  error_category   text CHECK (error_category IN ('http_error', 'timeout', 'network_error', 'lease_expired')),
  duration_ms      integer CHECK (duration_ms >= 0),

  UNIQUE (delivery_id, attempt_number),
  CONSTRAINT attempts_error_matches_outcome CHECK (
    (outcome IN ('failed', 'lease_expired')) = (error_category IS NOT NULL))
);

-- Existing events (created before this stage) get a pending delivery too.
INSERT INTO deliveries (event_id, created_at) SELECT id, created_at FROM events;

-- events.status would now contradict deliveries.state, so it is removed.
ALTER TABLE events DROP COLUMN status;
