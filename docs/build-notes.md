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
