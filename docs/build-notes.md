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
