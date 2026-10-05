# Frontend notes: Follow an Alert

The visitor-facing page in `public/` (`index.html`, `app.css`, `app.js`). Plain HTML/CSS/JS with inline SVG
icons; no framework, no build step, no runtime dependency. It's served by the same Express app, under the
same strict CSP (`script-src 'self'`, `style-src 'self'`, no inline code).

## Rules the page follows

- **The API is the only source of truth.** Delivery state, retries and processing come from
  `GET /v1/events`, `GET /v1/events/{id}/deliveries` and `GET /v1/receiver/receipts/{id}`. The browser never
  schedules retries, never decides a delivery outcome, and never re-submits or replays on its own.
- **Safe rendering.** All content is built with `document.createElement` / text nodes (`h()` and `icon()` in
  `app.js`). No `innerHTML`, and server text is never treated as markup.
- **Tokens stay hidden.** The demo token lives in `sessionStorage` only. It's never shown, put in a URL, logged, or
  included in the technical view.
- **Plain language first.** Status codes, IDs, idempotency keys and raw JSON appear only in collapsible
  *Technical* areas.
- **Words and icons carry meaning, and colour only reinforces it.**

## Layout (Stage 12)

1. Header: *Follow an Alert*, **Demo** label, service pill, *Technical details* link (to `#technical`).
2. One-line introduction.
3. Workspace: composer (left) and the navy alert journey (right) with *Recent alerts* under it. Two columns
   from 60rem. On phones the composer comes first, and the three journey steps stack vertically (a CSS
   container query switches them to a row when the journey panel is at least 46rem wide).
4. Three experiment cards.
5. Technical details: service check with versions, session summary, token storage note, API docs links.

## Composer (Stage 13)

- **Sample alerts.** Three selectable cards (Service request, Equipment notification, Team update). Each one fills
  the editable title and message. Every sample uses the API's only type, `demo.notification`, and its only fields,
  `title` and `message`. No urgency, recipients or routing are implied, because none exist. The first sample is
  selected by default, so a visitor can send without typing. Choosing a sample never changes the receiver.
- **Limits** match the server: title 1–100 and message 1–500 *Unicode characters*, not blank, no control
  characters (line breaks allowed in the message). There's no `maxlength`, because the browser counts UTF-16 units
  and would cut emoji short. A live counter turns red instead, and validation blocks the send.
- **Preview.** A small message card, built with text nodes only.
- **View request JSON** (collapsed). It shows the method, path, headers (the token is shown only as a placeholder)
  and body. While an alert is unconfirmed, it shows that request instead of the draft.
- **One primary action, *Send alert*.** If there's no session, this click starts one. Sessions are never created
  any other way, and never automatically after a 401 or a quota error.
- **The draft** (`irs.draft`) is kept in `sessionStorage` and restored on reload.

### Sending and the unconfirmed state

1. *Send alert* validates first, then disables itself **before** anything is awaited, so double clicks or Enter
   can't send twice.
2. It creates a **new** Idempotency-Key and saves `{ key, body, status: 'sending' }` to `sessionStorage`
   (`irs.pendingSubmit`) **before** the POST.
3. Then it handles the answer:
   - **202/200** → accepted. The alert from the response is shown in the journey at once, with "Delivery may
     still be pending". The saved submission is cleared.
   - **A 4xx answer** → settled (nothing was stored). Validation details go to the fields. On 401 the session has
     ended: the page explains that nothing was saved, and a new session starts only on the next click.
     `event_limit_reached` offers *Start a fresh session* as a button.
   - **Timeout, network failure, or a 5xx** → *uncertain*: "We could not confirm whether your alert was
     accepted." *Check again* repeats the **same key and the same payload**. The API then answers 200 if the first
     request arrived, or 202 if it didn't, so there is one alert either way.
4. While an alert is uncertain:
   - *Send alert* is paused, with the reason shown.
   - The draft can still be edited, and it's kept separately from the unconfirmed submission.
   - *Stop checking* forgets the submission and explains that an accepted alert would still appear in Recent
     alerts.
   - *Start fresh session* is disabled, because Idempotency-Keys are scoped to a session.
5. A reload during sending or uncertainty brings back the uncertain state. **Nothing is resent automatically.**
6. A routine refresh can confirm the alert by *reading*: if `GET /v1/events` lists an alert with the saved key, it
   was accepted. Not finding it proves nothing, so that never resolves the state.
7. If the session ends while an alert is unconfirmed, the submission is dropped with an explanation, because it
   can no longer be checked.

The receiver mode is shown as one line ("Test receiver: Works normally"). The four mode choices moved under the
experiments, into *Set the test receiver yourself*, until the experiment controls are redesigned (Stage 16).

