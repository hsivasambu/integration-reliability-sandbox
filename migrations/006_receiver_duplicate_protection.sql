-- Receiver-side duplicate protection: the mock receiver processes each event at most once.

-- One row per (session, event) the receiver has processed. Repeated deliveries of the same
-- event only bump delivery_count; they never create a second row or a second result.
CREATE TABLE mock_receiver_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  event_id           uuid NOT NULL,
  -- The synthetic "processing result", written in the same statement as the receipt.
  result             jsonb NOT NULL,
  first_received_at  timestamptz NOT NULL DEFAULT now(),
  last_received_at   timestamptz NOT NULL DEFAULT now(),
  -- Total deliveries of this event seen by the receiver; duplicates = delivery_count - 1.
  delivery_count     integer NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),

  CONSTRAINT mock_receiver_receipts_session_event_unique UNIQUE (session_id, event_id)
);

-- Carry over earlier receipts (which could contain repeats of the same event).
INSERT INTO mock_receiver_receipts
  (session_id, event_id, result, first_received_at, last_received_at, delivery_count)
SELECT session_id, event_id,
       '{"confirmationCode": "RCPT-MIGRATED", "summary": "Recorded before duplicate protection existed"}'::jsonb,
       min(received_at), max(received_at), count(*)
FROM receiver_receipts
GROUP BY session_id, event_id;

DROP TABLE receiver_receipts;

ALTER TABLE receiver_settings DROP CONSTRAINT receiver_settings_mode_check;
ALTER TABLE receiver_settings ADD CONSTRAINT receiver_settings_mode_check
  CHECK (mode IN ('success', 'server_error', 'timeout', 'process_then_timeout'));
