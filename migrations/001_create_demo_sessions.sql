-- Anonymous demo sessions. Only a SHA-256 hash of the bearer token is stored.
CREATE TABLE demo_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX demo_sessions_expires_at_idx ON demo_sessions (expires_at);
