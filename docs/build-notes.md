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

**Deployed check (2026-10-04, by Claude, after pushing d75e263).** Live in about 45 s. Migration 002 was
applied at startup, and /ready returned 200. Results: first submit 201, repeat 200, conflicting reuse 409,
invalid 422, own GET 200, other session's GET 404, list 1 item, no token 401, /demo.js 200.

## Stage 4: Mock receiver with per-session simulated outcomes (2026-10-04)

**Decisions**
- The receiver is a route in the same app (`POST /internal/receiver/deliveries`), not a separate service.
  The destination is fixed by `RECEIVER_URL` and defaults to the app's own loopback port, so it works
  unchanged on Render. The delivery client uses `fetch` with `redirect: 'error'` and
  `AbortSignal.timeout(DELIVERY_TIMEOUT_MS)`. No user input ever reaches the URL.
- Auth: `Authorization: Bearer <RECEIVER_SECRET>`, compared in constant time (SHA-256 both sides +
  `timingSafeEqual`). It's checked *before* the body is parsed. The secret is required at startup
  (32+ chars), generated by Render via `generateValue: true`, absent from public files and logs, and
  a session token is not accepted in its place.
- Modes are stored per session in `receiver_settings` (migration 003; no row = `success`) and deleted
  with the session. `receiver_receipts` records what `success` actually processed, which proves that
  `server_error` and `timeout` process nothing.
- `timeout` waits with `timers/promises.setTimeout` and an AbortSignal tied to `res.on('close')`. If the
  caller disconnects, the timer is cancelled and no late write is attempted. If a patient caller waits,
  it gets `503 simulated_slow_response`, never 200, so a longer timeout can't fake a delivery.
- `server_error` = `503` + `Retry-After: 1`, so the later retry stage has a realistic hint to honour.
- Defaults: client timeout 2000 ms, slow response 4000 ms. Config rejects slow ≤ timeout.
- `npm run receiver:try` is the local test client. It creates a throwaway session in the DB, sets each
  mode, and sends real HTTP via the same delivery client the worker will use.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 68/68 pass (16 new receiver tests, 4 new config tests). The receiver tests use a real
  listening server and the real delivery client, and fail on any unhandled rejection, uncaught
  exception, or server `console.error`. Coverage:
  - each mode: success records 1 receipt; 503 records 0
  - timeout: client gives up at about 300 ms; receiver's pending delay drops to 0; still 0 receipts
    after the slow period
  - patient client receives the late 503
  - `/health` answers in under 200 ms while a slow response is pending
  - auth: missing, wrong, unprefixed, or session-token credentials, and no secret configured
  - secret absent from `/`, `/demo.js`, `/health-check.js`, `/v1/receiver`
  - 422 and unknown session; session isolation of mode and receipts; mode persisted in Postgres
  - PUT validation (bad mode, extra `url` field, no token, non-JSON)
  - redirect refused, with the redirect target never contacted; connection refused → network_error
- Mutation check: removing the AbortSignal from the delay makes the cleanup test fail as intended.
- Live: startup without `RECEIVER_SECRET` fails clearly (exit 1). `npm run receiver:try` printed
  success 200 (225 ms), server_error 503 (21 ms), timeout after 2007 ms with no status, 1 receipt.
  During a pending timeout delivery, `/health` answered 200 in 6 ms. Unauthenticated external POST got 401.
  Secret absent from the server log.

**Deployed check (2026-10-04, by Claude, after pushing f277014).** Live in about 60 s with version 0.4.0.
Startup succeeded, which confirms the Blueprint generated `RECEIVER_SECRET`. Migration 003 was applied,
and /ready returned 200. The receiver rejected both no secret and a wrong secret with 401. `GET /v1/receiver`
returned the default `success`. A PUT of `timeout` on session A returned 200; A then read `timeout` while
session B still read `success`. Invalid mode 422; no token 401. Not verified on Render: the loopback
self-call (`http://127.0.0.1:10000/...`). There's no shell on free instances, so it will first be
exercised by the delivery worker stage.

## Stage 5: One delivery attempt per event in a background worker (2026-10-04)

**Decisions**
- **Data model (migration 004).**
  - `deliveries` is the job: `pending → in_progress → delivered | failed`, plus `available_at`,
    `claim_token`, `lease_expires_at`, `attempt_count`, and `completed_at`.
  - `delivery_attempts` is the history: attempt number, claim token, start/end, outcome, response
    status, error category, and duration.
  - `events.status` was **dropped**, so delivery state exists in one place only. Existing events were
    backfilled with a pending delivery.
  - CHECK constraints make contradictory rows impossible: a claim exists iff in progress; `completed_at`
    is set iff finished; `error_category` is set iff failed or lease expired.
- **API.** A new event returns `202` with `eventId`, `statusUrl`, and `Location: statusUrl`. The event and its
  delivery are inserted in the same transaction. An identical repeat stays `200` with
  `Idempotent-Replayed: true` and now shows the current delivery state. The event resource gains a
  `delivery` summary and loses `status`. New: `GET /v1/events/{id}/deliveries`, scoped by session
  (others get 404).
