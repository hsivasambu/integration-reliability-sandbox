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

## Stage 7: Receiver-side duplicate protection and the ambiguous timeout (2026-10-05)

**Decisions**
- **Migration 006.** New `mock_receiver_receipts` with `UNIQUE (session_id, event_id)`. Each row holds one
  synthetic `result` (`confirmationCode`, `summary`), first/last received times, and `delivery_count`.
  Old `receiver_receipts` rows were folded in (grouped per event, count kept) and the table dropped.
  Mode CHECK gains `process_then_timeout`.
- **Order of checks in the receiver:**
  1. auth
  2. validation
  3. session lookup
  4. **recognize an existing receipt** (`UPDATE … delivery_count + 1 … RETURNING`) and answer 200
     `duplicate: true` with the original result, in every mode
  5. only then the mode's behaviour

  "Process" = one `INSERT … ON CONFLICT ON CONSTRAINT … DO UPDATE SET delivery_count + 1 RETURNING`, so
  receipt and result commit in one statement/transaction. A concurrent copy becomes a duplicate count.
  `duplicate = delivery_count > 1` in the returned row.
- **`process_then_timeout`.** Processes and commits first, then waits `RECEIVER_SLOW_RESPONSE_MS` (4 s)
  before a 200. If the sender disconnects at 2 s, the wait is cancelled and no reply is written. The
  sender's retry then hits step 4.
- **Bounded duplicate tracking.** A counter on the event's single row: no per-duplicate rows or log lines.
- **Session-scoped reads.** `GET /v1/receiver` adds `processedCount` and `duplicateCount` (`receivedCount`
  kept as an alias for compatibility). New `GET /v1/receiver/receipts/{eventId}` returns `processed`,
  `result`, `deliveriesReceived`, and `duplicateCount`; 404 for events not owned by the session.
- The stable event ID was already in every delivery body (`eventId` = `events.id`); retries and recovery
  resend it unchanged, and replay will too.
- **Explicitly not claimed:** exactly-once effects in arbitrary external systems. This works because the
  mock's receipt and effect share one database transaction.
- UI: the fourth mode; "Check delivery" now shows the sender view and the receiver view side by side;
  receiver panel shows processed/duplicate counts.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 98/98 pass, 5 consecutive clean runs.
  - Updated: the Stage 5 crash-after-processing test now expects 1 processed + `delivery_count` 2
    (previously 2 receipts); mode list includes the 4th mode.
  - 7 new tests in `test/duplicates.test.js`:
    - 10 concurrent copies: one `duplicate:false`, nine `true`, a single confirmation code,
      `deliveriesReceived` 10
    - existing receipt answered 200 in `server_error` and `timeout` modes (no 503, no delay)
    - plain `timeout` and `server_error` process nothing
    - `process_then_timeout` with the worker: sender attempt 1 timeout/no status, receiver already
      processed; retry → delivered; receiver duplicates 1, same code, processedCount 1
    - the same after switching to `success` before the retry
    - same key → one event processed once, but same content under a new key → 2 processed
      (dedup is by event ID)
    - receipt reads scoped (other session 404, unprocessed → `processed:false`, no token 401)
