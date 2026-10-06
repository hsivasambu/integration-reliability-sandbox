# Postman walkthrough

This guide assumes you have never used Postman. It takes about 15 minutes, including the waiting.

Files (in the `postman/` folder of this repository):

| File | What it is |
|---|---|
| `integration-reliability-sandbox.postman_collection.json` | The requests, in learning order, with scripts that check each response and remember IDs |
| `integration-reliability-sandbox.postman_environment.json` | A template of variables (`base_url`, `session_token`, `event_id`, …). No token or secret is filled in |

The API reference is also served by the app itself at **`/docs/`** (for example
https://integration-reliability-sandbox.onrender.com/docs/), and the raw OpenAPI file is at `/openapi.yaml`.

## 1. Import both files

1. Open Postman (the desktop app or postman.com; a free account is enough).
2. Click **Import** (top left), then drag both JSON files into the window, or click **files** and pick them.
3. Click **Import**. You now have a collection called **Integration Reliability Sandbox** (left sidebar,
   **Collections**) and an environment with the same name (left sidebar, **Environments**).

## 2. Select the environment and set `base_url`

1. In the top-right corner there is an environment drop-down that says **No environment**. Choose
   **Integration Reliability Sandbox**.
   If you skip this, every request stops with *"base_url is empty. Select the … environment"*.
2. Open **Environments → Integration Reliability Sandbox** and set `base_url` (in the **Current value** column)
   to one of:
   - `http://localhost:3000` (the default) when running locally with `npm run dev` and the worker on
     (`WORKER_ENABLED=true` in `.env`, or `npm run dev:worker` in a second terminal)
   - `https://integration-reliability-sandbox.onrender.com` for the deployed demo

   Don't add a trailing `/`.
3. Click **Save** (Ctrl+S).

The other variables start empty. The scripts fill them in as you go:

| Variable | Filled by | Used for |
|---|---|---|
| `session_token`, `other_session_token` | the two *Create session* requests | the `Authorization: Bearer` header (type **secret**, so Postman masks it) |
| `idempotency_key` | each *Submit event* request (a new UUID) | the `Idempotency-Key` header; folder 4 deliberately reuses it |
| `event_id`, `delivery_id` | *Submit event*, and folder 6's polling | URLs such as `/v1/events/{{event_id}}/deliveries` |
| `replay_idempotency_key`, `replay_delivery_id` | *Replay the failed delivery* | folder 6 |
| `next_cursor` | *Your events, page 1* | pagination |
| `poll_interval_ms` (2000), `poll_max_tries` (20) | you, if you want | how long each *Poll* request waits first, and how often the runner repeats it |

Authorization is set once on the collection (**Bearer Token** = `{{session_token}}`), and every request inherits
it. Requests that must not send a token (health checks, session creation, the *No token* check) override it.

## 3. Send your first request

1. In the sidebar open **Integration Reliability Sandbox → 1. Health and readiness → Health (liveness)**.
2. Click **Send**.
3. The deployed demo sleeps after 15 minutes without traffic. If the first request takes up to a minute, that's
   the instance waking up, not a failure. Wait for it.

## 4. Read the response

The bottom half of the window is the response:

| Where | What to look at |
|---|---|
| Top right of the response: **Status** | `200 OK` here. Each request's name says which status to expect |
| **Body** tab | The JSON, for example `{"status":"ok","version":"0.12.0","build":"local","inProcessWorker":true}`. `inProcessWorker: true` means this server runs the delivery worker, which folders 3–7 need |
| **Headers** tab | `X-Request-Id` (matches the server's log line), `Location` (on 202), `Idempotent-Replayed` (on repeats), `Retry-After` (on 429) |
| **Test Results** tab | The checks the collection ran on this response. Green **PASS** = the API behaved as documented |
| **Console** (bottom-left of the window) | Short notes from the scripts, such as `event_id = …`. The token is never printed |

Then send **Readiness** (`200 {"status":"ready"}` means the database is reachable and migrated).

## 5. Start a session

Folder **2**: send **Create session**. Expect `201`. The token appears once in the body, and the script copies it
into the secret variable `session_token`. **Check session** should then return `200`.

The token is a 24-hour demo credential, not an account. Don't paste it into chats, screenshots or shared
workspaces.

## 6. Follow an event (folder 3)

1. **Set receiver mode: success**: your session's mock receiver will accept deliveries.
2. **Submit event**: expect **`202 Accepted`**. 202 means *stored and queued*, **not delivered**. Look at:
   - Body: `eventId`, `statusUrl`, and `event.delivery.state: "pending"`, `attemptCount: 0`
   - Headers: `Location` = the status URL
   - Console: the script saved `event_id` and `delivery_id`
3. **Poll status until delivered**: this calls the status URL `GET /v1/events/{{event_id}}/deliveries`.
   `delivery.state` moves `pending → in_progress → delivered`, and `delivery.attempts` lists every HTTP attempt
   with `responseStatus`, `durationMs`, and so on.
4. **Receiver view**: the receiver's side, `processed: true` and `duplicateCount: 0`.
5. **Get the event**: the event with a summary of its latest delivery.

## Waiting and polling: read this before folders 5–7

Delivery happens in a **background worker**, after the API has already answered. Postman doesn't know about
that work and never waits for it by itself. This collection waits in two explicit ways:

- **Every *Poll …* request pauses `poll_interval_ms` (2 s) before it is sent.** The spinner during that pause is
  normal.
- **When you click Send yourself**, a poll shows a test like *"Not finished yet (latest delivery:
  retry_scheduled, attempt 2 of 4, next attempt due …). By hand: click Send again."* Click **Send** again until the
  test says **Finished waiting for: …**. Only then go to the next request.
- **In the Collection Runner** (or Newman), an unfinished poll schedules itself again, up to `poll_max_tries`
  times (25 for the exhaustion poll), so the run moves on only after the work is done.

How long each wait is (deployment defaults: retries 2 s, 4 s and 8 s after each failure, 4 attempts):

| Folder | What you wait for | Typical wait |
|---|---|---|
| 3 | First attempt delivered | 1–3 s |
| 5 | Attempt 1 fails (503); then, after switching to success, the next retry | 1–3 s, then up to about 8 s |
| 5 | **Do the switch within about 14 s** of submitting. After that, the 4th and last attempt has failed too | |
| 6 | All 4 attempts fail (2 + 4 + 8 s of delays, plus polling) | about 15–20 s |
| 6 | The replay is delivered | 1–3 s |
| 7 | Attempt 1 times out (2 s), the retry follows 2 s later | about 5–7 s |

If the deployed instance was asleep, add up to a minute to the first request only.

## 7. The remaining folders

| Folder | What you'll see |
|---|---|
| **4. Identical submission and conflicting key reuse** | Same `Idempotency-Key` + same content (in a different field order) → **`200`** with header `Idempotent-Replayed: true` and the *original* `eventId`. Nothing new is stored. Same key + a different message → **`409 idempotency_key_conflict`** |
| **5. Temporary server error and recovery** | Receiver set to `server_error`; attempt 1 gets `503` (`retryable: true`), and the state is `retry_scheduled` with `nextAttemptAt`. Switch to `success`; the next retry is delivered. Several attempts, one processing |
| **6. Retry exhaustion and replay** | Four 503s → `failed` / `attempts_exhausted`. After switching to `success`: **Replay** → `202` with a new delivery (`replayOf` = the failed one, `attemptCount: 0`). The same replay key again → `200` + `Idempotent-Replayed`. A different key → `409 already_replayed`. Then the replay is delivered, and the original keeps its 4 failed attempts |
| **7. process_then_timeout** | The receiver processes the event, then answers too late. Attempt 1 is a `timeout` with **no** `responseStatus`, so the sender can't know it worked. It retries, and the receiver recognizes the event ID: `processed: true`, `duplicateCount: 1`, one confirmation code. The folder ends by setting the mode back to `success` |
| **8. Validation, expired credential, session isolation** | `422 validation_failed` listing every problem; `400 idempotency_key_required`; `400 invalid_query`; `401 missing_token`; `401 invalid_token`; a second session gets `404` for your event, receipt and delivery, and an empty list; pagination with `limit=2` and `cursor` |

About the "expired credential" check: the API gives expired and never-issued tokens exactly the same answer
(`401 invalid_token`), so nobody can probe which tokens once existed. The request uses a well-formed token that
was never issued, built by its script at run time. A real token only expires after 24 hours. The automated test
`expired token returns 401 invalid_token` covers that path.

## 8. Run everything at once (optional)

1. Right-click the collection → **Run collection** (or the **Runner** button).
2. Keep the order as shown, 1 iteration, and no delay needed (the poll requests wait by themselves).
3. Click **Run**. A full run takes about 40 seconds locally and a little longer against Render. It creates
   **2 sessions and 4 stored events** (the two invalid submissions in folder 8 are rejected and store nothing). The session-creation limit is 10 per IP per
   hour, so about 5 full runs per hour.

From a terminal, the same run with [Newman](https://www.npmjs.com/package/newman) (installed separately; not a
project dependency):

```sh
npx newman run postman/integration-reliability-sandbox.postman_collection.json \
  -e postman/integration-reliability-sandbox.postman_environment.json \
  --env-var base_url=http://localhost:3000
```

## Keeping tokens out of shared files

- Scripts write tokens and IDs as **current values**. Postman exports the **initial** values, which stay empty in
  the template, but some versions offer to include current values. **Don't export or share an environment after
  a run.** If you must, first clear `session_token` and `other_session_token` (Environment → **Reset all**).
- Don't add tokens to the collection's own variables or to request headers directly.
- The receiver secret and ops token live only in the server environment. Nothing in this collection needs them,
  and the internal routes are not included.

## When something goes wrong

| You see | Meaning |
|---|---|
| *"base_url is empty …"* | No environment selected (top right), or `base_url` has no current value |
| *Could not get any response* / `ECONNREFUSED` | Nothing is listening at `base_url` (local server not running, wrong port) |
| A poll never finishes, `state` stays `pending`, `attemptCount: 0` | No worker is running. `/health` shows `inProcessWorker: false`; start `npm run dev:worker` |
| `401 invalid_token` on everything | The session expired (24 h) or `session_token` is empty. Run folder 2 again |
| `429 rate_limited` on *Create session* | 10 sessions per IP per hour. Wait, or reuse your current session |
| `429 event_limit_reached` | 100 events per session. Create a new session (folder 2) |
| Folder 5 ends `failed` instead of `delivered` | The switch to `success` came after the 4th attempt (about 14 s). Run the folder again a bit faster |
