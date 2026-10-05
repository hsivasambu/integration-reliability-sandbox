# Build notes

## Stage 1: Deployable service (2026-10-03)

**Decisions**
- Node 24 (Active LTS per nodejs.org; Render default 24.21.0) pinned via `.node-version`.
  `engines` allows 22.9+ so local Node 22 works (needed for `--env-file-if-exists`).
- Express 5, the only runtime dependency. Tests use `node:test` + `supertest`.
- `createApp()` is separate from `listen()` so tests run without opening a port.
- `/health` is a liveness check only (process is up). It does not check dependencies yet.
- Wrong methods on `/health` return 405 + `Allow` (Express would return 404 by default),
  so method errors are distinguishable from missing routes.
- Version comes from `package.json`. No commit hash, hostname, or env data exposed.
- `HOST` defaults to `0.0.0.0` (Render requirement), and `.env.example` uses `127.0.0.1` locally.
- SIGTERM handler closes the server gracefully (Render sends SIGTERM on deploy/stop).
- No request body parsing yet, so there is no body-size exposure. Limits come with event intake.
- Render free plan via Blueprint. No deployment performed (no authorized connection, no Git remote).

**Verification (run locally on Node 22.18.0, Windows 11)**
- `npm test`: 6/6 pass.
- curl: GET /health 200 JSON; HEAD /health 200 no body; POST /health 405 with Allow;
  GET /nope 404 JSON; GET / 200 text/html; unused port → curl exit 7.

**Deployed check (2026-10-04, by Claude):** GET /health, /health-check.js and / on
https://integration-reliability-sandbox.onrender.com all returned 200. One browser showed the script as
`(blocked:other)`, which was a client-side block (extension or security software), not a server fault.

## Stage 2: PostgreSQL and anonymous demo sessions (2026-10-04)

**Decisions**
- Dependency added: `pg`. No ORM and no migration library. A ~60-line runner applies numbered SQL
  files once each, in a transaction, recorded in `schema_migrations`, under an advisory lock.
  Never drops or resets data.
- Render free instances lack a pre-deploy command, so `MIGRATE_ON_START=true` runs migrations in-process
  before `listen()`. A failed migration means the process exits and the deploy never goes live. On paid
  instances use `preDeployCommand: npm run migrate` instead. In-process was chosen over a shell
  `migrate && start` so SIGTERM reaches the server directly.
- Config is validated at startup and all problems are listed at once. `DATABASE_URL` is the only required value.
- Token: `irs_` + 32 random bytes (base64url). Only its SHA-256 is stored (`bytea`, unique). A fast hash
  is fine for a 256-bit random secret, and bcrypt-style slowness is only needed for guessable passwords.
  The prefix makes leaked tokens recognisable to secret scanners.
- Invalid and expired tokens both return `401 invalid_token` (RFC 6750 style). A missing or non-Bearer
  header returns `401 missing_token`. The session's internal UUID is not exposed.
- Bounds: 1 KB JSON body limit on `/v1`; 10 session creations per IP per hour (in-memory, per instance);
  1000 active sessions max; expired sessions deleted whenever a new session is created; 24 h default TTL (1–168).
- `TRUST_PROXY=1` on Render so `req.ip` is the client, not the proxy. Still to verify on Render: whether
  the Cloudflare edge adds a second hop. If it does, every client shares one rate-limit bucket. That's
  safe (stricter), but worth checking.
- `/health` stays liveness only and remains Render's health check path. `/ready` checks DB reachability
  and that every migration in code is applied. It's not the Render health check, because a database
  blip would trigger restarts that can't help.
- Free Render Postgres 18 in `render.yaml`, internal URL via `fromDatabase`, `ipAllowList: []`.
  It expires after 30 days and has no backups. Acceptable for synthetic demo data.
- Local Postgres 18 via Docker Compose on 127.0.0.1:5433. An init script creates `sandbox_test`.
  The test helper refuses to wipe any database whose name doesn't end in `_test`.

**Verification (local, Node 22.18.0, Postgres 18.6 in Docker, Windows 11)**
- `npm test`: 28/28 pass (5 config, 17 database-backed, 6 Stage 1 health). Without
  `TEST_DATABASE_URL` the DB suite is reported as SKIP with the reason, and the other 11 pass.
