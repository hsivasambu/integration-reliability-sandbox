-- Events submitted by a demo session. Delivery state starts (and, in this stage, stays) 'pending'.
CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Internal insertion order, used only for pagination cursors.
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- Events are removed together with their (expired) session.
  session_id       uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type = 'demo.notification'),
  payload          jsonb NOT NULL,
  idempotency_key  text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 100),
  -- SHA-256 of the canonical JSON of the validated type + payload.
  request_hash     bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- The idempotency guarantee: one event per key per session, enforced by the database
  -- even when identical requests arrive at the same moment.
  CONSTRAINT events_session_idempotency_key_unique UNIQUE (session_id, idempotency_key)
);

CREATE INDEX events_session_seq_idx ON events (session_id, seq DESC);
