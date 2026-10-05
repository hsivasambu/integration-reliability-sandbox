# Integration Reliability Sandbox

A learning sandbox that will accept synthetic JSON events, persist them, and deliver them
reliably to a controlled mock receiver.
**Current stage: 5. Background worker makes one delivery attempt per event (no automatic retries yet).**

## Requirements

- Node.js 24 LTS (22.9+ also works locally). Render uses `.node-version`.
- Docker Desktop (runs the local PostgreSQL 18 database)

## Local setup

```sh
npm ci                  # install exact versions from package-lock.json
cp .env.example .env    # then replace the placeholder password (3 places) and RECEIVER_SECRET
npm run db:up           # start local Postgres (port 5433) and wait until healthy
npm run dev:migrate     # apply database migrations
npm run dev             # start the app with .env loaded
npm run dev:worker      # optional second terminal: standalone delivery worker (if WORKER_ENABLED=false)
npm test                # all tests (database tests need TEST_DATABASE_URL)
```

Open http://localhost:3000 and click **Check health**.

`npm run db:down` stops the database and keeps its data. To delete local data completely:
`docker compose down -v`. That's the only destructive command, and nothing runs it automatically.

### Configuration

The server refuses to start, and lists every problem, if required settings are missing or invalid.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | **required** | PostgreSQL connection string |
| `PORT` | `3000` (Render sets `10000`) | Port to listen on |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` locally. Hosting needs `0.0.0.0`. |
| `MIGRATE_ON_START` | `false` | `true` applies pending migrations before the server listens |
| `SESSION_TTL_HOURS` | `24` | Demo session lifetime (1–168) |
| `SESSION_RATE_LIMIT_MAX` / `_WINDOW_MINUTES` | `10` / `60` | Session creations allowed per client IP per window |
| `MAX_ACTIVE_SESSIONS` | `1000` | Cap on unexpired sessions across all clients |
| `MAX_EVENTS_PER_SESSION` | `100` | Events one session may create (1–10000) |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app (`1` on Render) |
| `RECEIVER_SECRET` | **required** | Server-side secret for internal receiver calls (32+ characters, no spaces) |
| `RECEIVER_URL` | `http://127.0.0.1:$PORT/internal/receiver/deliveries` | Fixed delivery destination (server config only) |
| `DELIVERY_TIMEOUT_MS` | `2000` | How long the delivery client waits for an answer |
| `RECEIVER_SLOW_RESPONSE_MS` | `4000` | Delay used by `timeout` mode. Must exceed `DELIVERY_TIMEOUT_MS`. |
| `WORKER_ENABLED` | `false` | `true` runs the delivery worker inside the web process (`true` on Render) |
| `WORKER_POLL_INTERVAL_MS` | `1000` | How often an idle worker checks for due deliveries |
| `DELIVERY_LEASE_MS` | `15000` | How long a claim lasts before another worker may take over. At least `DELIVERY_TIMEOUT_MS` + 1000. |
| `DELIVERY_MAX_ATTEMPTS` | `3` | Cap on claims per delivery (currently only reached through lease recovery) |
| `TEST_DATABASE_URL` | unset | Test database. Its name must end in `_test` because tests wipe it. |

## Database migrations

SQL files in `migrations/` (`001_...sql`, `002_...sql`, …) are applied in order. Each runs once inside
a transaction and is recorded in the `schema_migrations` table, so running the command again is
harmless and existing data is never reset. A database lock stops two instances from migrating at once.
Applied migration files are never edited. Changes go in a new numbered file.

| Where | Command |
|---|---|
| Local | `npm run dev:migrate` (reads `.env`) |
| Anywhere with `DATABASE_URL` set | `npm run migrate` |
| Render free instance | Runs automatically at startup (`MIGRATE_ON_START=true`), because free instances have no pre-deploy step |
| Render paid instance | Set **Pre-Deploy Command** to `npm run migrate` and remove `MIGRATE_ON_START` |

Migrations must run somewhere that can reach the database. On Render, that means **on Render**: the
database only accepts connections from Render's private network (`ipAllowList: []`).

## Routes