- **Modules.** `events.js` (API), `worker.js` (loop/lifecycle), `delivery-store.js` (SQL), and
  `delivery-client.js` (HTTP) are kept separate. The worker runs in-process behind `WORKER_ENABLED`
  (true on Render) or standalone via `npm run dev:worker` (`src/worker-main.js`). No extra hosted service.
- **Queue mechanics.** Each operation is a single SQL statement, so no transaction is open during HTTP.
  - Claim = `FOR UPDATE SKIP LOCKED` + set `in_progress`, `claim_token = gen_random_uuid()`, a lease of
    `DELIVERY_LEASE_MS` (15 s, validated ≥ timeout + 1 s), and insert the attempt row. The attempt is
    recorded **before** sending.
  - Complete = update only `WHERE claim_token = mine AND state = 'in_progress'`. A stale worker gets
    `false` and its result is discarded and logged.
  - Recovery runs before each claim. Expired leases return to `pending` and the attempt is labelled
    `lease_expired` with `ended_at` left NULL (unknown, not invented). After `DELIVERY_MAX_ATTEMPTS` (3)
    claims the delivery fails, so a crash loop is bounded.
  - If a lease expires but nobody has recovered it yet, the original worker can still complete. Its
    claim is still current.
- 2xx = `delivered` (HTTP level). Anything else = `failed` with category `http_error`, `timeout`, or
  `network_error`. No retries.
- **Shutdown.** SIGTERM → `worker.stop()` (no new claims, in-flight attempt finishes and records, ≤ 2 s)
  → `server.close()` → `pool.end()`.
- **Delivery guarantee: at-least-once.** A crash between the receiver processing a delivery and the
  completion update causes a second delivery after the lease expires. A test demonstrates this.
- `/health` adds `inProcessWorker: true|false` so worker-enabled and worker-disabled deployments are visible.
- Free-plan caveat: the worker sleeps with the instance (15 min without inbound traffic). Pending jobs
  wait in Postgres.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 81/81 pass (13 new worker tests; Stage 3 tests updated for 202 and `event.delivery`).
  Worker tests cover:
  - success, 503, and timeout attempts with all recorded fields
  - worker disabled: events stay pending
  - restart: a fresh pool and worker deliver 3 pending events
  - graceful stop: the attempt row is `in_progress` mid-flight; after `stop()` it is recorded as a
    timeout; nothing new is claimed
  - lease expiry before sending (attempt `lease_expired` with `endedAt` null, then delivered)
  - crash after receiver processing: 2 receipts (at-least-once)
  - stale worker's completion rejected
  - recovery cap reached → failed
  - two workers racing for one job, 5 rounds: exactly one claim each round
  - two running workers draining 12 jobs: 12 attempts, 12 receipts
  - deliveries endpoint scoping
- Mutation checks: removing `FOR UPDATE SKIP LOCKED` fails the competing-workers test; removing the
  claim-token condition fails the stale-worker test.
- Flakiness found and fixed: with a 300 ms test client timeout, an occasional slow local request
  (one test took about 1.9 s on this Windows/Docker host) turned a success into a timeout. Test timings were
  widened to 800 ms timeout / 1600 ms slow response / 3 s lease (production stays 2 s / 4 s / 15 s). After
  that: 25 consecutive worker-file runs and 6 full-suite runs were clean.
- Live demonstration (port 3129):
  - A. `WORKER_ENABLED=false`: `/health` shows `inProcessWorker: false`; event 202, still `pending` with
    no attempts after 3 s.
  - B. `npm run dev:worker` started separately: the same event became `delivered` (HTTP 200, 8 ms).
  - C. `WORKER_ENABLED=true`: `inProcessWorker: true`; server_error → failed/503/http_error (81 ms);
    timeout → failed/timeout, no status (2015 ms); success → delivered/200 (10 ms).