- Startup without `DATABASE_URL`: prints "Invalid configuration: DATABASE_URL is required", exit 1.
- `npm run dev:migrate` twice: "Applied migration 001_create_demo_sessions", then "Database schema is up to date".
- Live server: POST /v1/sessions 201; GET /v1/session 200; **server killed and restarted, then same
  token still 200** (persisted in Postgres); no header 401 missing_token.
- Stopped the Postgres container: /ready 503 `database_unreachable` while /health stayed 200. Restarted
  the container: /ready back to 200 without restarting the app.
- `MIGRATE_ON_START=true` startup logs "Database schema is up to date" before "Listening".
- Server log searched for the issued token: 0 occurrences.

**Deployed check (2026-10-04, by Claude, after pushing 86270cb).** The Blueprint sync created the free
database and redeployed in about 60 s. Results: GET /health 200 `0.2.0`; HEAD /health 200; /ready 200;
POST /v1/sessions 201; GET /v1/session with the token 200; no header 401 missing_token; bad token 401
invalid_token; GET /v1/sessions 405.
The free database was created 2026-10-04. It **expires about 2026-11-03** and is deleted about 2026-11-17
unless upgraded. Recovery: create a new free database (or let the Blueprint recreate it) and redeploy.
Migrations rebuild the empty schema automatically, but existing sessions are lost.

## Stage 3: Session-scoped event API with idempotent submission (2026-10-04)

**Decisions**
- One type, `demo.notification`, with payload `{title ≤100 chars, message ≤500 chars}`. Lengths are
  counted in Unicode characters. Unknown fields at any level are rejected. All problems are reported
  together as `422 validation_failed` with `details[]`. Body limit raised from 1 KB to 4 KB so a
  maximum-length event in multi-byte characters fits.
- Error shape unified as `{error: code, message, ...details}`. `error` stays a string code, so Stage 1–2
  clients keep working.
- **Idempotency.** `UNIQUE (session_id, idempotency_key)` in Postgres (migration 002). The request hash is
  SHA-256 of canonical JSON (sorted keys) of the *validated* type + payload, so key order and stripped
  extras can't cause false conflicts.
  - New key: `201` + `Location`.
  - Identical repeat: `200` + `Idempotent-Replayed: true` with the original event. It's 200, not 201,
    because nothing was created.
  - Different payload: `409`.
  - Keys last as long as the session (and are deleted with it).
- **Write path.** Inside one transaction: lock the session row (`FOR UPDATE`), look up the key, check the
  cap, then `INSERT ... ON CONFLICT DO NOTHING`. If the insert returns no row, re-read the winner and
  compare hashes. The session lock serializes writes per session so the cap is exact. The unique
  constraint is the final guarantee: it holds even for code paths that skip the lock, direct SQL,
  or future workers. No in-memory check is involved.
- Per-session cap `MAX_EVENTS_PER_SESSION=100` returns `429 event_limit_reached` with `limit`. Replays of
  existing keys still succeed at the cap.
- Pagination: newest first, keyset on an internal identity column `seq` (opaque base64url cursor),
  `limit` 1–50 (default 20). Unknown query parameters are rejected (`400 invalid_query`).
- Another session's event ID, a nonexistent UUID, and a malformed ID all return the same `404`.
- `status` is `CHECK (status IN ('pending'))` for now. The delivery stage will widen it in a new migration.
- Retention: `ON DELETE CASCADE` from `demo_sessions`, so cleaning up an expired session removes its events.
- UI: session start, event form showing the Idempotency-Key, "send same request again", and list. Every
  result states "pending / not delivered". The token is kept in a JS variable only and rendered via
  `textContent` (no HTML injection).

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 48/48 pass, run 4 times with no flakes. 20 new event tests cover: creation;
  max-length Unicode; 11 invalid-payload cases; missing/invalid token; missing/bad Idempotency-Key;
  non-JSON (415); identical repeat (200, same event, row count +1 only); conflicting reuse (409);
  per-session key scope; 10 concurrent identical requests (exactly one 201 and nine 200s, one row);
  6 concurrent conflicting requests (one 201, five 409s); cap with replay; 8 concurrent requests
  against a cap of 5 (exactly 5 created); direct duplicate INSERT rejected with SQLSTATE 23505 on
  `events_session_idempotency_key_unique`; owner GET; cross-session 404 matches missing-ID 404;
  three-page pagination with session isolation; bad query params.
- Live curl: 201 → 200 (replayed) → 409 → 422 → 400 → 401 → 200 own GET → 404 other session → list.
  Tokens absent from the server log. The README PowerShell example was run as written: 201, then 200 + replay header.