| Method & path | Response |
|---|---|
| `GET /health` | `200 {"status":"ok","version":"0.5.0","inProcessWorker":true|false}` while the process runs (no database check) |
| `HEAD /health` | `200`, headers only |
| `GET /ready` | `200 {"status":"ready"}` if the database is reachable and migrated, otherwise `503` with `reason` |
| `POST /v1/sessions` | `201` with a new demo token (shown once), `429` if rate limited, `503` at capacity |
| `GET /v1/session` | `200 {"createdAt","expiresAt"}` with a valid token, otherwise `401` |
| `POST /v1/events` | `202` accepted for asynchronous delivery (`eventId`, `statusUrl`); `200` identical repeat; `409` key reused with different payload; see [Events](#events) |
| `GET /v1/events?limit=&cursor=` | `200 {"data":[...],"nextCursor"}`: your session's events, newest first |
| `GET /v1/events/{id}` | `200 {"event"}` (including a `delivery` summary) if it belongs to your session, otherwise `404` |
| `GET /v1/events/{id}/deliveries` | `200` delivery state and attempt history for your session's event, otherwise `404` |
| `GET /v1/receiver` | `200 {"mode","availableModes","receivedCount",...}`: your session's mock receiver settings |
| `PUT /v1/receiver` | Body `{"mode":"success"|"server_error"|"timeout"}`, which changes **your session's** mode |
| `POST /internal/receiver/deliveries` | Mock receiver. Requires `Authorization: Bearer <RECEIVER_SECRET>`; `401` otherwise. Server-side callers only. |
| Wrong method on any route above | `405` with an `Allow` header |
| `GET /` | Landing page |
| Anything else | `404 {"error":"not_found",...}` |

API request bodies over 4 KB get `413`, and malformed JSON gets `400`.

Every error uses one shape: `{"error": "<code>", "message": "<explanation>"}`, plus `details` for
validation errors. Programs should branch on `error`; `message` is for people.

## Demo sessions

`POST /v1/sessions` returns a random bearer token such as `irs_...` (47 characters). **This token is a
limited demo credential, not a user account.** There is no username, password, or recovery. It only
scopes your own sandbox data (from later stages) and expires after 24 hours. The server stores only a
SHA-256 hash of it, so the token can't be shown again. Lose it and you simply create a new session.
Tokens are never logged.

### Try it with curl

PowerShell (keeps the token in a variable instead of on screen):

```powershell
$BASE = "http://localhost:3000"
$TOKEN = (curl.exe -s -X POST "$BASE/v1/sessions" | ConvertFrom-Json).token
curl.exe -i -H "Authorization: Bearer $TOKEN" "$BASE/v1/session"   # expect 200
curl.exe -i "$BASE/v1/session"                                     # expect 401 missing_token
curl.exe -i -H "Authorization: Bearer wrong" "$BASE/v1/session"    # expect 401 invalid_token
Remove-Variable TOKEN
```

Bash:

```sh
BASE=http://localhost:3000
TOKEN=$(curl -s -X POST "$BASE/v1/sessions" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -i -H "Authorization: Bearer $TOKEN" "$BASE/v1/session"
unset TOKEN
```

### Try it with Postman

1. Create an environment with a variable `demoToken` and set its type to **secret**.
2. `POST {{base}}/v1/sessions`. In the request's **Scripts → Post-response** tab add:
   `pm.environment.set("demoToken", pm.response.json().token);`
3. `GET {{base}}/v1/session` with **Authorization → Bearer Token** = `{{demoToken}}`.

Don't paste real tokens into shared collections, screenshots, or docs.

## Events

One event type, `demo.notification`. Request body (no other fields allowed, anywhere):

```json
{ "type": "demo.notification",
  "payload": { "title": "Synthetic title", "message": "Synthetic message" } }
```

| Field | Rule |
|---|---|
| `type` | Required, exactly `demo.notification` |
| `payload.title` | Required string, 1–100 characters, not blank, no control characters |
| `payload.message` | Required string, 1–500 characters, not blank, line breaks allowed, no other control characters |
| `Idempotency-Key` header | Required, 1–100 of `A-Z a-z 0-9 . _ : -` (a UUID works well) |

Invalid input returns `422 validation_failed` with every problem in `details`, and nothing is stored.

**202 means accepted, not delivered.** *(Changed in Stage 5; it was `201` in Stage 3.)* The event and its
delivery job are saved in one database transaction, and the response returns immediately:

```json
{ "eventId": "...", "statusUrl": "/v1/events/.../deliveries",
  "event": { "id": "...", "type": "demo.notification", "payload": { "...": "..." }, "idempotencyKey": "...",
             "createdAt": "...", "updatedAt": "...",
             "delivery": { "state": "pending", "attemptCount": 0, "statusUrl": "..." } },
  "notice": "Accepted: stored durably and queued for asynchronous delivery..." }
```

The `Location` header is the status URL. The event no longer has a `status` field. Delivery state lives
only in `event.delivery` and at `statusUrl`.

### Idempotency: safe retries

The client chooses an `Idempotency-Key` per logical event and reuses it on every retry of that event.

| Request | Response |
|---|---|
| New key | `202 Accepted` + `Location` (status URL), a new event and delivery job |
| Same key, same payload (field order doesn't matter) | `200 OK` + `Idempotent-Replayed: true`, the **original** event with its **current** delivery state; nothing new stored, nothing re-sent |
| Same key, different payload | `409 idempotency_key_conflict`, nothing stored |
| Same key in a different session | Independent. Keys are scoped to the session. |

Keys are remembered for the life of the session. The guarantee comes from a PostgreSQL unique
constraint on `(session_id, idempotency_key)`, so it holds even for simultaneous requests and across
restarts or multiple app instances. Once a session hits `MAX_EVENTS_PER_SESSION`, new keys get
`429 event_limit_reached`, but repeats of existing keys still return the original event.

### Try it (PowerShell)

```powershell
$BASE = "http://localhost:3000"
$TOKEN = (curl.exe -s -X POST "$BASE/v1/sessions" | ConvertFrom-Json).token
$KEY = [guid]::NewGuid().ToString()
'{"type":"demo.notification","payload":{"title":"Synthetic title","message":"Synthetic message"}}' | Out-File -Encoding ascii event.json
curl.exe -i -X POST "$BASE/v1/events" -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" --data-binary "@event.json"   # 202
curl.exe -i -X POST "$BASE/v1/events" -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" --data-binary "@event.json"   # 200, Idempotent-Replayed: true
curl.exe -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/events?limit=5"                                                                                              # your events
Remove-Item event.json; Remove-Variable TOKEN
```

The landing page has the same flow: **Start demo session**, **Submit event**, **Send same request again**, and **Refresh list**.

## Delivery worker

A background worker takes each accepted event and makes **one** HTTP attempt to the mock receiver. If
it fails, the delivery stays failed; automatic retries come in a later stage.

**Where it runs.** On Render, inside the web process (`WORKER_ENABLED=true`), so there's no extra hosted
service. Locally, either set `WORKER_ENABLED=true` or run `npm run dev:worker` (`src/worker-main.js`) next
to `npm run dev`. Several workers can run at once safely.

**How it works.** The code lives in three modules: `src/events.js` (API), `src/worker.js` (loop) +
`src/delivery-store.js` (SQL), and `src/delivery-client.js` (HTTP).

1. **Poll.** Every `WORKER_POLL_INTERVAL_MS` (1 s), or immediately after finishing a job.
2. **Recover.** Any delivery whose lease has expired goes back to `pending`, and its unfinished attempt is
   labelled `lease_expired` (result unknown). After `DELIVERY_MAX_ATTEMPTS` claims it fails instead.
3. **Claim.** One SQL statement picks the oldest due `pending` delivery (`FOR UPDATE SKIP LOCKED`, so
   competing workers never pick the same one), sets it `in_progress` with a fresh random `claim_token` and
   a lease of `DELIVERY_LEASE_MS` (15 s), and inserts the attempt row. **The attempt is recorded before anything is sent.**
4. **Send.** A plain HTTP request with a 2 s timeout. No database transaction is open during the request.
5. **Complete.** One SQL statement records the outcome. It only applies `WHERE claim_token = <mine>`, so a
   worker that lost its lease can't overwrite a newer claim's result.
6. **Stop.** On `SIGTERM`, the worker stops claiming, lets the in-flight attempt finish and record its
   result (at most 2 s), and then the process exits.

| Delivery `state` | Meaning |
|---|---|
| `pending` | Waiting for a worker |
| `in_progress` | Claimed; an attempt is under way |
| `delivered` | The receiver answered 2xx (delivered **at the HTTP level**) |
| `failed` | The attempt got a non-2xx, timed out, or couldn't connect (no retries yet) |

Each attempt records `attemptNumber`, `outcome` (`in_progress`, `delivered`, `failed`, `lease_expired`),
`startedAt`, `endedAt`, `responseStatus` (when a response arrived), `errorCategory` (`http_error`, `timeout`,
`network_error`, `lease_expired`), and `durationMs`. See them at `GET /v1/events/{id}/deliveries`.

**At-least-once, not exactly-once.** If a worker crashes *after* the receiver processed a delivery but
*before* it recorded the result, the lease expires and another worker sends it again. The receiver then
sees the event twice. No sender can rule this out, because the confirmation can be lost after the work is
done. Duplicate handling on the receiving side comes in a later stage.

**Worker disabled vs enabled** (`/health` shows `"inProcessWorker"`):

| | `WORKER_ENABLED=false` (and no `dev:worker`) | `WORKER_ENABLED=true` |
|---|---|---|
| `POST /v1/events` | `202`, delivery `pending` | `202`, delivery `pending` |
| A few seconds later | Still `pending`, no attempts | `delivered` / `failed`, with one attempt |
| Start `npm run dev:worker` | Pending work is picked up and delivered | (also fine; workers share safely) |

On Render's free plan the instance sleeps after 15 minutes without inbound traffic, and the worker sleeps
with it. Pending deliveries wait in Postgres until the next request wakes the service. The worker's own
loopback calls don't count as inbound traffic.

## Mock receiver

A stand-in for the external system that events are delivered to. The delivery worker calls it. It
lives at `POST /internal/receiver/deliveries` in the same app.

**Who can call it.** Only server-side code holding `RECEIVER_SECRET`. The secret exists only in server
environment variables. It's never sent to browsers, logged, or committed. The caller's destination is
fixed by `RECEIVER_URL` (by default the app's own loopback address), redirects are refused, and
visitors can never supply a URL. Request bodies are limited to 4 KB, and unknown fields get `422`.

**Modes, per demo session** (stored in PostgreSQL table `receiver_settings`; default `success`):

| Mode | Receiver behaviour | What the delivery client reports |
|---|---|---|
| `success` | Records a receipt, answers `200` immediately | `delivered`, HTTP 200 |
| `server_error` | Answers `503` + `Retry-After: 1` immediately, records nothing | `http_error`, HTTP 503 |
| `timeout` | Waits 4 s (asynchronously), then answers `503 simulated_slow_response`, records nothing | `timeout` after 2 s, no HTTP status |

Set the mode with `PUT /v1/receiver` (your session token) or the **Mock receiver mode** panel on the
landing page. One visitor's mode never affects another's.

**503 vs timeout.** A **503** is an answer: the receiver says "I'm unavailable right now", quickly and
unambiguously, and the caller knows nothing was processed. A **timeout** is the *absence* of an answer
within the caller's limit. The caller can't tell whether the request was lost, is still being worked on,
or was processed but the reply got lost. That uncertainty is why retries need idempotency.

**If the caller gives up**, the receiver notices the closed connection, cancels its pending timer, and
never writes a late response. No timers or errors are left behind. The wait uses an async timer, so
`/health` and other requests keep being served while a slow response is pending.

### Try it locally

```sh
npm run dev                 # terminal 1
npm run receiver:try        # terminal 2: one real HTTP delivery per mode
npm run receiver:try -- timeout
```

Expected (timings vary):

```
success       -> delivered     HTTP 200     25 ms  received
server_error  -> http_error    HTTP 503     21 ms  simulated_server_error
timeout       -> timeout       HTTP -     2007 ms  no response within 2000 ms

Receipts recorded by the receiver: 1 (only 'success' processes deliveries)
```

The script creates a throwaway session directly in the database, so it needs `DATABASE_URL` and
`RECEIVER_SECRET` from `.env` and the app running on `PORT`. It can't run against Render: there's no
shell on free instances, and the database is private. That's intended, because only server-side code may
call the receiver.

## Checks (replace BASE with `http://localhost:3000` or your Render URL)

```sh
curl -i  BASE/health            # expect HTTP 200 and JSON body
curl -I  BASE/health            # expect HTTP 200, headers only
curl -i  BASE/ready             # expect HTTP 200 {"status":"ready"}
curl -i -X POST BASE/health     # expect HTTP 405, Allow: GET, HEAD
curl -i  BASE/nope              # expect HTTP 404 JSON
```

On Windows PowerShell, type `curl.exe` instead of `curl` (`curl` is an alias for `Invoke-WebRequest`).

### Telling failures apart

| Symptom | Meaning |
|---|---|
| `404` + `{"error":"not_found"}` | Server is up; the **path** is wrong |
| `405` + `Allow` header | Server is up, path exists; the **HTTP method** is wrong |
| `/health` 200 but `/ready` 503 | App is running, **database** is unreachable or not migrated (see `reason`) |
| `401 missing_token` / `invalid_token` | No `Authorization: Bearer` header / token unknown, malformed, or expired |
| `404` on `/v1/events/{id}` | No such event **for your session**. Other sessions' events look identical to missing ones. |
| `409 idempotency_key_conflict` | You reused an Idempotency-Key for a different event. Generate a new key. |
| `401 receiver_unauthorized` | Call to `/internal/receiver/...` without the server-side secret. Expected for any browser or visitor. |
| curl `Failed to connect` / exit code 7, browser "can't be reached" | **Nothing is listening** (server not running, wrong port/host) |
| curl exit 6 `Could not resolve host` | Wrong hostname / typo in URL |
| Render `502`/`503` or HTML "service waking up" page | Render can't reach a healthy app (crashed, still starting, or free instance spinning up) |
| Browser Network tab shows `(blocked:other)` or `(blocked:client)` | The browser, an extension, or security software blocked the request. It never reached the server. |

## Deploying to Render

`render.yaml` defines the web service and a free Render Postgres database. It wires the database's
**internal** connection string into `DATABASE_URL`, so no secret is typed or committed.

**Blueprint-managed service (recommended).** Push to `main`. Render syncs the Blueprint, creates
`integration-reliability-sandbox-db`, sets the env vars, and redeploys. At startup the app applies migrations,
then listens. Check `/health` and `/ready` once the deploy shows **Live**.

**Service created by hand** (the Blueprint isn't connected):
1. **New → Postgres**: name `integration-reliability-sandbox-db`, PostgreSQL 18, region **Oregon** (same as the
   web service), plan **Free**.
2. Copy its **Internal Database URL**.
3. Web service → **Environment**: add `DATABASE_URL` (paste the URL; Render keeps it secret),
   `MIGRATE_ON_START=true`, `TRUST_PROXY=1`, and `RECEIVER_SECRET` (click **Generate**, or paste a
   32+ character random value). Save, and Render redeploys.

| Setting | Value | Why |
|---|---|---|
| Build Command | `npm ci` | Clean install pinned to `package-lock.json` |
| Start Command | `npm start` | Runs `node src/server.js` (which migrates first when `MIGRATE_ON_START=true`) |
| Health Check Path | `/health` | Liveness only. Render restarts instances that fail it, and a database blip shouldn't trigger restarts. Use `/ready` for monitoring and post-deploy checks. |
| `DATABASE_URL` | Internal URL from the Render database | Private network, no public exposure |
| `MIGRATE_ON_START` | `true` | Free instances can't run a pre-deploy command |
| `TRUST_PROXY` | `1` | So rate limiting sees the client IP, not Render's proxy |
| `PORT` | *don't set* | Render provides it |

If migrations fail at startup, the process exits with `Startup failed: Migration ... failed: ...` in the
Render logs. The deploy never goes live, and the previous version keeps serving.

### Free plan limits

- **Web service:** spins down after **15 minutes with no inbound traffic**. The next request waits **about
  one minute**, and health checks don't keep it awake. 750 free instance-hours per workspace per month.
- **Postgres (free):** expires **30 days after creation** (14-day grace period to upgrade before deletion),
  1 GB storage, **no backups**, one free database per workspace, and it may restart for maintenance.

### What survives a restart or redeploy

The web service's filesystem is temporary. It's replaced on every deploy, restart, and spin-down. All
durable state lives in Postgres, which is a separate service, so sessions and migration history
**survive** restarts, redeploys, and spin-downs. Rate-limit counters live in memory and reset on each restart. Events, idempotency keys, delivery
jobs, and attempt history are in Postgres and survive. A worker killed mid-attempt leaves a lease that
expires, and the delivery is then picked up again. When an expired session is cleaned up, its events are deleted with it.
Deleting the database (or letting the free one expire) loses everything.