## Visual tokens (`:root` in `app.css`)

| Group | Tokens |
|---|---|
| Surfaces | `--paper` warm off-white page, `--surface` cards, `--surface-sunk` inputs, `--line`, `--line-strong` |
| Text | `--ink` dark navy, `--ink-soft` secondary |
| Journey canvas | `--navy`, `--navy-raised`, `--navy-line`, `--on-navy`, `--on-navy-soft` |
| Roles | `--teal` (primary action), `--amber` (waiting), `--red` (failure), each with a `-tint` for light surfaces and an `-on-navy` variant |
| Type | `--font-display` (system serif: Iowan Old Style / Palatino / Georgia), `--font-body` (system UI), `--font-mono`, `--text-xs` … `--text-2xl` |
| Space, shape, depth | `--space-1` … `--space-7`, `--radius-sm/md/lg/pill`, `--shadow-card`, `--shadow-journey` |
| Focus | `--focus-color` (navy ring on light surfaces, light ring inside the journey), `--focus-ring`, `--focus-offset` |
| Motion | `--motion-fast`, `--motion-base`, `--ease`. Nothing animates yet; a global `prefers-reduced-motion` rule is already in place |

State treatments are classes that set `--state-ink`, `--state-tint` and `--state-on-navy`:
`is-done`, `is-active`, `is-waiting`, `is-failed`, `is-idle`, `is-unknown`.

No web fonts and no background texture. The plain paper colour reads better than a texture at small sizes.
There is no dark theme (the earlier UI followed the system setting); the specified palette is light, with a
navy journey canvas.

## Which API fields drive which words

| UI label | API source |
|---|---|
| Waiting to send | `delivery.state = pending`, `attemptCount = 0` |
| Waiting to send again | `pending`, `attemptCount > 0` (a worker lost its lease) |
| Sending | `in_progress` (try *n* of `maxAttempts`) |
| Trying again (next try in about *N* s) | `retry_scheduled`, `nextAttemptAt` |
| Delivery confirmed | `delivered`: the receiver acknowledged with 2xx |
| Delivery stopped | `failed`; the reason comes from `failureReason` (`attempts_exhausted`, `non_retryable`, `session_expired`) |
| Try *n*: receiver reported a problem / no reply in time / could not reach the receiver / result unknown | attempt `outcome`, `errorCategory`, `retryable` |
| Receiver processed alert (confirmation, repeats recognized) | receipt `processed`, `result.confirmationCode`, `deliveriesReceived`, `duplicateCount` |
| Not processed yet / Not processed / No processing recorded | receipt `processed = false` combined with the latest delivery state |
| Service ready / Service not ready / Can't reach service | `/health` + `/ready`; a successful refresh also counts as reachable |
| You are offline | Only when the browser reports no connection (`navigator.onLine === false`). Never used for a receiver mode |

*Delivery confirmed* and *Receiver processed alert* are separate steps on purpose. Acknowledgement is what the
sender observed, and processing is what the receiver recorded. With `process_then_timeout` the receiver processes
the alert before the sender sees any reply.

## Known gaps (data the API doesn't provide)

- **The receiver mode is per session, not per alert.** Changing it affects every waiting retry in the session, and
  attempts don't record which mode was active. The page says so next to the mode choice.
- **Attempts store only `responseStatus` / `errorCategory`, not the receiver's error code**, so the page says
  "receiver reported a problem" rather than naming the simulated outage.
- **There's no public worker liveness.** "Service ready" means the API and database answer, not that deliveries are
  moving.
- **No alert fields beyond `title` and `message`.** There's no severity or priority, and the page doesn't invent
  any.

## Refresh and recovery behaviour (unchanged from Stage 9)

Single-flight polling every 2 s while any delivery is active. It pauses when the tab is hidden and refreshes on
return, and it backs off up to 30 s on errors with *Retry now*. A slow request (> 4 s) shows the "waking up" banner;
a request fails only after 90 s or with no API answer. Late answers for an alert that's no longer selected are
ignored. On reload, the session and the selected alert are restored from `sessionStorage`.

A submission without an answer keeps its Idempotency-Key, so pressing *Send alert* again can't create a second
alert. Replay keys are kept per delivery until answered. A 401 clears the token and offers a new session, but
never creates one automatically.

## Checking the page

- `npm test` includes `test/ui.test.js`: CSP, no inline script/handlers/styles, safe DOM APIs, no token in URLs.
- For visual and flow checks, run a local server with the worker on (`WORKER_ENABLED=true`) and use a real browser.
  Stage 12 used headless Edge with puppeteer-core and axe-core from a scratch folder (not project dependencies).
  See the Stage 12 build notes.
