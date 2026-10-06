# Release checklist and rollback

Applies to the Blueprint-managed Render service `integration-reliability-sandbox` (free web instance, free
PostgreSQL, worker inside the web process, migrations at startup via `MIGRATE_ON_START=true`).

## Before pushing

- [ ] `npm test` passes locally with `TEST_DATABASE_URL` set (database tests are **skipped**, not failed, without it.
      Check the summary says `skipped 0`).
- [ ] `git status` shows no `.env`, logs or exported Postman environments.
- [ ] If `render.yaml` changed: pushing it makes Render create or modify resources. Read the diff, and don't push a
      paid plan without explicit approval (`deploy/render.continuous.yaml` is the paid variant and is **not** active).
- [ ] If a new migration is included: decide now whether it is **backward compatible** (see
      [Migrations and rollback](#migrations-are-forward-only)). Prefer additive changes.
- [ ] `version` in `package.json` and `info.version` in `docs/openapi.yaml` match (a test checks this).
- [ ] Frontend changed? `npm run test:browser` (fixture suite, needs an installed Edge or Chrome) passes, and
      `npm run test:live` passes against a local server with the worker on (see *Browser checks* below).

## Deployment smoke checklist

Run after Render shows the deploy as **Live**. Replace `BASE` with `https://integration-reliability-sandbox.onrender.com`.
On Windows PowerShell type `curl.exe`. The first request after idling can take about a minute (spin-up), and that's not a failure.

| # | Check | Expect |
|---|---|---|
| 1 | `curl -s BASE/health` | `200`, the **new** `version`, `build` = the first 12 characters of the pushed commit (`git rev-parse --short=12 HEAD`), `"inProcessWorker":true`. An old version or build means the deploy hasn't switched over yet (instances overlap for about a minute). A second deploy can follow when Blueprint env vars change. |
| 2 | `curl -s BASE/ready` | `200 {"status":"ready"}`. `503 migrations_pending` = a migration didn't apply; `database_unreachable` = check the database in the dashboard (free database expiry: about 2026-11-03). |
| 3 | Render **Logs** | `Applied migration …` or `Database schema is up to date`, then `listening` and `worker started`, with no `startup failed`. |
| 4 | `curl -sI BASE/` | `200` with `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Request-Id`. |
| 5 | `curl -s -o /dev/null -w "%{http_code}" BASE/docs/` and `BASE/openapi.yaml` | `200` and `200`. Open `/docs/` in a browser: the operations list renders. |
| 6 | `curl -s -X POST BASE/internal/receiver/deliveries` | `401 receiver_unauthorized` (internal route is protected). |
| 7 | `curl -s BASE/internal/ops/worker` | `401 ops_unauthorized`. The owner can repeat it with `-H "Authorization: Bearer <OPS_TOKEN from the dashboard>"` and expect `verdict` `idle` or `progressing`. |
| 8 | Postman: run the collection with `base_url` = BASE (or Newman, see `docs/postman-walkthrough.md`) | All assertions pass. This exercises sessions, delivery, idempotency, retry, exhaustion, replay, duplicate-safe processing, validation and isolation. It creates 2 sessions and 4 events. |
| 9 | Browser: open `BASE/`, start a session, run guided scenario 1 | Delivered after the switch, processed once. |

If 1–3 fail, the new version isn't serving. If 4–9 fail, it serves but misbehaves. Either way, see
[Rollback](#rollback).

## Frontend release checks (from 0.12.0)

The page and the API ship together in one service, so one deploy updates both. Each deploy has a **build**
identifier: `/health` reports it, and the server stamps the same value into the page (`<meta name="app-build">`,
and `?v=<build>` on the page's own script and stylesheet URLs). That separates two problems that look alike:

| Symptom | Cause | Check |
|---|---|---|
| The page shows *"This page was loaded before the service was updated. Reload the page…"* | A tab opened before a deploy (old page, new API) | Reload. Nothing is wrong with the service |
| `/health` shows the old `build` | The deploy hasn't switched over (or failed) | Render **Events**; wait about a minute; then logs |
| Page and `/health` builds match, but something misbehaves | A real problem in this build | Browser checks below; then [Rollback](#rollback) |

*Technical details → Service status* shows "Build: page X, service Y" for the person looking at the page.
Locally the build is `local` (set `BUILD_ID` to override).

### Browser checks

| # | Check | Expect |
|---|---|---|
| B1 | `curl -s BASE/ \| grep app-build` | `<meta name="app-build" content="<build>">`, the same build as `/health` |
| B2 | `BASE_URL=BASE npm run test:live` (from a machine with Edge or Chrome) | 8 pass, 2 skipped (quota and paused worker need their own server). Creates 2 demo sessions and about 8 synthetic alerts; runs in about 1.5 minutes after the service is awake |
| B3 | Open `BASE/` in a normal browser, press *Send alert* | Confirmed and processed within a few seconds; *Technical details → Service status* shows matching builds |
| B4 | On a phone or a 390 px window | The journey stacks vertically; nothing needs sideways scrolling |

`npm run test:browser` (fixtures) doesn't use the deployed service; it checks the page's own logic and runs before
pushing.

## Operational checklist (frontend)

- **After every deploy:** smoke checks 1–3, then B1–B3.
- **Free hosting:** the first visit after 15 idle minutes waits about a minute; the page shows "Waiting for the
  server." and doesn't fail. Retries that were due while asleep run when it wakes.
- **Demo sessions are limited** to 10 per hour per IP (`SESSION_RATE_LIMIT_MAX`). Repeated test runs from one
  machine can hit this; the page then explains it, and the limit resets within the hour.
- **Free database expiry (about 2026-11-03):** after it, `/ready` fails and the page shows *Service not ready*. See
  *Losing the database entirely*.
- **A visitor reports a stale or broken page:** compare the page build (Technical details) with `/health`. Different
  means reload; the same means a real problem in that build.
- **Nothing to clean up by hand:** expired sessions and their alerts are removed by the cleanup job.

## Rollback

There are **two different things to roll back**, and only one of them can be.

### Application rollback (code): reversible

Render keeps recent build artifacts (how many depends on the workspace plan).

1. Dashboard → service → **Events** / **Deploys** → pick the last good deploy → **Rollback** → confirm.
   Render starts a *new* deploy from that build, with **that deploy's environment variables**, start command and
   health check path.
2. **Rolling back from the dashboard disables auto-deploy** (Render's safeguard). While it's off, pushes to `main`
   do **not** deploy. After fixing the problem on `main`, re-enable **Auto-Deploy** in the service settings
   (or trigger a manual deploy).
3. Run smoke checks 1–3 and 8 again on the rolled-back version, and B1 and B3: `/health` must show the **old**
   build, and an open tab of the newer page shows the "loaded before the service was updated" notice until reloaded.
4. Alternative without the dashboard: `git revert <bad commit>` and push. That's a normal forward deploy, auto-deploy
   stays on, and the history shows what happened.

Database contents are **not** touched by an application rollback. Sessions, events and scheduled retries
carry on, and the rolled-back worker picks up whatever is due.

### Database migrations: forward-only, not rolled back

There are **no down migrations**. A Render rollback does **not** undo schema changes, and the free database has
**no backups**, so dropped data can't be restored. Two rules follow:

1. **An application rollback is only safe to a version whose code works with the current schema.** A migration
   that was applied stays applied.
2. **To undo a schema change, write a new forward migration** (`009_…sql`) that restores what's needed, test it on a
   copy (see below), and deploy it like any change. Never edit or delete an applied migration file, and never
   delete rows from `schema_migrations` to "re-run" one.

| Migration | Reversible? | Rolling the **app** back past it |
|---|---|---|
| 001–003 create tables | Structurally yes (drop), but dropping loses data | Not meaningful |
| 004 deliveries | **No**: drops `events.status` after moving state to `deliveries` | Code before 0.5.0 breaks (expects `events.status`) |
| 005 retry scheduling | **No** in practice: renames `available_at` → `next_attempt_at` | Code before 0.6.0 breaks |
| 006 receiver duplicates | **No**: folds and **drops** `receiver_receipts` | Code before 0.7.0 breaks |
| 007 replay | Partly: re-adding `UNIQUE(event_id)` would fail once replays exist | Code before 0.8.0 can misread events with several deliveries. Not supported |
| 008 operations | Additive (new table, widened CHECK) | 0.9.0 and 0.10.0 tolerate it. **0.10.0 was verified** (below); 0.9.0 was not |

**Stages 11–19 add no migration** (the frontend stages change only `public/`, tests and docs, plus the `build`
field on `/health` in 0.12.0), so rolling back from 0.12.0 to any 0.11.x build is an application-only rollback.
Rolling back from 0.11.0 to 0.10.0 is also application-only. That was
checked locally on 2026-10-05: 0.10.0 code (commit `caa3255`) started against the current schema, reported "Database
schema is up to date", `/ready` 200, and delivered a new event on attempt 1. The only visible difference is that
`/docs/` and `/openapi.yaml` return 404.

### If a migration fails during deploy

The app runs migrations before listening. Each migration file runs in one transaction under an advisory lock, so
a failing file is rolled back **completely**, the process exits (`startup failed`), and Render keeps the previous
version serving. Nothing to undo: fix the SQL in a **new** commit and push. (If the file was never applied
anywhere, it may be corrected in place, because it's not in `schema_migrations` yet.)

### Testing a migration on a copy first

Locally, with the Docker database:

```sh
docker exec reliabilitysandbox-db-1 psql -U sandbox -d sandbox -c "CREATE DATABASE sandbox_copy"
docker exec reliabilitysandbox-db-1 sh -c "pg_dump -U sandbox sandbox | psql -q -U sandbox -d sandbox_copy"
DATABASE_URL=postgres://sandbox:<local password>@127.0.0.1:5433/sandbox_copy npm run migrate
docker exec reliabilitysandbox-db-1 psql -U sandbox -d sandbox -c "DROP DATABASE sandbox_copy"
```

The Render database only accepts connections from Render's private network, so a production copy can't be
made from a laptop with this setup. Test against local data that has the same shape (see the Stage 11 build
notes for the staged-upgrade check).

### Losing the database entirely

If the free database expires or is deleted: create a new one (or let the Blueprint recreate it) and redeploy.
Migrations rebuild the empty schema at startup. All sessions, events and history are gone; visitors simply
start new sessions.
