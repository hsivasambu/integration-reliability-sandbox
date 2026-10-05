-- Manual replay: an event can now have several deliveries (the original plus replays).

-- Previously one delivery per event; replays add more.
ALTER TABLE deliveries DROP CONSTRAINT deliveries_event_id_key;

-- A replay points at the failed delivery it replaces. UNIQUE: each delivery is replayed at most once.
ALTER TABLE deliveries ADD COLUMN replay_of uuid UNIQUE REFERENCES deliveries (id) ON DELETE CASCADE;

-- At most one delivery per event may be active (waiting or in flight) at any time.
CREATE UNIQUE INDEX deliveries_one_active_per_event ON deliveries (event_id)
  WHERE state IN ('pending', 'retry_scheduled', 'in_progress');

CREATE INDEX deliveries_event_idx ON deliveries (event_id, created_at);

-- Replay requests, for idempotency: the same key from the same session returns the same replay.
CREATE TABLE replay_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 100),
  original_delivery_id  uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  replay_delivery_id    uuid NOT NULL UNIQUE REFERENCES deliveries (id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT replay_requests_session_key_unique UNIQUE (session_id, idempotency_key)
);
