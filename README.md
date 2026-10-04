# Integration Reliability Sandbox

A learning sandbox that will accept synthetic JSON events, persist them, and deliver them
reliably to a controlled mock receiver. **Current stage: 1. A deployable service with a health check.**

## Requirements

- Node.js 24 LTS (22.9+ also works locally). Render uses `.node-version`.
- npm (ships with Node)

## Local setup

```sh
npm ci                     # install exact versions from package-lock.json
cp .env.example .env       # optional; sets PORT=3000, HOST=127.0.0.1
npm run dev                # starts with .env loaded
# or: npm start            # no .env; defaults PORT=3000, HOST=0.0.0.0
npm test                   # smoke tests
```

Open http://localhost:3000 and click **Check health**.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` (Render sets `10000`) | Port to listen on |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` locally. Hosting needs `0.0.0.0`. |
| `NODE_ENV` | unset | Set to `production` on Render |

## Routes

| Method & path | Response |
|---|---|
| `GET /health` | `200 {"status":"ok","version":"0.1.0"}` |
| `HEAD /health` | `200`, headers only, no body |
| Other methods on `/health` | `405` with `Allow: GET, HEAD` |
| `GET /` | Landing page |
| Anything else | `404 {"error":"not_found",...}` |

## Checks (replace BASE with `http://localhost:3000` or your Render URL)

```sh
curl -i  BASE/health            # expect HTTP 200 and JSON body
curl -I  BASE/health            # expect HTTP 200, headers only
curl -i -X POST BASE/health     # expect HTTP 405, Allow: GET, HEAD
curl -i  BASE/nope              # expect HTTP 404 JSON
curl -s -o /dev/null -w "%{http_code}\n" BASE/   # expect 200
```

On Windows PowerShell, type `curl.exe` instead of `curl` (`curl` is an alias for `Invoke-WebRequest`).

### Telling failures apart

| Symptom | Meaning |
|---|---|
| `404` + `{"error":"not_found"}` | Server is up; the **path** is wrong |
| `405` + `Allow` header | Server is up, path exists; the **HTTP method** is wrong |
| curl `Failed to connect` / exit code 7, browser "can't be reached" | **Nothing is listening** (server not running, wrong port/host) |
| curl exit 6 `Could not resolve host` | Wrong hostname / typo in URL |
| Render `502`/`503` or HTML "service waking up" page | Render can reach its proxy but not a healthy app (crashed, still starting, or free instance spinning up) |
| `404` with a non-JSON body on Render | Request didn't reach this app (e.g. wrong service URL) |

## Deploying to Render

Prerequisite: the code is in a GitHub/GitLab/Bitbucket repository that Render can access.

**Option A: Blueprint (uses `render.yaml`)**
1. Render Dashboard → **New** → **Blueprint**.
2. Pick the repository and branch `main`. Render reads `render.yaml`.
3. Confirm the free web service `integration-reliability-sandbox` and click **Apply**.

**Option B: manual Web Service** (same settings by hand)

| Setting | Value | Why |
|---|---|---|
| Language/Runtime | Node | Native Node runtime, no Docker needed |
| Branch | `main` | Pushes to this branch trigger deploys |
| Build Command | `npm ci` | Clean install pinned to `package-lock.json` |
| Start Command | `npm start` | Runs `node src/server.js` |
| Instance Type | Free | No cost; see cold starts below |
| Health Check Path | `/health` | Render GETs it; 2xx/3xx within 5 s = healthy. New deploys get traffic only after passing. |
| Env var `NODE_ENV` | `production` | Standard production mode for Express |
| Env var `PORT` | *don't set* | Render provides it (10000); the app reads it |
| Env var `NODE_VERSION` | *optional* | Overrides `.node-version` if set |

No secrets are needed for this stage.

### Free plan cold starts

Free web services spin down after **15 minutes with no inbound traffic**. The next request waits
**about one minute** while the service starts, and the browser may show a Render loading page. Health checks
do not keep it awake. The workspace gets 750 free instance-hours per month. The filesystem is
temporary and is wiped on each restart or deploy. For no spin-down, choose a paid instance type (costs money).