- Mutation check: skipping the "recognize existing receipt" step fails 2 of the new tests.
- Live (port 3131, worker on, real timing):
  - `npm run receiver:try`: success 200 `duplicate=false`; server_error 503; timeout 2009 ms;
    process_then_timeout 2005 ms timeout; 2 events processed; the same event sent twice was
    `duplicate=false` then `true`, with the same result.
  - `process_then_timeout` through the worker: at about 3 s, sender `retry_scheduled` with #1 timeout
    2007 ms while the receiver already showed `processed=true RCPT-1D25DC5D`. At about 6 s, sender
    `delivered` (#2 200 in 16 ms); receiver the same code, `deliveriesReceived=2`, `duplicates=1`.
    Server log: 2 lines total (no per-duplicate logging).

**Deployed check (2026-10-05, by Claude, after pushing bdaf243).** 0.7.0 was live with the worker in about 30 s; migration 006 applied
(`/ready` 200).
- process_then_timeout: at about 3 s, sender `retry_scheduled` (#1 timeout, 2003 ms, no status) while the receiver already
  showed `processed=true RCPT-478885EB`. At about 6.5 s, sender `delivered` (#2 200 in 22 ms); receiver the same code, 2
  deliveries, 1 duplicate.
- process_then_timeout, then switched to success before the retry: delivered on #2; receiver processed once, 1 duplicate.
- Plain timeout: after about 6 s, #1 timeout, #2 in progress; receiver `processed=false`.
- Session totals: processedCount 2, duplicateCount 2. Another session reading a receipt: 404.

## Stage 8: Manual replay of a failed delivery (2026-10-05)

**Decisions**
- **Migration 007.**
  - Dropped `deliveries_event_id_key`: an event can now have several deliveries.
  - Added `deliveries.replay_of` (UNIQUE, self-FK): each delivery is replayed at most once.
  - Added partial unique index `deliveries_one_active_per_event` on `(event_id)` where the state is
    pending/retry_scheduled/in_progress.
  - New `replay_requests` table with `UNIQUE (session_id, idempotency_key)`, linking the original
    delivery to the replay.
- **Endpoint.** `POST /v1/deliveries/{id}/replay` (`src/replay.js`) in one transaction:
  1. find the delivery in this session (else 404) and `FOR UPDATE OF` its event row
  2. a prior request with the same key → same delivery: 200 replay; different delivery: 409
     `idempotency_key_conflict`
  3. state ≠ failed → 409 `delivery_not_failed` (+ state)
  4. already has a replay → 409 `already_replayed` (+ id)
  5. replays for the event ≥ `MAX_REPLAYS_PER_EVENT` (3) → 429 `replay_limit_reached`
  6. insert the delivery (`replay_of`) and the `replay_requests` row → 202

  On a unique violation (a race the lock didn't cover), re-check once. The key check comes before the
  eligibility checks so an identical request still returns its replay after it has completed.
- The new delivery starts at `attempt_count 0` with the full 4-attempt budget; attempt numbers restart at
  1 per delivery. The worker needed no change and sends the same `event.id`, so receiver deduplication
  still applies.
- **API.**
  - The event summary now reflects the **latest** delivery (`LATERAL … ORDER BY created_at DESC LIMIT 1`)
    and adds `id`, `replayOf`, and `replayCount`.
  - `GET /v1/events/{id}/deliveries` returns `deliveries[]` (oldest first, each with attempts,
    `replayOf`, `replayedBy`) plus `delivery` = latest, for compatibility.
- Minimal UI only: a "Replay failed delivery" button (keeps its key until a server answer) and a
  per-delivery history in "Check delivery". The full UI is deferred.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 106/106 pass, 3 consecutive clean runs. 8 new tests in `test/replay.test.js` (controllable
  clock):
  - failed → replay 202 (replayOf, attemptCount 0, max 4) → delivered; history shows 2 deliveries; the
    original's attempts are deep-equal before and after; the receiver processed the event ID once
  - replay of an event the receiver had already processed → duplicate recognized, original result kept
  - same key → 202 then 200 (same id), still 200 after the replay is delivered
  - 8 concurrent requests with the same key → one 202 and seven 200s with one id; 8 concurrent with
    different keys → one 202 and seven 409 `already_replayed`; exactly one replay row, never more than
    one active
  - other session / random / malformed id → 404, no token → 401, nothing scheduled
  - pending, delivered, and retry_scheduled → 409 with state
  - already_replayed, key conflict, missing key 400, body 422, cap (2 in tests) → 429; chain history
    `replayOf` links
  - direct SQL inserts rejected by `deliveries_one_active_per_event` and `deliveries_replay_of_key`
- Mutation checks:
  - Without the `FOR UPDATE` lock, the concurrent test still passed: constraints plus the one re-check
    produced exactly one replay.
  - Removing the re-check as well made the losing requests fail with errors, instead of a clean 409/200.
- Live (port 3132, worker on, real timing):
  - server_error: original failed after 4 attempts (503 ×4). Switched to success; replay K1 → 202
    (pending, 0 attempts); K1 again → 200 + `Idempotent-Replayed`; K2 → 409 `already_replayed`; other
    session → 404.
  - About 2.5 s later the history showed the original failed (4×503) and the replay delivered (1×200).
    Replaying the delivered replay → 409 `delivery_not_failed`. Receiver: processed once, 0 duplicates.

**Deployed check (2026-10-05, by Claude, after pushing e90d7a3).** 0.8.0 was live with the worker in about 30 s; migration 007 applied
(`/ready` 200).
- Replaying while the original was still retrying → 409 `delivery_not_failed (retry_scheduled)`.
- After about 17 s the original was failed (4×503, `attempts_exhausted`). Switched to success; replay K1 → 202 pending; K1
  again → 200 + `Idempotent-Replayed` (same id); K2 → 409 `already_replayed`; another session → 404.
- About 3 s later the history showed the original failed (4×503) and the replay delivered (1×200, `replayOf` = original).
  Receiver: processed once, 0 duplicates. Event summary: `delivered`, `replayCount` 1.

## Stage 9: Browser UI (2026-10-05)

**Decisions**
- Plain JavaScript, no framework or build step: `public/index.html`, `app.css`, `app.js` (about 600 lines).
  The stop-gap `demo.js` and `health-check.js` were removed.
- **Rendering.** All rendering goes through a tiny `h()` helper that creates elements and text nodes. There is
  no `innerHTML` anywhere (a test asserts this), and server-provided text is only ever text.
- **Token.** Kept in `sessionStorage` (`irs.token`), never in a URL, never in `localStorage`. A 401 clears it and
  offers a new session; sessions are only ever created by a click. The limits of this model are explained
  on the page and in the README.
- **CSP and headers.** Added to every response: `default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
  object-src 'none'`, plus `nosniff` and `no-referrer`. The page has no inline script, styles or handlers;
  the favicon is a `data:` SVG.
- **Polling.**
  - A single `pollNow()` loop: at most one refresh in flight, with requests made meanwhile coalesced.
  - Every 2 s while any delivery is active; stops when idle; restarted by submit or replay.
  - Paused on `visibilitychange` (hidden) and on `pagehide`; an immediate refresh when visible again.
  - Exponential backoff on failure (4, 8, 16, then 30 s maximum), with a *Retry now* button.
  - Each refresh: the events list (20) and the receiver summary, plus the selected event's deliveries and
    receipt. That's 4 requests at most.
- **Cold starts.** After 4 s a banner says the server may be waking and that nothing has failed. A request
  only fails after 90 s, or when it gets a non-JSON reply (for example a hosting placeholder page). Delivery
  state shown is always the server's.
- **Three lanes per event:** API acceptance (with *Submit duplicate*, reusing the stored `idempotencyKey`
  and payload), HTTP delivery (every delivery and attempt, plus *Replay failed delivery*), and receiver
  processing (with an explanation when it processed despite a sender timeout).
- **Retry-safe actions.** The submit key is kept until the server answers. The replay key is kept per
  delivery in `sessionStorage` until answered.
- **Accessibility.** Labels, fieldset/legend, `aria-live` regions, `:focus-visible` outline, skip link.
  `keepFocus()` restores focus to the same control across 2-second re-renders; the radio buttons are created
  once and only updated. Layout: one column, two from 52rem. Dark mode follows the system setting.

**Verification**
- `npm test`: 111/111 pass. 5 new tests in `test/ui.test.js`:
  - CSP and security headers present, with no `unsafe-*`
  - exactly one same-origin script, with no inline script, handlers or styles
  - asset content types
  - `app.js` has no `innerHTML`/`document.write`/`localStorage`/token-in-URL
  - old scripts return 404
- Browser automation (Chrome extension) wasn't available. Instead I ran the real `index.html` + `app.js` in
  jsdom (installed in a scratch folder, **not** a project dependency) against a live local server with the
  worker on: **27/27 checks passed** for the main flows, plus 4/4 extra checks.
  - Main flows:
    - API status Ready
    - submit disabled before a session
    - session start; token in `sessionStorage` and not in the URL
    - client-side validation
    - Scenario 1 (202 notice, 503 with retry time, switch to success, delivered on attempt 2, processed once)
    - duplicate submission → 200 + `Idempotent-Replayed`, still 1 event
    - Scenario 2 (timeout with no response while the receiver already processed; then delivered,
      1 duplicate, explanation shown)
    - Scenario 3 (failed after 4 attempts, replay 202, original kept failed, Replay 1 delivered)
    - polling stops when idle; never more than 1 events request in flight
    - 0 requests in 4.5 s while hidden, immediate refresh on visible
    - simulated network failure → "Trying again in 4 s", 0 calls in the next 3 s, recovery via *Retry now*
    - a stale token → "expired" note, 0 sessions auto-created, *Start a new session* offered
  - Extra checks:
    - a 5.5 s `/health` shows the waking notice ("Nothing has failed") instead of an error, then clears
    - a server 422 with details is shown
    - a 429 quota error is shown as "limit reached"
- Not verified by me: visual layout at phone width, real screen-reader output, and real-browser focus rings.
  These need a human with a browser (manual steps are in the stage summary).

**Deployed check (2026-10-05, by Claude, after pushing 55fdbaa and f1551fa).**
- 0.9.0 was live with the worker. `/` sends the CSP, `nosniff` and `no-referrer` headers; `/app.js` and `/app.css`
  return 200 with the right types; `/demo.js` returns 404.
- jsdom run of the real page against Render: first run 25/27. Scenario 1's original wording ("switch before
  the retry runs") left only about 2 s between attempt 1 and retry 2. With 2 s polling plus network latency,
  attempt 2 had already failed by the time the receiver was switched; it was delivered on attempt 3 and
  processed once.
- Fix (f1551fa): the scenario now says switch "before the 4th attempt (about 14 seconds)" and expects
  delivery on the first attempt after the switch.
- Rerun after fixing the check script's regexes: **27/27**, plus the extra checks **4/4** (waking notice,
  422 details, 429 limit message).

## Stage 10: Operational visibility and bounded demo usage (2026-10-05)

**Decisions**
- **`src/logger.js`.** JSON lines, no dependency. Redaction is enforced in the logger: sensitive-looking keys
  become `[redacted]`, `irs_…` tokens are masked, and registered secret values (receiver secret, ops token,
  DATABASE_URL and its password) are masked anywhere in a line. Quiet under the test runner.
- **Request logging** (`src/operations.js`). A request ID per request (`X-Request-Id`; a valid incoming one is
  kept), with method, path without query, status, duration, sessionId, and eventId/deliveryId when created.
  Successful GET/HEAD requests are logged at debug only (polling and health checks would otherwise flood info).
  Headers and bodies are never passed to the logger. The worker logs one line per attempt and one per lease
  recovery batch; cleanup logs only when it did something.
- **`GET /v1/summary`.** Counts by latest-delivery state, attempts, replays, receiver processed/duplicates, and
  "acceptance-to-delivery time" (start = 202 / `events.created_at`; end = `ended_at` of the 2xx attempt;
  population = the session's 50 most recently completed delivered original deliveries; median and max). It's
  labelled as a demo statistic, not an SLA. All queries are bounded (≤ 100 events per session, LIMIT 50).
- **Worker liveness.** Migration 008 adds `worker_heartbeats` (written by `poll()` at most every 10 s;
  `stopped_at` set on graceful stop). `GET /internal/ops/worker` (enabled only with `OPS_TOKEN`; constant-time
  compare; Render `generateValue`) returns heartbeats, queue (overdue, oldest overdue age, retries waiting,
  in progress, expired leases) and a verdict. `/health` and `/ready` are unchanged.
- **Expiry and cleanup** (`src/maintenance.js`, runs in WORKER_ENABLED processes):
  - claims skip expired sessions
  - waiting deliveries are cancelled (`failure_reason = 'session_expired'`, new CHECK value)
  - expired sessions are deleted after `EXPIRED_RETENTION_MINUTES` (60), skipping any session with a live
    in-progress lease; FK cascades do the rest
  - batches of `CLEANUP_BATCH_SIZE` with `SKIP LOCKED`
  - the old unbounded `DELETE` on session creation is removed, and the active-session cap now counts
    unexpired sessions only
- **Safeguards.** Added a per-IP `/v1` limit (600/min, in-memory) and a consistent 429 body for both
  in-memory limiters. Documented which limits are per-instance (in-memory) and which are database-enforced.
- **Hosting** (Render docs checked 2026-10-05):
  - Free instances spin down after 15 min without inbound traffic; spin-up takes about 1 minute.
  - On deploys, SIGTERM is followed by SIGKILL after 30 s by default; the old and new instances overlap.
  - Prepared `deploy/render.continuous.yaml` (`plan: 0.5c-512mb`, `preDeployCommand`, `MIGRATE_ON_START=false`).
    It's not active and not purchased.
  - Paid pricing was not confirmed from an official page (third-party sources list Starter at about $7/month).
- UI: a "Session summary" panel with the metric definition, refreshed with the existing polling.

**Verification (local, Node 22.18.0, Postgres 18.6)**
- `npm test`: 124/124 pass.
  - Updated: the Stage 2 "session creation deletes expired sessions" test now asserts it deletes nothing;
    the terminal-404 retry test uses a real HTTP stub that answers 404, because expired sessions are no
    longer attempted.
  - 13 new tests in `test/operations.test.js`:
    - logger redaction (keys, demo token, registered secret)
    - request log fields, with no token, payload, secret or headers in the output
    - routine reads silent at info level
    - worker attempt log fields
    - summary counts and metric definition, session-scoped
    - ops endpoint: 404 when unset; 401 for a wrong token or a session token; `no_live_worker` while
      `/ready` is 200; heartbeat appears, then `stoppedAt` after stop; `stalled` verdict
    - expiry: no claims, cancellation
    - purge: grace period, batch size, live-lease skip, cascade
    - API rate limit 429
- **Drill** (local, worker on, hard kill via `taskkill /F`, which is like a crash or SIGKILL; synthetic events):
  - *Phase A, crash with attempts in flight* (`process_then_timeout`, 4 events). At the kill: 2 in progress,
    2 pending. Restarted about 1.5 s later; all 4 delivered **12.1 s after restart**. The 2 in-flight
    deliveries show `lease_expired`, then `delivered`: they waited for the 15 s lease and were recovered in
    one batch (`recovered: 2`). The 2 pending show `failed` (timeout), then `delivered`. Receiver:
    **processed 4, duplicates 4**, so every event was processed exactly once despite the resends.
  - *Phase B, crash with retries scheduled* (`server_error`, 3 events). The receiver was switched to success
    in the database while the server was down for 10.5 s; the retries were overdue by up to 6 s. All 3 were
    delivered **0.9 s after restart**.
  - Logs: 43 lines, all valid JSON, including the recovery line and attempt lines with eventId, deliveryId,
    attemptNumber, responseStatus, durationMs and nextState. Leak scan found **0 occurrences** of either
    session token, the ops token, the receiver secret, the database password, or the payload marker text.
  - Observations and limitations:
    - **A killed worker keeps showing as live in the ops check until its heartbeat is 60 s old**, because it
      can't record `stopped_at`.
    - The **first drill attempt was invalid**: the PowerShell-based kill took 1–2 s, so the in-flight window
      was missed. It was rerun with a pre-looked-up PID and `taskkill`.
    - Graceful SIGTERM shutdown could not be exercised on Windows (covered by the Stage 5 test, and visible
      in Render logs on each deploy).
    - Single run, single machine. The numbers show behaviour (lease wait ≈ lease length; overdue work picked
      up within one poll), not performance.

**Deployed check (2026-10-05, by Claude, after pushing 8ca83bd).** 0.10.0 was live with the worker in about 45 s; migration 008
applied (`/ready` 200).
- `/internal/ops/worker` returned 401 with no token and with a guessed token. That shows Render generated `OPS_TOKEN`.
  I can't read that value, so the authorized ops call is for the owner to run.
- `X-Request-Id` is present on responses.
- `/v1/summary` after 3 events: 3 delivered, 3 attempts, receiver processed 3; delivery time n=3, median 766 ms,
  max 1233 ms.
- jsdom UI regression on Render: 27/27.
- Not verified by me: the Render log stream itself (dashboard access), and the authorized ops response.

## Stage 11: API documentation, Postman collection, and release checkpoint (2026-10-05)

**Checkpoint before starting.** Working tree clean at `caa3255`. `npm test` 124/124 locally; deployed `/health` 200
`0.10.0` with the worker, `/ready` 200.

Inconsistencies found between notes and implementation:
- README still used future tense ("will accept…") and said sessions scope data "from later stages". Fixed.
- README's Postman section used `base` / `demoToken`. Replaced by the collection's `base_url` / `session_token`.
- README failure table omitted 413, 415 and 422. Added.
- **Not fixed (behaviour, outside this stage):** when `OPS_TOKEN` is unset, `GET /internal/ops/worker` answers 404,
  but other methods answer 405 with `Allow`, which reveals that the route exists. Harmless (Render sets the token), but
  inconsistent. The spec documents the GET behaviour.

**Decisions**
- **`docs/openapi.yaml`** (OpenAPI 3.1.0, hand-written from the source):
  - all 13 paths / 15 operations
  - shared error schema with the complete list of 25 `error` codes
  - three bearer schemes: session token, receiver secret, ops token
  - idempotency tables for submission and replay
  - cursor pagination, the replay rules and 409 variants, receiver modes, and the asynchronous polling model
  - the internal routes are tagged **Internal** with `x-internal: true` and their own security schemes
  - examples use obvious placeholders (`irs_EXAMPLE_ONLY_not_a_real_token`) and no secret values
- **Docs page** at `/docs/`: Swagger UI from the pinned `swagger-ui-dist@5.33.1` (new runtime dependency, needed because
  Render's `npm ci` with `NODE_ENV=production` skips devDependencies). Only `swagger-ui-bundle.js` and `swagger-ui.css` are
  exposed (`/docs/vendor/…`), served same-origin, so the existing strict CSP is unchanged. The initializer is a file
  (`public/docs/docs.js`), not inline, and the public validator badge is off. The spec is served at `/openapi.yaml`.
  A CDN wasn't used because `script-src 'self'` blocks it.
- **`yaml`** as a devDependency, for the spec consistency tests.
- **Postman** (`postman/`): collection v2.1 plus an environment template. 8 folders in the agreed order, 43 requests.
  - Collection-level Bearer auth `{{session_token}}`.
  - A collection pre-request script stops with a clear message when no environment or `base_url` is selected.
  - Scripts capture `session_token`, `other_session_token`, `event_id`, `delivery_id`, `replay_delivery_id` and
    `next_cursor`, and generate `idempotency_key` / `replay_idempotency_key` per new request.
  - **Polling is explicit.** Each *Poll* request sleeps `poll_interval_ms` (2 s) first. In the runner, an unfinished
    poll re-queues itself with `setNextRequest`, bounded by `poll_max_tries` (25 for exhaustion). By hand, the test
    result tells the user to click Send again.
  - No token-shaped literal is stored. The "expired credential" check builds a well-formed, never-issued token at run
    time, because the API deliberately answers expired and unknown tokens identically. Real expiry is covered by the
    existing automated test.
  - Secret variables are empty in the template.
- **Version 0.11.0.** No migration in this stage.
- Docs: `docs/postman-walkthrough.md` (beginner guide), `docs/release-checklist.md` (smoke checklist, rollback), README links.

**Verification (local, Node 22.18.0, Postgres 18.6 in Docker, Windows 11)**
- `npm test`: **131/131** pass, `skipped 0`. 7 new tests in `test/docs.test.js`:
  - spec version = package version
  - for every documented path, `DELETE` returns 405 and the `Allow` methods (minus HEAD) equal the documented methods
  - every `sendError` code in `src/` is in the spec's enum, and the reverse
  - internal routes are tagged, `x-internal`, and use non-session security
  - spec and Postman files contain no token-shaped strings, `RECEIVER_SECRET=`, `OPS_TOKEN=` or `postgres://` URLs,
    and the secret variables are empty
  - environment placeholders present, folder order 1–8, and every request path exists in the spec
  - `/docs/` and assets served under the CSP with no inline script, and only the two vendor files exposed
  - Mutation checks: deleting `invalid_query` from the spec's enum, and renaming `PUT /v1/receiver` to `PATCH`, each
    made a test fail.
- `redocly lint` (`@redocly/cli`, run from a scratch folder, not a project dependency): **valid, 0 errors**. 3 warnings were
  accepted as intended: `localhost` server entry, and no 4xx on `/health` and `/ready` (they have none).
- **Real browser (headless Microsoft Edge via puppeteer-core, scratch only)** at 390×844: `/docs/` rendered all 15
  operations and 7 tags. 0 console errors, 0 CSP violations, 0 failed requests. Only same-origin and `data:` resources;
  no horizontal scroll. The internal receiver operation expanded and showed its "Internal" description.
- **Newman** (scratch install) against a local server with the worker on: **52 requests (43 + 9 repeated polls), 94/94
  assertions, 0 failures, 36.8 s.** The polls looped as designed (exhaustion: 6 re-polls, then `failed` 4/4;
  process_then_timeout: in_progress → retry_scheduled → delivered). No demo token appeared in the Newman output or the
  server log.
- **Migrations** (scratch databases in the local container, dropped afterwards):
  - (a) Clean database: 001–008 applied in order; second run "Database schema is up to date"; `pendingMigrations` empty;
    the expected 9 tables exist.
  - (b) **Existing database with events.** Migrated to 003 only, then inserted 2 sessions, 6 events, 4 old-style
    receipts (2 per event, i.e. repeats) and persisted `server_error` modes. `npm run migrate` applied 004–008.
    - Events byte-for-byte unchanged.
    - Every event got exactly one `pending`, due delivery with the event's `created_at`.
    - `events.status` dropped.
    - Receipts folded to 2 rows with `delivery_count` 2 and `RCPT-MIGRATED`; the old table dropped.
    - Second run: up to date.
    - Then the **current app was started on that database**: the old events were listed, the persisted `server_error`
      mode gave 503s, and after switching to success all 6 were delivered.
    - The event with a migrated receipt was answered as a duplicate on attempt 1 (not processed again;
      `deliveriesReceived` 3).
  - (c) Copy of the dev database (`pg_dump` → new DB; 34 events, 37 deliveries, 81 attempts): "up to date", counts unchanged.
- **Bounded concurrency check** (local; 1 server with its worker + 2 standalone `worker-main.js` processes, each concurrency 2):
  - *Duplicate submission*, 3 rounds. 25 simultaneous identical requests gave exactly one 202 and 24 × 200 with
    `Idempotent-Replayed`, 1 distinct event ID. 25 simultaneous requests with the same new key and 25 different
    payloads gave one 202 and 24 × 409. The database had 1 event row and 1 delivery per key.
  - *Job claims*: 50 events (5 sessions × 10) gave 50 deliveries and **50 attempt rows, max 1 attempt per delivery**,
    0 non-delivered attempts; receiver processed 50, 0 duplicates. The attempt log lines (56 = 50 + the 6 events from
    part 1) were split 16 / 19 / 21 across the 3 processes.
  - Logs: 329 lines from the 3 processes, all JSON; 0 demo tokens, 0 secret values, 0 payload text.
  - This shows correctness under modest contention on one machine. **It is not a load or performance test**, and no
    throughput claim is made from it.
- **Rollback target check**: v0.10.0 (`caa3255`, git worktree) against the current schema → "Database schema is up to
  date", `/ready` 200, event delivered on attempt 1, `/docs/` 404. So 0.11 → 0.10 is an application-only rollback.
- Render rollback behaviour is taken from Render's docs (checked 2026-10-05): a dashboard rollback redeploys an earlier
  build artifact with that deploy's env vars, **disables auto-deploy**, and doesn't touch databases.

**Mistake during verification.** While stopping my own test servers, a process filter also stopped two `src/server.js`
processes that I hadn't started (probably the owner's local dev server). No data is affected (state is in Postgres),
but they need restarting by hand.

**Not run / not verified**
- Importing the files into the Postman **app** itself (only Newman, which uses the same runtime, was run). The
  walkthrough's UI steps (menu names) follow Postman's current UI as I understand it; I didn't watch them in a session.
- Screen-reader and keyboard checks of the Swagger UI page (third-party UI).
- A real-expiry run (24 h) in Postman; that path is covered by the automated test.
- Load, soak or performance testing. No performance claims.
- SIGTERM shutdown on Windows (unchanged; see Stage 5).
- The authorized `/internal/ops/worker` call on Render (needs the owner's token).

**Deployed check (2026-10-05, by Claude, after pushing a535d49).** 0.11.0 was live with the worker within about a minute
(no migration; `render.yaml` unchanged). Smoke checklist from `docs/release-checklist.md`:
- 1 `/health` 200 `0.11.0`, `inProcessWorker: true`
- 2 `/ready` 200
- 4 `/` has the CSP, `nosniff` and `X-Request-Id`
- 5 `/docs/` 200, `/openapi.yaml` 200 (`application/yaml`, version 0.11.0), vendor bundle 200, `/docs/vendor/index.html` 404
- 6 receiver without secret: 401 `receiver_unauthorized`
- 7 ops without token: 401 `ops_unauthorized`
- 8 **Newman against Render: 50 requests (43 + 7 repeated polls), 90/90 assertions, 0 failures, 40.6 s.**
  0 token-shaped strings in the output. Created 2 sessions and 4 events.
- Headless Edge on Render's `/docs/`: 15 operations, 7 tags, 0 console errors or CSP violations, no horizontal scroll.
- Not done by me: item 3 (Render log view) and item 9 (manual browser scenario). They need the dashboard or a person.
  The Stage 10 jsdom UI check was not rerun; the UI changed only by one footer link.

## Stage 12: Visitor-facing frontend, visual foundation (2026-10-05)

**Before starting.** Clean tree at `13c8516`. Read the UI (`public/*`), the OpenAPI spec, `app.js` state logic,
`test/ui.test.js` and the Render setup. Differences from the planned "alert" concept:
- the API has no alert fields beyond `title`/`message` (no severity or priority)
- the receiver mode is per session and applies at delivery time, including waiting retries
- attempts don't store the receiver's error code or the mode that was active
- worker liveness isn't public
- updates are polling only

All of these are recorded in `docs/frontend-notes.md` → *Known gaps*.

**Decisions**
- **No backend or API change.** No new dependency. Same files (`index.html`, `app.css`, `app.js`), same CSP.
- **Page structure:**
  - header: *Follow an Alert*, Demo label, service pill, *Technical details* link
  - intro line
  - workspace: composer left; navy journey right with *Recent alerts* under it
  - three experiment cards
  - a Technical details section
- **Every existing control is kept:**
  - session start/restart
  - the four receiver modes (now plain labels)
  - send with the kept Idempotency-Key
  - the three scenarios (now experiment cards)
  - duplicate submission (*Send an exact copy*)
  - replay (*Deliver again*)
  - session summary
  - status check
  - polling, backoff, the waking banner and 401 handling
- **The journey has three steps.** *Sandbox / Delivery / Receiver*, each with a plain question, so delivery
  acknowledgement and receiver processing are separate. Labels: *Waiting to send, Sending, Trying again, Delivery
  confirmed, Delivery stopped, Receiver processed alert*. The field mapping is in the frontend notes.
- **Technical view.** IDs, HTTP codes and raw JSON are in a collapsible view, which stays open across the
  2-second refresh.
- **Offline.** *You are offline* is shown only when `navigator.onLine === false`. Receiver errors are called
  *Temporary outage* / *receiver reported a problem*.
- **Tokens:** colour, type (system serif headings, system UI body), spacing, radii, shadows, focus (navy ring
  on light, light ring on navy), state treatments (`is-done/active/waiting/failed/idle/unknown`), and motion
  tokens with a global `prefers-reduced-motion` rule.
- **Not yet built:** no animation, so **no motion-off control yet** (a toggle with nothing to switch off would be
  a fake feature). The new alert composer comes in a later stage; the current title/message form is restyled only.
- **Example text changed.** The examples no longer mention "test patient" (that implied clinical use); they're
  neutral synthetic practice alerts.
- **Dropped:** the automatic dark theme (the specified palette is light with a navy canvas).
- The smooth scroll after starting an experiment now respects reduced motion and only runs when the journey is
  off-screen.

**Verification (local, Node 22.18.0, Postgres 18.6, Windows 11)**
- `npm test`: 131/131, `skipped 0`, two consecutive runs. One assertion was updated: the page `<title>` is now
  "Follow an Alert · Integration Reliability Sandbox".
  - A first full run had one failure in `test/worker.test.js` while my local UI server was also running. It passed
    alone (13/13) and in both later full runs. This is the timing sensitivity already noted in Stage 5, not a
    Stage 12 change (no backend code changed).
- **Real browser, headless Edge (puppeteer-core) against a local server with the worker on, real API data, no
  fixtures. Second run: 35/36 checks.**
  - Header shows *Service ready*.
  - Send is disabled before a session; the session starts only on click.
  - The token is in `sessionStorage`, not in the URL or page text, and not in the technical view.
  - Send → *Alert accepted* → *Delivery confirmed* + *Receiver processed alert* (separate steps).
  - Exact copy: *Copy recognized*, still 1 alert.
  - Experiment 1: *Trying again*, then confirmed after *Turn receiver back on*.
  - Experiment 2: *no reply in time*, *recognized 1 as a repeat*, explanation shown.
  - Experiment 3: *Delivery stopped*, *Not processed*; after *Deliver again*, *Delivered again (1): Delivery
    confirmed*.
  - The technical view keeps its open state and shows raw JSON.
  - Offline submission: an ambiguous-result message and *You are offline*. Resending after reconnecting created
    exactly one alert.
  - Phone width (390 px): composer before journey, journey vertical.
  - Expired token: explained, *Start a new session* offered, 0 automatic session creations.
  - No horizontal scroll at 1440 px and 390 px, with and without data.
  - **axe-core: 0 violations** on desktop (empty and with data) and mobile.
  - The one "failure" is the browser's own network log for the two deliberate failures (offline, 401). There
    were no script errors.
- **Screenshots reviewed** (desktop 1440×900, mobile 390×844, full pages). Fixed after the first run:
  - a stray "null" text in the journey (`replaceChildren` stringifies `null`)
  - a doubled period after the locale time ("p.m..")
  - an unclear delivery summary after a replay (now prefixed "Delivered again:")
  - raw ISO-like session expiry (now medium date + short time)
  - truncated history titles on phones (now wrap)

**Not verified**
- Real screen readers.
- Safari, Firefox and real mobile devices: only Chromium-based Edge was used.
- Visual review by a person.
- Windows high-contrast mode.
- The check scripts (puppeteer-core, axe-core) live in a scratch folder, not in the repository.

**Deployed check (2026-10-05, by Claude, after pushing b551c35).** The new page was live about 45 s after the push.
- `/health` 200 (version unchanged at 0.11.0; the API didn't change), `/ready` 200, and the CSP header unchanged.
- The same headless-Edge check against Render with real data: **35/36**. The same single "failure" was the browser's
  own log of the deliberate offline and 401 requests. axe-core found 0 violations on desktop (empty and with data)
  and mobile.
- Screenshots were reviewed at 1440 px and 390 px.
- The check created 2 sessions and 6 synthetic alerts.

## Stage 13: Alert composer connected to the event API (2026-10-05)

**Before starting.** Clean tree at `737a629`. Findings that shaped the design:
- The previous UI kept the unsent key only in memory, so a reload lost it.
- `GET /v1/events` returns each event's `idempotencyKey`, so an unconfirmed send can be *confirmed by reading* (never
  disproved).
- Keys are scoped per session.
- The browser's `maxlength` counts UTF-16 units, while the API counts Unicode characters.

**Decisions** (details in `docs/frontend-notes.md` → *Composer*)
- **Three sample cards**, labelled *Sample alerts*, as given: Service request / Equipment notification / Team update.
  They use `demo.notification` with `title` + `message` only. The first is preselected so a visitor can send without
  typing, and choosing a sample never touches the receiver.
- Editable fields with live character counts and validation that matches the server (no `maxlength`). A
  text-node-only message-card preview, and a collapsed *View request JSON* (token shown only as a placeholder).
- **One *Send alert* button.** It starts a session only when there is none, and only on that click. Its order is:
  1. validate
  2. disable the button synchronously
  3. save `{key, body}` to `sessionStorage` (`irs.pendingSubmit`)
  4. POST
- Answers:
  - 202/200 shows the alert in the journey at once, from the response, with "Delivery may still be pending".
  - 4xx settles the key. 401 explains that nothing was saved, and a new session comes only on the next click.
    Quota errors give a plain message, plus a *Start a fresh session* button for `event_limit_reached`.
  - Network failure, timeout, or 5xx → "We could not confirm whether your alert was accepted" with *Check again*
    (same key and payload) and *Stop checking*.
- **While unconfirmed:** *Send alert* and *Start fresh session* are paused, and the draft is kept separately. A
  reload restores the uncertain state without resending. A routine refresh may confirm the alert by finding its key
  in the list.
- **No backend change, no API change, no new dependency.** No visual effect delays the request.
- The receiver is shown as one line in the composer. The four mode choices moved below the experiments (*Set the
  test receiver yourself*) until Stage 16. The Stage 12 *Try another example* button and the separate *Start demo
  session* button were removed; *Send alert* covers both.

**Verification (local, worker on, `MAX_EVENTS_PER_SESSION=8` to reach the quota; real API data, headless Edge)**
- `npm test`: 131/131, `skipped 0`.
- **Stage 13 browser suite: 58/58.**
  - **Preset send:** sample 1 preselected; fields filled; the first click created exactly 1 session and sent 1 POST;
    "Alert accepted … may still be pending"; the journey shows the alert at once. Switching samples made 0 receiver
    changes.
  - **Edited message:** a message containing `<b>` and `<img onerror>` showed as plain text in the preview (no
    elements created, no script ran) and was stored exactly as typed, including a line break. The preview was
    marked "edited".
  - **Validation:** blank title → error and focus on the field; 101 characters → blocked, counter flagged. Invalid
    drafts sent 0 requests. 100 emoji counted as 100 and were accepted by the server.
  - **Rapid double click:** with the POST held at the network layer, 3 scripted clicks + a double click + Enter
    produced **exactly 1 request**. The button stayed disabled with "Sending…".
    - A first version of this check had the last click land after a fast local answer, which is a legitimate
      second send, so it failed once. It was rewritten to hold the request; the behaviour itself didn't change.
  - **Ambiguous failure, answer lost after the server processed it** (DevTools `Fetch` failed the response; the
    server had answered 202):
    - The "could not confirm" message appeared, with *Send alert* paused.
    - The key and payload were in `sessionStorage`.
    - Editing the draft didn't change the saved submission.
    - *Check again* sent the **same key and payload** → "Confirmed: your alert was accepted", and exactly one
      alert exists. The edited draft was kept.
  - **Request lost before reaching the server, then reload:** the uncertain state came back after the reload with
    the same key, **0 automatic resends** in 2.5 s, and the request view showed the unconfirmed request. *Check
    again* (same key) → 202 "had not arrived, so this check sent it", and exactly one alert.
  - **Answer lost, then reload:** confirmed by reading the list, 0 resends, one alert.
  - **Expired session:**
    - On load: explained, 0 sessions created without a click; one click → 1 session + accepted.
    - During a send: the request's Authorization header was swapped for a never-issued token, which the API
      answers like an expired one. Result: "Your demo session has ended. Nothing was saved", 0 automatic sessions,
      no unconfirmed state left; the next click → 1 session + accepted.
  - **Quota:** "reached its limit of alerts" plus a *Start a fresh session* button, with 0 sessions created
    automatically.
  - No horizontal scroll at 1440 and 390 px, composer before journey on phones, axe-core 0 violations on desktop
    and mobile, no script errors.
- **Stage 12 suite, updated for the new session flow:** 35/36. The only "failure" is the browser's own log of the
  deliberate offline and 401 requests, as before.
- Screenshots reviewed. Fixed: the receiver label wrapped into three ragged lines with the icon alone (now an
  icon + text grid), and a missing space in its text ("receiver:Works").

**Not verified**
- The 90 s request timeout itself (too slow to wait for). It uses the same code path as the network failure that was
  tested.
- Real screen readers; browsers other than Chromium-based Edge; real phones.
- The quota on Render (100 per session there; tested locally with 8).

**Deployed check (2026-10-05, by Claude, after pushing 9530030).** The composer was live about 40 s after the push;
`/ready` 200.
- Stage 13 suite against Render, without the quota step: **56/56**. This covered preset send, the edited message,
  validation, the held double click (1 request), both kinds of lost request with *Check again*, reload during
  uncertainty, expiry on load and during a send, layout, and axe 0 violations.
- Stage 12 flow suite against Render: 35/36 (the same expected browser network log). It covered all three
  experiments and *Deliver again* through the new send path.
- These checks created about 8 sessions and 20 synthetic alerts.

## Stage 14: Live journey visualization with minimal motion (2026-10-05)

**Before starting.** Clean tree at `2fb3ff9`. Client-side problems found in the existing code:
- `refresh()` checked only that *a* token existed after its requests returned, so a refresh in flight during a
  session switch could write the old session's alerts into the new session.
- Any 401 ended the current session, even when it answered a request made with an older token.
- Obsolete requests were never cancelled.
- A failed receipt request failed the whole detail view.
- Poll failures kept old data with no stale marker.
- The experiment text stated backend timing ("2, 4 and 8 seconds", "about 14 seconds", "four tries") that the API
  doesn't expose.

**Decisions** (full mapping in `docs/frontend-notes.md` → *Journey*)
- **Diagram of the three real components:** *Your alert → Delivery service ⇄ Receiving system*, in HTML plus inline
  SVG icons. No queue or database node is drawn. The delivery service carries the badge (*Saved, Waiting, Sending,
  Trying again, Stopped*, plus *Confirmed* for a delivered alert, which the brief's list didn't name).
  - Separate *Delivery try* and *Acknowledgement* paths.
  - A *Processing record* card driven only by the receipt.
  - Receipt loading is *Checking…*; a receipt that can't be loaded is *Unknown*, explicitly "not proof that nothing
    was processed".
- **Presentation adapter `public/journey-model.js`:** a pure function from API responses (plus the browser-only
  submitting state) to a view model. It's loaded as a second same-origin script and unit-tested in Node.
  - Stable keys: `event:<id>`, delivery IDs, and attempt keys `<deliveryId>:<attemptNumber>`.
  - Replays are separate deliveries.
- **Local vs server state:** while the POST is unanswered, the journey shows *Sending to the sandbox / Not saved
  yet*; when the outcome is uncertain, *Unconfirmed / Unknown*; after 202, the server's state.
- **Timing:** only `nextAttemptAt`, `attemptCount` and `maxAttempts` (from the API). The countdown updates once a
  second; at zero it says *Waiting for the next attempt* until the API reports a try. The experiment text no longer
  quotes seconds or a fixed number of tries.
- **Stale answers:**
  - `AbortController` per refresh and per selected alert.
  - Answers are discarded unless they are still for the current session and selection.
  - A 401 only ends the session it was sent with.
  - The renderer also only uses detail data for the selected alert.
- **Interruption:** the last known state stays, with "Showing the last known state from HH:MM:SS. Reconnecting…".
  Polling failures never change a delivery's state.
- **Accessibility:** the journey region is no longer `aria-live` (it's redrawn on every refresh). A hidden live
  region announces one sentence only when the delivery or processing state changes.
- No backend or API change. No new dependency. No animation beyond the countdown text.

**Verification (local, Node 22.18.0, Postgres 18.6, worker on; headless Edge with real API data; faults injected
with DevTools `Fetch`)**
- `npm test`: **145/145** (14 new adapter tests), `skipped 0`.
- The adapter tests use fixtures shaped like the OpenAPI schemas. They cover:
  - local sending and uncertain states
  - just accepted, and the list summary only (no invented history; *Checking…*)
  - sending; retry in the future (countdown 3 s, next try 2)
  - a countdown that has passed (*Waiting*, no fabricated send)
  - a lost lease
  - delivered + receipt; delivered with the receipt unavailable (*Unknown*)
  - reply too late, both mid-retry and finished
  - exhaustion
  - a replay, with separate keyed deliveries and unique attempt keys
  - a stale marker that doesn't change the state
  - an unknown state
- **Stage 14 browser suite: 41/41.**
  - The local *Sending to the sandbox* state while the POST is held, then *Accepted*.
  - Exactly 3 components.
  - *Confirmed* with acknowledgement *Delivery confirmed*, "1 try sent", and *Processed*.
  - *Trying again* with "1 of 4 tries used", "Next try in about N s (at …)", *Error reply*, and an explanation.
  - **Offline during a retry:** the stale banner appeared; the countdown reached zero and the view said *Waiting*,
    never *Stopped*. Back online, the banner cleared and the alert was *Confirmed*.
  - **Receipt requests failed:** *Unknown* plus "not proof…", with the delivery still *Confirmed*.
  - **Selection change:** alert A's history answer was held while B was selected. The page cancelled A's request
    (`net::ERR_ABORTED`), and releasing it late left B on screen.
  - **Reload:** a MutationObserver recorded every delivery badge drawn from page load. Only *Confirmed* was ever
    drawn (no replayed transitions).
  - **Session switch:** 3 old-session answers were held, *Start fresh session* was pressed, and the answers were
    released. No old alert appeared, **not even briefly**, and the new session was kept.
  - **Exhaustion and replay:** *Stopped* with *No processing recorded*, then "This is a new delivery, started by
    hand", *Confirmed*, two deliveries with distinct IDs and unique attempt keys, and the original still *Stopped*.
  - No horizontal scroll at 1440 or 390 px; stacked on phones; axe-core 0 violations on desktop and mobile; no
    script errors.
- **Mutation checks:**
  - With the session guards removed (token comparison and abort on switch), the session-switch check **failed**:
    old-session alerts flashed into the new session. A first version of that check looked only at the end state
    and missed it, so it now watches for any appearance.
  - With the selection guards removed, the "request cancelled" check failed. The "not overwritten" check still
    passed, because the renderer's own `eventId` check is a second line of defence.
- **Regression suites (updated to the new labels):** Stage 13 56/56 (quota step not run); Stage 12 35/36 (the same
  expected browser network log).
- **Fixed after screenshot review:**
  - The diagram was stacked even on desktop: the panel's content box (~45.5rem) was just under the first 46rem
    breakpoint. Now 40rem.
  - "Acknowledgement" was clipped in its column, and "Not processed yet" wrapped to three lines (sentence-case path
    names, flatter processing card).
  - The countdown was shown twice (the facts list now shows only the clock time).
  - Low contrast for small technical text inside light notices on the navy panel (found by axe).
- Test-side issues found and fixed along the way:
  - "Unknown" was checked before the receipt failure was known (that led to the *Checking…* label).
  - A history click raced a list re-render.
  - Uppercase text from CSS `text-transform` appears in `innerText`.

**Not verified**
- Real screen readers (the announcement wording is untested with assistive technology).
- Browsers other than Chromium-based Edge; real phones.
- Very long outages: polling backs off to 30 s as before, so the countdown can sit at *Waiting* for that long
  after reconnecting.

**Deployed check (2026-10-05, by Claude, after pushing 7535ab8).** `/journey-model.js` was served about 30 s after the
push; `/ready` 200.
- Stage 14 suite against Render: **41/41**. This included the held POST, offline during a retry (stale banner, then
  *Waiting* at zero, never *Stopped*), failed receipt requests (*Unknown*), the cancelled late answer on a selection
  change, the reload snapshot, the session switch with held old-session answers (no flash), and exhaustion and
  replay.
- Stage 13 suite: 56/56. Stage 12 flow suite: 35/36 (the same expected browser network log).
- The checks created about 7 sessions and 18 synthetic alerts.

## Stage 15: Purposeful motion on the journey (2026-10-05)

**Before starting.** Clean tree at `675ad64`. Findings:
- The Stage 14 acknowledgement path drew a return arrow tinted by state even for a timeout (amber) and a
  connection failure (red), i.e. a reply that never arrived.
- A successful try finishes in milliseconds while polling runs every 2 s, so most successes are first *observed
  already finished*.
- The journey is redrawn on every refresh, so motion needs its own layer.
- The global CSS reduced-motion rule doesn't affect Web Animations.

**Decisions** (details in `docs/frontend-notes.md` → *Motion* and *Two-query race*)
- **Adapter:**
  - `acknowledgement.responseObserved`: a return arrow only for a 2xx or an HTTP error reply; otherwise a broken,
    neutral line.
  - Timeout is labelled *Timed out*, with a note that it is not proof of no processing.
  - `delivery.waitFrom` (the last try's `endedAt`) for the wait bar.
  - "Already processed: n repeats recognized, not processed again" from the receipt.
- **`public/journey-motion.js`:**
  - A pure planner (effects keyed by stable attempt keys; the first observation after the displayed alert
    changes is silent; a try first seen already finished gets one labelled "Latest attempt (already finished)"
    look back; receipt-driven *Processed* / *Already processed*).
  - A player (Web Animations API, transform/opacity only, at most about 1.7 s per effect, no loops, a queue of
    at most 2 pending effects keeping the newest, cancelled on an alert or session change, a hidden tab, Motion
    off, or a width change).
  - The overlay `#journey-motion` is never redrawn by refreshes.
- **Static (always) vs motion (when on):** see the table in the frontend notes. The *Deliver again* recovery
  action moved into the stopped delivery-service node.
- **Motion control:** *Motion: on/off* (`aria-pressed`), defaulting to `prefers-reduced-motion`, with an explicit
  choice kept in `sessionStorage`. A visible note says animations illustrate and aren't real transmission timing.
  With motion off, the wait bar updates once a second without animation.
- No backend or API change. No new dependency.

**Found and fixed while verifying**
- **A Resize observer cancelled every effect** whenever the journey's height changed, which routine refreshes do.
  It now cancels only on width changes. A first fix based on the diagram's height would have cancelled effects
  queued in the same render.
- **The player deduplicated by attempt key alone**, so after a live send the same attempt's outcome (*Timed out*,
  *Delivery confirmed*, *Error reply*) never played. It now deduplicates by effect type and key.
- **API read race, made visible by the recordings:** `GET /v1/events/{id}/deliveries` reads delivery rows and
  attempts in two queries. The frames showed a badge *Waiting* next to "Try 2: sending…", and on a phone *Sending*
  next to "Try 1: timed out".
  - The adapter now reconciles towards the newer attempt evidence (in progress → *Sending*; 2xx → *Confirmed*;
    ended without 2xx → *Waiting*, "recording what happens next", without guessing retry vs stop). Unit-tested.
  - The backend was not changed. A one-transaction read is suggested as a follow-up.
- **Visual:** long moving labels ("Sending try 1", "Timed out: no reply") covered node headings and the
  *Acknowledgement* label, so they were shortened. Paths stop short of node edges. On phones, packets go down
  the left of the path labels and replies up the right. The "Latest attempt" label moved off the *Updated* line.

**Verification (local, Node 22.18.0, Postgres 18.6, worker on; headless Edge with real receiver modes)**
- `npm test`: **155/155**, `skipped 0`.
  - 9 new planner tests: silent first sight; nothing recorded before the history loads; own send live (accepted
    → send → ack + processed); quick success missed (`latest:ack` only, never `send`); several unseen attempts
    (only the newest gets a look back); 503 then retry (a packet only when attempt 2 is observed); ptt (processed
    from the receipt while in flight, timeout, then `duplicate`, no second `processed`); switching alerts
    (silent on return; replay attempts keyed separately); tab resync.
  - Adapter tests extended: `responseObserved`, *Timed out* note, `waitFrom`, the already-processed note, and
    three two-query race shapes.
- **Stage 15 browser suite: 49/49.** A MutationObserver recorded every effect with the state text on screen at that
  moment.
  - **Success:** accepted card, then a labelled look back (the try had already finished), started only after
    *Confirmed* was on screen; *Processed* from the receipt; nothing repeated; nothing more after settling.
  - **503:** the error reply drawn with a return arrow; the wait bar measurably filling, labelled by the
    countdown; the attempt-2 illustration only after attempt 2 was observed; recovered to *Confirmed*.
  - **Timeout:** a live packet drawn while the state said *Sending*; then a *Timed out* chip with nothing
    travelling back; the acknowledgement a broken line labelled *Timed out*; never presented as "not processed".
  - **process_then_timeout:** *Processed* while the reply was *Timed out*; then *Confirmed*; the card says "Already
    processed: 1 repeat recognized"; exactly one *Processed* illustration plus *Already processed*.
    - Recorded order: accepted → send → processed → timeout → latest → duplicate.
  - **Exhaustion:** *Stopped*, *Deliver again* inside the delivery node, no motion or running animation left.
  - **Switching:** reselecting four alerts replayed nothing; switching mid-animation cleared the layer.
  - **Refresh:** no illustration on load.
  - **Hidden tab** (simulated `visibilitychange`): cleared at once; when visible again, the current state (*Trying
    again*, not *Sending*) was shown and the missed timeout was not replayed.
  - **Reduced motion** (emulated): *Motion: off* by default; the state text still updated; the wait bar static;
    zero illustrations. An explicit *Motion on* made them play; *Motion off* cleared the layer at once.
  - **Phone:** packets travel downward in the stacked layout; no horizontal scroll; axe 0 violations on phone and
    desktop; no infinite animation observed at any time; no script errors.
- **Recordings:** frame sequences of the journey panel (every 90 ms while the layer had content) for success,
  timeout, 503 and ptt, at 1440 px and 390 px, were inspected; the issues above came from them.
- **Regression suites:** Stage 14 41/41, Stage 13 56/56, Stage 12 35/36 (the same expected browser network log).

**Not verified**
- Real screen readers.
- Browsers other than Chromium-based Edge; real phones.
- A real `visibilitychange` (it was simulated, because headless tabs don't change visibility).
- A *live* success sequence (send → acknowledgement) in the browser: successes complete between polls, so the
  browser showed the labelled look back instead. The live sequence is covered by the planner unit tests and by
  the live timeout and ptt runs.
- The two-query race fix in the backend (deliberately not done).

**Deployed check (2026-10-05, by Claude, after pushing 89e5846).** `/journey-motion.js` was served about 30 s after the
push; `/ready` 200.
- The first Stage 15 run against Render scored 46/49, all from timing assumptions in my tests, not page defects:
  - axe measured the decorative, `aria-hidden` "Latest attempt" label mid-fade, at partial opacity.
  - The ptt timed-out window fell between two 2-second polls once (the page correctly went straight to *Confirmed*
    with "Try 1: timed out" in the history).
  - After 5 hidden seconds, *Sending* was legitimately try 2.
- The tests were changed: axe runs when no illustration is mid-fade; the ptt check accepts the window seen live
  *or* shown in the history; the hidden-tab check looks for try 1's timeout in the history.
- Rerun against Render: **Stage 15 49/49** (the ptt window was seen live), **Stage 14 41/41**, Stage 13 56/56,
  Stage 12 35/36 (the same expected browser network log).
- The revised suites were run against Render only, not locally again.
- The checks created about 10 sessions and 35 synthetic alerts.

## Stage 16: Guided scenario cards and simplified receiver controls (2026-10-05)

**Before starting.** Clean tree at `29b4347`. Findings:
- The Stage 12–15 experiments, the free mode radios and "Turn receiver back on" changed the session-wide receiver
  mode at any time, even while other alerts were being delivered.
- `GET /v1/summary` counts active deliveries for the whole session (the list shows only 20), so it can serve as the
  re-read before a change.
- Restoring is just `PUT /v1/receiver`; it never sends anything.
- `replayDelivery()` didn't report its outcome.
- The receiver recognizes a repeat before any simulated failure in every mode, so "Avoid processing twice" needs no
  configuration step.
- There's no server-side "scenario", so guide state is a browser-side layer.

**Decisions** (details in `docs/frontend-notes.md` → *Guided scenarios*)
- **Four cards:** Normal delivery plus three guides. Only the existing endpoints are used; there is no backend
  change, no new dependency, and no timers.
- **`public/guide-model.js`:** pure step logic (unit-tested), turning saved milestones plus the observed journey
  view into "Step x of y", one instruction and the allowed actions. Steps advance only on API evidence.
- **Start:** the button is disabled before any await. Then:
  1. Re-read the session's active deliveries.
  2. Refuse with a reason if any are active.
  3. Save the guide.
  4. `PUT` the mode, and only after a 200 send a new alert through the Stage 13 pipeline.
  5. A failed setup stops with a recoverable message, and nothing is sent.
- **Recover:** *Restore receiver* appears after a rejected try is observed; it only sends `PUT`. The text says the
  next scheduled try delivers.
- **Twice:** no configuration change; the guide waits for the receipt's repeat recognition.
- **Rescue:** *Restore and retry* appears only once a failed terminal delivery is confirmed.
  - Order: restore (awaited), re-read the delivery, save `replay: requested`, then call the existing replay endpoint
    with its stored Idempotency-Key.
  - `replayDelivery()` now returns accepted / exists / rejected / unknown.
  - After a refresh, an unconfirmed request shows *Check again* (the same key); a replay visible in the history is
    taken as evidence.
- **Locks:** guide start buttons, Normal delivery (when it would change the mode) and the free receiver choices are
  disabled with a one-line reason while any alert in the session is being delivered, while a guide is open, or while
  a send is unconfirmed. A change by hand re-reads first. The page states that another tab can't be excluded.
- **State:** `irs.guide` plus `irs.sessionTag` (a new tag per session) in `sessionStorage`; milestones only. Nothing
  is sent on load.
- **Guidance:** an inline panel above the journey (not a modal), keyboard-reachable buttons, the instruction
  announced only when it changes, no autoplay. *Leave guide* explains that delivery continues in the background.
  *Waiting for the delivery service* plus *Reconnect now* when polling fails or is slow.
- The old "Turn receiver back on" buttons and the Stage 12 experiment cards were removed.

**Found and fixed while verifying**
- A failed poll redrew only the journey, so the guide never showed *Waiting for the delivery service* and the card
  locks went stale. The guide and cards now redraw on poll failure.
- Stale-banner text "p.m.. Reconnecting" (from Stage 14) was reworded to "Reconnecting… Showing the last known
  state, from HH:MM:SS".
- Four cards in a three-column grid left one card alone; the grid is now 2 columns from 40rem and 4 from 72rem.
- The free-choice lock reason sat below the radios; it's now above them.

**Verification (local, Node 22.18.0, Postgres 18.6, worker on; headless Edge, one browser context per section)**
- `npm test`: **163/163** (8 new guide-model tests), `skipped 0`.
- **Stage 16 browser suite: 52/52** (server with `MAX_EVENTS_PER_SESSION=8` for the quota case).
  - **Load:** no guide, 0 POST/PUT; four cards.
  - **Normal delivery:** confirmed, with no guide panel.
  - **Recover:**
    - A keyboard start plus two rapid clicks → exactly 1 `PUT server_error`, then 1 alert.
    - Other cards and the free choices were locked with reasons.
    - *Restore receiver* appeared only after a rejected try was observed.
    - A refresh kept the step and sent nothing.
    - Restore by keyboard → 1 `PUT success` and **0 sends**; a refresh after restoring sent nothing.
    - Delivered on the scheduled retry with only one alert ever sent and no replay.
    - A refresh after done sent nothing; *Close guide* worked.
  - **Twice:** a refresh mid-way kept the guide; done with "One processing result (RCPT-…). The repeat was
    recognized"; the card showed *Already processed*; the guide said the mode stays; no mode change after the
    start.
  - **Rescue:**
    - No retry action before the stop; *Restore and retry* after it; a refresh at that step sent nothing.
    - A double click → 1 `PUT success`, then 1 replay request, which was held. A reload with the request still held
      showed "could not confirm the retry request" and **sent no replay** in 2.5 s.
    - *Check again* re-sent with the **same Idempotency-Key** → done. History: original *Stopped* plus *Delivered
      again (1): Confirmed*.
    - An earlier run had released the held request before reloading. The guide then found the replay in the
      history and finished without sending anything, which is also correct.
  - **Interrupted setup:** the `PUT` failed at the network → "not confirmed, so nothing was sent" with 0 alerts; it
    survived a refresh; *Try again* proceeded.
  - **Leave:** "keeps being delivered by the sandbox in the background".
  - **Active alert:** guides and free choices locked with "still being delivered", and unlocked once it stopped.
    An alert created behind the page's back (an in-page API call, like another tab) → *Start* re-read, refused,
    and changed and sent nothing.
  - **Offline:** "Waiting for the delivery service" with *Reconnect now*; it cleared when back online.
  - **Quota:** "the alert was not sent … still set to Temporary outage", with the composer's limit message and 0
    automatic sessions.
  - No horizontal scroll; the guide sits above the journey on phones; axe 0 violations on desktop and phone; no
    script errors.
- **Regression:** Stage 15 49/49, Stage 14 41/41, Stage 13 58/58 (quota included), Stage 12 24/25 without its old
  experiment flows (only the expected browser network log).
  - Stage 14/15 helpers now set the mode through the API when the UI lock is on, as another tab could, because
    those suites change the mode mid-delivery on purpose.
  - Stage 15 was rerun on a second local server with the normal alert limit, after the first run hit the lowered
    limit (429s in the log).

**Not verified**
- Real screen readers.
- Other browsers; real phones.
- Back/forward navigation as such: the page is a single document, and reloads were tested.
- True concurrent use from two real tabs (simulated by an API call from the page).

**Deployed check (2026-10-05, by Claude, after pushing da5912f).** `/guide-model.js` was served about 20 s after the push;
`/ready` 200.
- Stage 16 suite against Render, without the quota step (the deployed limit is 100): **49/49**. That covered all
  three guides, rapid clicks and keyboard start, a refresh at each step, the held-and-reloaded retry with a same-key
  *Check again*, interrupted setup, leaving, the active-alert lock and the behind-the-page race, offline waiting,
  layout and axe.
- Stage 15 first scored 47/49 on Render (exhaustion never stopped). Cause, in my test helper: after clicking a mode
  it waited for "Saved", which was still shown from the previous change. Over the network, the new re-read before the
  `PUT` meant the alert was sent before the mode changed. The helpers now clear the old message first.
- Rerun against Render: Stage 15 49/49, Stage 14 41/41, Stage 13 56/56, Stage 12 24/25 (the expected network log).
- The checks created about 15 sessions and 50 synthetic alerts.

## Stage 17: Understandable outcomes and event history (2026-10-05)

**Before starting.** Clean tree at `a03ffb5`. Findings:
- The history showed only the 20 newest alerts, with no way to load more, and the journey couldn't open an alert
  outside that page.
- The list was rebuilt every 2 s.
- `GET /v1/events` carries no receiver data.
- The "What happened so far" list showed tries but not waits, stop reasons, interrupted attempts or the receiver's
  record, even though all of them are in stored fields (`startedAt`/`endedAt`, `completedAt`, `failureReason`,
  `firstReceivedAt`/`lastReceivedAt`).

**Decisions** (details in `docs/frontend-notes.md` → *Outcomes and history*)
- **Adapter:** `buildTimeline()` and `buildOutcome()` in `journey-model.js` (pure, unit-tested).
  - The timeline groups each delivery separately, in plain words and with recorded times. Interrupted attempts are
    marked unknown, and no stop reason is invented.
  - The outcome keeps acknowledgement evidence (Delivery confirmed / Retried successfully / Stopped / Not
    finished) apart from receipt evidence (Processed once / Processed / Not processed; hidden when unknown).
  - Timing appears only when both ends are recorded and only for the original delivery.
  - The summary always describes the newest delivery and says so.
- **History store:**
  - Every alert seen in the session. The polled first page is merged in, older pages load on request via the API's
    cursor, and alerts that slide off the first page are kept with "Status as of …".
  - Cards are updated in place, keyed by event ID.
  - Processing appears on a card only when its receipt was read in this page.
  - Viewing an alert updates its card from the detail read.
- **`keepFocus()`** now also holds the focused element's position on screen (no jumps when content above it
  changes), and re-focuses with `preventScroll`.
- **New alert** (a draft only), **Reset view** ("nothing was cancelled or deleted").
- **Technical details:** the request with the token as a placeholder, the 202/200 explanation, IDs and timestamps
  with plain definitions, per-attempt HTTP status/category/start/end, the receipt, and submission idempotency vs
  receiver duplicate protection.
- No backend or API change. No new dependency.

**Found and fixed while verifying**
- **Page jump:** the focused card's button kept focus but its card moved down by about 585 px when the journey
  above grew, and later by about 166 px when a new card was inserted above it. `keepFocus()` now compensates in
  both cases: the focus check measures less than 30 px of movement.
- **Load older focus:** when the older page held only alerts already kept in the list, focus fell to the page body.
  It now lands on the last card.
- **Text:** "p.m.." doubled periods and a waiting line ending ". (next try…)"; the processing sentence repeated
  under the outcome.
- **Phone:** cards were tall (the button on its own row), and timeline times sat below their entries, readable as
  belonging to the next one.
- **Test-side mistakes, corrected and re-run:** miscounted alerts (a replay is not a new alert); a session assertion
  that ignored the test's own session; `$$eval` turned into `$eval` twice by `$`-patterns in my patch tooling; and
  "Load older" assumed the older page held unseen alerts, which the history store had correctly already kept.

**Verification (local, Node 22.18.0, Postgres 18.6, worker on; headless Edge with real API data)**
- `npm test`: **171/171** (8 new timeline and outcome tests), `skipped 0`. Fixtures cover:
  - each outcome type, including non-retryable, session-ended and "no reason recorded" stops, which the mock
    receiver can't produce live
  - interrupted attempts
  - in progress and waiting with the recorded due time
  - replay groups
  - "processed once" only from the receipt (two attempts with no repeat in the record → *Processed*; receipt
    unavailable → hidden)
  - no timing across a retry by hand
- **Stage 17 browser suite: 46/46.**
  - **Empty history**, before and with a session.
  - **Delivery confirmed:** outcome, separate processing line, timing, and a timeline with recorded times.
  - **Retried successfully:** with "Waiting before another attempt (about N s, from the recorded times)".
  - **Processed once:** "reached it 2 times", plus the timed-out attempt and the recognized repeat.
  - **Stopped:** "allowance (4) was exhausted", *Not processed*, and the recorded stop reason.
  - **Replay:** *Retried successfully … after a retry by hand*, groups "Original delivery: Stopped" and "Delivered
    again (1): Confirmed (current)", the summary naming the newest delivery, no timing.
  - **Cards:** fields, processing hidden for a never-viewed alert and shown when read, and stable newest-first order.
  - **Focus:** an update arrived (a new card above, the journey growing) while a card's button had focus; focus
    stayed and the button moved less than 30 px.
  - **Browsing:** viewing an older alert made only GET requests.
  - **Technical details:** a placeholder instead of the token, the Idempotency-Key, HTTP 202, definitions, both
    protections, and no token or secret anywhere in the page's HTML.
  - **Pagination:** 20 after a reload, then *Load older alerts* by keyboard with the cursor → 21, "All your alerts
    are shown.", focus on a card, and "Status as of" on older cards; the oldest alert opened.
  - **Stale:** offline → "Reconnecting… Showing the last known state", with the history kept.
  - **New alert:** draft, title focused, nothing sent. **Reset view:** "nothing was cancelled or deleted", only
    GETs.
  - Exactly one session (the test's own). No horizontal scroll; axe 0 violations on desktop and phone; no script
    errors.
- **Regression:** Stage 16 49/49, Stage 15 49/49, Stage 14 41/41, Stage 13 56/56, Stage 12 24/25 (only the expected
  network log). Earlier suites were updated to the new card markup and the new timeline wording.

**Not verified**
- Real screen readers.
- Other browsers; real phones.
- Very long histories (up to the session limit of 100 alerts) beyond the 22 tested.
- Safari's scroll anchoring (the page compensates itself, so it shouldn't depend on it).

**Deployed check (2026-10-05, by Claude, after pushing dd61c22, then 173544c).**
- First run against Render: Stage 17 46/46, Stage 16 49/49, Stage 15 49/49, Stage 14 41/41, Stage 12 24/25 (the
  expected network log), but **Stage 13 55/56**: "alert shown in the journey at once" failed.
- **A regression introduced by this stage.** The journey now reads from the history store, and `showAccepted()`
  only added the accepted alert to the first-page list. So the journey stayed empty until the next list refresh.
  That refresh is instant locally but not over the network.
  - A deterministic check, holding every alert-list refresh at the network layer, reproduced it against Render
    (journey empty, no card).
  - The fix adds the accepted alert to the store at once; the same check then passed locally.
  - Building that check took two attempts. The first held a refresh that session creation waits for, and the second
    used a DevTools URL pattern whose `?` is a wildcard, so it also held the POST.
- After pushing the fix (`173544c`): the check passed on Render, Stage 13 56/56, Stage 17 46/46.
- One Stage 17 check assumed the receiver would be restored before try 2. When try 2 also failed first, try 3 was
  confirmed, so the check now accepts a later attempt; the page was correct both ways.
- The checks created about 12 sessions and 90 synthetic alerts.






## Stage 18: Polish and accessibility across the frontend (2026-10-05)

**Before starting.** Clean tree at `349d9b1`. Findings from an audit and a measurement script (headless Edge,
instrumented timers, `PerformanceObserver` layout shifts, `MutationObserver` on live regions, request log):
- The explicit *Motion: on* choice overrode an OS request to reduce motion.
- Live regions were rewritten on every render or poll: in 10 s of an active retry, session line 9, result 10,
  announcer 8, poll status 6, receiver lock 9, technical summary 9 mutations. The unconfirmed-send panel
  (`role=alert`) was rebuilt the same way.
- The announcer spoke on any change of the delivery/processing wording, including "Sending".
- Cumulative layout shift 0.347 on a first visit and send: sample cards, preview, history and scenario cards were
  created after the first paint (top shift 0.276 at 166 ms).
- One em dash in the journey facts; error notices led with HTTP details.
- Requests: one polling owner, 0 requests and 0 intervals when idle, 20 requests per 10 s while a retry is active
  (events, receiver, summary, deliveries, receipt, 4 each). Assets: no images or fonts; Render serves Brotli
  (`app.js` 92 KB raw, 28 KB transferred).

**Changes** (details in `docs/frontend-notes.md` → *Polish and accessibility*)
- Motion: OS request always wins; the control can only reduce further, shows *Motion: off (system setting)* and is
  disabled then; changes re-evaluated live. Smooth scroll follows the same rule.
- Announcer: meaningful transitions only (retry scheduled, confirmed, stopped, processed, repeat recognized), plus
  one message each for connection lost and restored.
- Live regions and the pending panel update only when their content changes; the stale banner and summary are no
  longer live regions.
- First-visit content of the composer, empty journey, history and scenarios is in `index.html`; the empty journey
  is the three-part diagram marked *Not started*.
- Composer order: Send directly under the message, its result after it, then preview and request JSON. Intro link
  to the scenarios.
- `GET /v1/receiver` every 30 s and on tab return instead of every poll.
- Copy: no em dash, plain next actions, HTTP details in a collapsed *Technical details*.
- Keyboard-focusable scrollable `<pre>`, 24 px disclosure targets, 3-line clamp for the title in the alert node.

**Checked** (scratchpad scripts, not project dependencies)
- After: CLS 0.0001 (1 shift, the header pill); 16 requests per 10 s during a retry; idle 0 requests, 0 intervals;
  live-region mutations in 10 s of retry: session 3, result 2, announcer 3, poll status 1, lock 2, others 0.
- Screens at 320, 390, 768 and 1440 px in six states (first visit, validation error with a 500-character message
  and unbroken words, long alert confirmed, guide with an active retry, completed with technical details open,
  offline stale), plus *Service not ready* at load. No horizontal scroll, no overlapping journey labels, no button
  or summary under 24 px (radios sit inside full-card labels). 320 px also stands for 400% zoom of 1280 px.
  Screenshots were inspected by eye; the 768 px row layout led to the title clamp.
- axe-core (WCAG 2.0/2.1/2.2 A and AA tags): no violations in first visit, validation error, confirmed journey,
  guide with active retry, completed with technical details, offline stale. Contrast findings appeared only on
  `aria-hidden` motion labels mid-fade (excluded; they are about 13:1 at rest, and none appear with motion off).
- Announcements in a guided retry: "Delivery confirmed", "Try 1 did not get through. Retry scheduled", "Try 2 …",
  "Delivery confirmed" with no repeats; connection loss announced once; focus not moved by background work.
- Motion: default on; toggle off; OS reduce applied live and after reload over a stored "on"; no animations under
  OS reduce or explicit off while deliveries still complete; control usable again when the OS setting clears.
- `npm test` 171/171.
- Earlier browser suites, local: Stage 12 24/25 (the deliberate offline/401 console entries), 13 56/56, 14 41/41,
  15 50/50, 16 49/49, 17 46/46. They found two problems in my own changes, both fixed: a reloaded session briefly
  showed "Not started" while its alert loaded (Stage 14 check), and the moved result notice made the browser's
  scroll anchoring move a focused history card by 106 px (Stage 17 check; traced, then `overflow-anchor: none`
  on the composer). Stage 15 checks for "explicit Motion on overrides the system setting" were replaced by the
  Stage 18 rule; the Stage 14 empty-journey check now matches the uppercase node names case-insensitively.