- Not run live: SIGTERM shutdown (Windows can't send SIGTERM to a native process this way). It's
  covered by the graceful-stop test, and Render's deploy logs show it.

**Deployed check (2026-10-04, by Claude, after pushing 2faece5).** Version 0.5.0 was live about 30 s after the
push, but `/health` first showed `inProcessWorker: false`. Render deployed the new code before the Blueprint's
new `WORKER_ENABLED` value took effect. The first event (202, `Location` = status URL) stayed `pending`
with no attempts, which demonstrates worker-disabled behaviour live. Shortly after, Render redeployed with
the env var: `/health` showed `inProcessWorker: true`. Results with the worker running:
- server_error → failed / 503 / http_error (3 ms)
- timeout → failed / timeout, no status (2001 ms)
- success → delivered / 200 (6 ms), receiver `receivedCount` 1
- identical repeat → 200 + `Idempotent-Replayed: true`
- another session's deliveries URL → 404

This is the first confirmation that the app's loopback call to its own receiver
(`http://127.0.0.1:10000/...`) works on Render. Not confirmed: whether the very first pending event was later
delivered by the new instance. Its session token wasn't kept. The restart test covers that behaviour.

## Stage 6: Durable retry scheduling and terminal failure (2026-10-04)

**Decisions**
- **Policy in one file** (`src/retry-policy.js`):
  - Retry: timeouts, transport/connection errors (including a refused redirect), 408, 429, and 5xx.
  - Terminal: any other 4xx (`failure_reason = non_retryable`).
  - Delay: `RETRY_BASE_DELAY_MS × 2^(n−1)` = 2/4/8 s.
  - `DELIVERY_MAX_ATTEMPTS = 4` total. After the 4th, the delivery fails with `attempts_exhausted`.
  - No retry framework: three small functions.
- **Migration 005.** Adds the `retry_scheduled` state and renames `available_at` → `next_attempt_at`. Adds
  `deliveries.failure_reason` (`non_retryable` / `attempts_exhausted`; NULL for Stage 5 failures) and
  `delivery_attempts.retryable`. The due-work partial index now covers `pending` and `retry_scheduled`.
- **The database owns the schedule.** Completion writes `state`, `next_attempt_at = now + delay`, and the
  attempt row in one statement. Workers claim `WHERE next_attempt_at <= now`. No in-memory timers hold
  schedule state.
- **Controllable clock.** Every time comparison in `delivery-store.js` uses
  `coalesce($now::timestamptz, now())`. Production passes NULL (database clock, shared by all workers);
  tests pass a fake time, so the 2+4+8 s schedule runs in milliseconds.
- **Uncertain vs confirmed.**
  - A confirmed failure is attempt `failed` + `error_category`; it gets backoff.
  - A lost lease is attempt `lease_expired`: delivery back to `pending`, due immediately, no backoff.
  - Both consume `attempt_count`, so the limit of 4 holds across crashes.
- **Concurrency.** `WORKER_CONCURRENCY` (default 2) caps in-flight deliveries per worker. One polling run
  at a time (`polling` flag). The loop wakes on the poll interval or when a slot frees, and the idle timer
  is cleared when a slot frees first.
- **API.** The delivery summary (on events and at the status URL) adds `maxAttempts`, `nextAttemptAt` (only
  while `pending`/`retry_scheduled`), and `failureReason`. Attempts add `retryable`.
- **Deterministic delays.** Jitter is explained in the README but not implemented. `Retry-After` is
  documented as not yet honoured; the mock receiver's `Retry-After: 1` is ignored.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 91/91 pass, 5 consecutive clean full runs.
  - 3 Stage 5 worker tests updated: a 503 or timeout is now `retry_scheduled`, not `failed`.
  - 3 new policy unit tests (no DB).
  - 7 new controllable-clock tests:
    - immediate success
    - server_error → success: next retry exactly t0+2000 ms in the API; not due at +1999 ms; delivered
      on attempt 2 after the mode switch
    - exhaustion: gaps exactly [2000, 4000, 8000], then `failed`/`attempts_exhausted`, no 5th attempt
    - terminal 404 (expired session): 1 attempt, `non_retryable`, `retryable=false`
    - restart during a scheduled retry: schedule verified in the DB row; a fresh pool and worker loop
      leaves it alone before due and delivers it after the clock advances
    - 3 crash recoveries (each `pending` and due immediately), then a real 503 on attempt 4 →
      `attempts_exhausted`
    - concurrency: 5 slow deliveries, concurrency 2, plus 3 concurrent extra `poll()` calls every 20 ms;
      max in progress = 2
- Mutation check: removing the `polling` guard let 3 deliveries run at once; the concurrency test caught
  it in 2 of 3 runs (the race is timing-dependent).
- Live (port 3130, real 2/4/8 s timing, worker enabled):
  1. server_error, then switched to success: attempt 1 503 at :52.1, retry shown for :54.2, attempt 2
     delivered at :54.3.
  2. server_error throughout: attempts at :57.6, :59.7, :03.9, :12.3 (gaps of about 2.1, 4.2, 8.4 s; the
     extra is poll granularity), then `failed` / `attempts_exhausted`.
  3. Restart: after attempt 1, stopped the server (attempt 2 ran just before the stop took effect).
     Attempt 3 fell due while the server was down. A worker-disabled restart left it `retry_scheduled`.
     A worker-enabled restart sent the overdue retry about 1.5 s after start, and it was delivered (receiver
     switched to success).

**Deployed check (2026-10-04, by Claude, after pushing 92a7884).** 0.6.0 was live in about 15 s. Within about 45 s new events reported
`maxAttempts: 4` with the worker on; I waited for this because the Blueprint value changed from 3 to 4 and might land in a
second deploy. `/ready` 200.
- server_error, then success: attempt 1 503 (retryable) at :07.8, `nextAttemptAt` :09.9, attempt 2 delivered at :09.9.
- server_error throughout: attempts at :13.9, :15.9, :20.0, :28.0 (gaps of about 2.0, 4.0, 8.1 s), then `failed` /
  `attempts_exhausted`, 4/4.
- timeout: attempt 1 `timeout`, no status, retryable, retry scheduled 4 s after it started (2 s timeout + 2 s delay).
