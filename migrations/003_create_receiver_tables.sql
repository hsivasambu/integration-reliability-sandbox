-- Mock receiver configuration, one row per demo session. No row means the default mode, 'success'.
CREATE TABLE receiver_settings (
  session_id  uuid PRIMARY KEY REFERENCES demo_sessions (id) ON DELETE CASCADE,
  mode        text NOT NULL DEFAULT 'success'
              CHECK (mode IN ('success', 'server_error', 'timeout')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- What the mock receiver actually processed. Only 'success' mode writes here.
-- event_id is not a foreign key: the receiver stands in for an external system
-- that only knows what it was sent.
CREATE TABLE receiver_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  event_id     uuid NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX receiver_receipts_session_idx ON receiver_receipts (session_id, received_at DESC);
