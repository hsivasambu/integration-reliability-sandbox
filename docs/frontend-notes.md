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
   from 60rem. On phones the composer comes first, and the journey diagram stacks vertically (see *Journey*).
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
| Motion | `--motion-fast`, `--motion-base`, `--ease`, and a global `prefers-reduced-motion` rule for CSS animation. Journey motion (Stage 15) uses the Web Animations API and is gated in JavaScript (see *Motion*) |

State treatments are classes that set `--state-ink`, `--state-tint` and `--state-on-navy`:
`is-done`, `is-active`, `is-waiting`, `is-failed`, `is-idle`, `is-unknown`.

No web fonts and no background texture. The plain paper colour reads better than a texture at small sizes.
There is no dark theme (the earlier UI followed the system setting); the specified palette is light, with a
navy journey canvas.

## Journey (Stage 14)

The journey shows **three logical components that actually exist**, joined by labelled paths:

```
Your alert ──handed over──▶ Delivery service ──delivery try──▶ Receiving system
                                             ◀──acknowledgement──   └ Processing record (from the receipt)
```

- **Delivery service** is the sandbox's API plus its background worker, drawn as one component. **Receiving
  system** is the mock receiver inside the same app. There's no queue service or extra network hop to draw: the
  job store is the same PostgreSQL database, and the diagram doesn't pretend otherwise.
- **The forward path** ("Delivery try") and **the acknowledgement path** are separate. A 2xx reply confirms
  *delivery*.
- **The processing record** is a separate card, driven only by the receiver's receipt
  (`GET /v1/receiver/receipts/{id}`), so it confirms the synthetic *processing* result. If the receipt can't be
  loaded, processing is **Unknown**. That is never treated as proof that nothing was processed.
- **Below the diagram:** a plain-language explanation, then *Delivery / Tries / Next try / Processing*, then
  *What happened so far*. That list shows every delivery, original and replays, each with its tries.
- **Layout:** stacked on phones; one row when the journey panel is at least 40rem wide (a container query).
- **No animation in Stage 14** (motion came in Stage 15). Arrows and words show direction, and badges show state. The only thing that
  changes once a second is the countdown text "in about N s".

### Journey adapter (`public/journey-model.js`)

A pure function, `JourneyModel.toJourneyView(input)`. It has no DOM access, no network and no clock of its
own, and it's unit-tested in `test/journey-model.test.js` with fixtures shaped like the API's responses. The page
draws only what it returns.

**Input**

| Field | Source |
|---|---|
| `local` | Browser only: `{ status: 'sending' \| 'uncertain', title }` while a submission has no server answer (Stage 13's unconfirmed state) |
| `event` | `GET /v1/events` → `data[]`, or the POST response's `event`: `id`, `payload.title`, `createdAt`, `delivery` (summary) |
| `deliveries` | `GET /v1/events/{id}/deliveries` → `deliveries[]` (oldest first): `id`, `replayOf`, `state`, `attemptCount`, `maxAttempts`, `nextAttemptAt`, `failureReason`, `attempts[]` (`attemptNumber`, `outcome`, `errorCategory`, `responseStatus`, `retryable`, `startedAt`) |
| `receipt` / `receiptState` | `GET /v1/receiver/receipts/{id}`: `processed`, `result.confirmationCode`, `deliveriesReceived`, `duplicateCount`; `receiptState` is `ok`, `loading` or `unavailable` |
| `now` | The current time (milliseconds), used only to compare against `nextAttemptAt` |
| `stale` | `{ since }` when the last refresh failed; `since` is the last successful update |

**Delivery service badge** (latest delivery; replays are separate deliveries)

| Badge | API state |
|---|---|
| Saved | `pending`, `attemptCount = 0` |
| Waiting | `pending`, `attemptCount > 0` (lease lost; the last try's result is unknown); **or** `retry_scheduled` whose `nextAttemptAt` has passed: "Waiting for the next attempt" (no send is assumed until the API reports a try); **or** a try that has ended while the delivery row doesn't yet say what follows (see *Two-query race* below) |
| Sending | `in_progress` (try *n* of `maxAttempts`) |
| Trying again | `retry_scheduled`, `nextAttemptAt` in the future: tries used, next try time, countdown |
| Stopped | `failed`, with the reason from `failureReason` |
| Confirmed | `delivered` |
| Unknown | Any state the page doesn't recognize |

**Acknowledgement path** (latest try): *No reply yet* (no tries) · *Waiting for a reply* (`in_progress`) ·
*Delivery confirmed* (`delivered`) · *Error reply* (`http_error`) · *Timed out* (`timeout`) ·
*No reply* (`network_error`) · *Unknown* (`lease_expired`) · *Not loaded yet* (only the summary is known).
HTTP codes are in the technical view.

`responseObserved` is true only for *Delivery confirmed* and *Error reply* (an HTTP reply really arrived). Only
then is the acknowledgement path drawn with a return arrow. Otherwise it's a broken, neutral line with no
arrowhead: never a red return arrow for a reply that never came. *Timed out* carries a note: "No reply arrived in
time. That alone does not show whether the receiving system processed it."

**Two-query race (reconciled in the adapter).** `GET /v1/events/{id}/deliveries` reads the delivery rows and then
their attempts in two separate queries (`src/events.js`), not one snapshot. If the worker claims or finishes a try
between them, the attempt list is newer than the row. Stage 15's recordings caught a badge saying *Waiting* next to
"Try 2: sending…". `reconcile()` lets the newer evidence win:
- a recorded in-progress try → *Sending*
- a 2xx try → *Confirmed*
- a try that ended without a 2xx → *Waiting* ("recording what happens next")

Whether that last case leads to a retry or a stop isn't guessed; the next refresh shows it. The backend fix would
be to read both in one transaction. **Not done here:** this stage changes no backend behaviour.

**Processing record:** *Processed* (`processed: true`, with the confirmation code and repeats recognized) ·
*Not processed yet* (no receipt, delivery still active) · *No processing recorded* (no receipt, delivery finished) ·
*Checking…* (receipt still loading) · *Unknown* (receipt couldn't be loaded).

**Local (browser-only) states:** *Sending to the sandbox / Not saved yet* while the POST is unanswered, and
*Unconfirmed / Unknown* when the outcome is uncertain. These are never shown as server states.

**Timing:** the adapter uses only `nextAttemptAt`, `attemptCount` and `maxAttempts` from the API. The retry
backoff, the sender's timeout and the receiver's delay are server configuration that the API doesn't expose,
so the page never states them. The experiment text was changed to point at the countdown instead of quoting
seconds.

### Snapshots, stale answers and interruptions

- **Every refresh is a snapshot.** A reload shows the current state at once and never replays old transitions.
  If polling missed an intermediate state, the page shows the latest state and the completed tries.
- **Answers are bound to the request that asked for them:**
  - Selecting another alert aborts the previous alert's requests (`AbortController`), and any answer that still
    arrives is ignored (`isCurrent()`).
  - Changing the session aborts all requests for the old session, and a refresh whose token is no longer
    current is discarded.
  - A 401 only ends the session it was sent with.
  - The renderer also only uses detail data whose `eventId` matches the selected alert.
- **Network interruption:**
  - The last known state stays on screen with "Reconnecting… Showing the last known state, from HH:MM:SS".
  - A polling failure never changes a delivery's state. Polling backs off as before (up to 30 s).
- **Countdown reaching zero:** if the countdown ends before the API reports the next try, the journey says
  *Waiting for the next attempt*. It never claims a send.
- **Screen readers:** the journey region isn't `aria-live` (it's redrawn every refresh). A separate hidden live
  region announces one short sentence, only when the delivery or processing state of the shown alert changes.

## Motion (Stage 15)

Illustrations only. Every state and outcome is already in the text and badges, which the page renders first and
independently. Motion never holds a result back and never adds delays; the backend is unaware of it.
`public/journey-motion.js` has two parts.

**Planner** (`createPlanner()`, pure, unit-tested in `test/journey-motion.test.js`). It compares successive
journey views and returns effects, keyed by **stable attempt keys** (`<deliveryId>:<attemptNumber>`) and event IDs.
- **The first observation after the displayed alert changes is recorded silently.** That covers page load or
  refresh, selecting or reselecting an alert, and the tab becoming visible again: whatever happened meanwhile is
  history, so it is never animated as if live.
- **The visitor's own accepted send** (`accepted(eventId)`) is the exception: its attempts are watched live from the
  start.
- **Transitions:**
  - attempt newly seen *in progress* → `send`
  - *in progress* → 2xx → `ack`
  - → HTTP error → `error-reply`
  - → timeout → `timeout`
  - → connection failure → `no-connection`
- **An attempt first seen already finished** (common: a success takes milliseconds and polling runs every 2 s)
  gets a single `latest` effect. That's a short look back labelled **"Latest attempt (already finished)"**, played
  only after its outcome is on screen, and only for the newest attempt. Older unseen attempts are not illustrated.
- **Receipt evidence** drives the receiver card on its own: `processed` when a receipt first appears (even while
  the sender is still waiting), and `duplicate` ("Already processed") when the repeat count grows. A repeat never
  produces a second processing effect.

**Player** (`createPlayer(layer)`). It draws in `#journey-motion`, an overlay that refreshes never redraw.
- **Only `transform` and `opacity` move** (Web Animations API). Every effect lasts at most about 1.7 s, and
  nothing loops.
- **Paths are measured from the current layout when an effect starts:** left to right in the row layout, and
  stacked on phones (forward packets down the left of the path labels, replies up the right).
- **Deduplication** is per effect type and key, so an attempt's live send and its later outcome both play, and
  never twice.
- **The queue holds at most 2 pending effects**, keeping the newest.
- **Effects are cancelled when:** the alert or session changes, the tab is hidden, motion is turned off, or the
  journey's width changes.

| State | Static (always) | Motion (when on) |
|---|---|---|
| Accepted | *Accepted* badge | Brief "Saved" card at Your alert |
| Sending | *Sending*, "Try n of max" | Envelope "Try n" travels along *Delivery try* |
| Confirmed | *Confirmed*; acknowledgement *Delivery confirmed* with a return arrow | Teal "Delivery confirmed" marker travels back |
| HTTP error (e.g. 503) | *Error reply* with a return arrow (a reply arrived); the alert stays retryable | Restrained outlined "Error reply" marker travels back |
| Timeout | Acknowledgement *Timed out* on a broken line; the note says it is not proof of no processing | "Timed out" chip on the acknowledgement path; nothing travels back |
| Retry scheduled | *Trying again*, countdown, a wait bar from the last try's `endedAt` to `nextAttemptAt` | The wait bar fills smoothly; a new packet only when the next attempt is observed |
| Exhausted | *Stopped*, with **Deliver again** inside the delivery service | Nothing (it settles; no motion left) |
| Duplicate | "Already processed: n repeats recognized, not processed again" | "Already processed" chip at the receiver; no second result |

**Motion control.** *Motion: on/off* in the journey header (`aria-pressed`). The default follows
`prefers-reduced-motion`; an explicit choice is kept for the tab (`sessionStorage` `irs.motion`). With motion off,
nothing is drawn in the layer and the wait bar is redrawn once a second without animation. Icons, text and the
static path styling (broken line vs return arrow, current-path emphasis) carry everything. The global CSS
reduced-motion rule doesn't apply to Web Animations, which is why motion is gated in JavaScript; the wait bar
deliberately doesn't use a CSS animation, which that rule would make jump to "full".

**Hidden tab.** Illustrations stop at once. When the tab is visible again, the next fresh data is recorded
silently (no replay of what was missed), and the current state is shown. Polling pauses as before, but that
doesn't pause the backend: deliveries continue on the server.

## Guided scenarios (Stage 16)

Four cards under *Try a scenario*: **Normal delivery**, plus three guides. Everything uses the existing endpoints
only (`PUT /v1/receiver`, `POST /v1/events`, `POST /v1/deliveries/{id}/replay`, and the reads). There is no backend
scenario, no restore endpoint and no timer.

| Card | Receiver mode | Steps (each advances only on API evidence) |
|---|---|---|
| Normal delivery | `success` (set only if different) | Sends one alert; no guide panel |
| Recover from a temporary problem | `server_error` | 1 set + send · 2 watch the first try fail · 3 **Restore receiver** appears once a rejected try is observed (it only sends `PUT /v1/receiver`; the next *scheduled* try delivers) · 4 delivered |
| Avoid processing twice | `process_then_timeout` | 1 set + send · 2 watch the first try · 3 the reply timed out but the receipt shows it processed; the automatic retry is recognized by the real receiver · done: one result, the repeat recognized. No configuration step is needed: the receiver recognizes a repeat before any simulated failure, in every mode |
| Rescue a stopped delivery | `server_error` | 1 set + send · 2 wait until delivery stops · 3 **Restore and retry** appears only once a failed terminal delivery is confirmed: the receiver is restored (awaited), the delivery is re-read, then the existing replay endpoint is called · 4 the new delivery confirmed; the original failure stays in the history |

**Starting a guide**
1. The start button is disabled before anything is awaited, so rapid clicks start once.
2. A session is created only by this click.
3. The page **re-reads** the session's active deliveries (`GET /v1/summary`, which counts the whole session, not
   just the 20 listed).
4. If anything is still being delivered, it stops with the reason.
5. Otherwise it saves the guide, sets the mode (`PUT`), and **only after a 200** sends a new alert through the
   Stage 13 pipeline (same Idempotency-Key handling).
6. If the receiver change fails, the guide says nothing was sent and offers *Try again*.
7. If the send is refused (e.g. the alert limit), the guide says so and that the receiver stays changed.
8. If the send is unconfirmed, the guide points to the composer's *Check again*.

**Locks (session-wide setting).** The receiver mode applies to the whole session.
- While any alert in the session is still being delivered, the guide start buttons, *Normal delivery* (when it
  would change the mode) and the free choices under *Set the test receiver yourself* are disabled, each with a
  one-line reason. A change by hand also re-reads the active count first.
- During a guide, only the guide's own *Restore* changes the mode. Restoring to "Works normally" can only help
  other waiting alerts, and the guide says so when there are any.
- The page can't stop another tab using the same session from sending at the same moment, and says so under the
  guide.
- Once all work is terminal, everything is available again.

**State and refresh.** The guide is kept in this tab (`sessionStorage` `irs.guide`) with a random tag of the session
it belongs to (`irs.sessionTag`, regenerated when the session changes). It stores milestones only:
- the stage
- the alert's `eventId` (or the submission's Idempotency-Key until the alert is found in the list)
- `restored`
- `replay: { deliveryId, status }`

On refresh the step is re-derived from fresh API data. Nothing is sent on load:
- An interrupted receiver change shows *Try again*.
- An unconfirmed retry request shows *Check again*, which re-sends the same replay Idempotency-Key (kept per
  delivery until answered).
- If the replay already exists in the history, that evidence is used and nothing is sent.

**Guidance.** One short instruction at a time ("Step x of y"), in a panel above the journey. It's an inline card,
not a modal; its buttons are normal keyboard-focusable buttons, and the instruction is announced only when it
changes. Nothing starts on page load. *Leave guide* says the alert keeps being delivered in the background and
which mode the receiver stays in. *Run it again* and *Close guide* appear at the end. If polling fails or a
request is slow, the panel says *Waiting for the delivery service* with *Reconnect now*.

## Known gaps (data the API doesn't provide)

- **Guides are a browser-side layer.** The server knows nothing about a "scenario", and the mode is per session, so
  exclusivity across tabs or devices can't be guaranteed.

- **Attempts and delivery rows are read in two queries** by `GET /v1/events/{id}/deliveries`, so they can briefly
  disagree. The adapter reconciles this (see *Two-query race*); a backend fix would read both in one transaction.

- **The receiver mode is per session, not per alert.** Changing it affects every waiting retry in the session, and
  attempts don't record which mode was active. The page says so next to the mode choice.
- **Attempts store only `responseStatus` / `errorCategory`, not the receiver's error code**, so the page says
  "error reply" rather than naming the simulated outage.
- **There's no public worker liveness.** "Service ready" means the API and database answer, not that deliveries are
  moving.
- **No alert fields beyond `title` and `message`.** There's no severity or priority, and the page doesn't invent
  any.

## Refresh and recovery behaviour

Single-flight polling every 2 s while any delivery is active. It pauses when the tab is hidden and refreshes on
return, and it backs off up to 30 s on errors with *Retry now*. A slow request (> 4 s) shows the "waking up" banner;
a request fails only after 90 s or with no API answer. Obsolete requests are cancelled and late answers ignored
(see *Snapshots, stale answers and interruptions*). On reload, the session and the selected alert are restored
from `sessionStorage`.

A submission without an answer keeps its Idempotency-Key, so pressing *Send alert* again can't create a second
alert. Replay keys are kept per delivery until answered. A 401 clears the token and offers a new session, but
never creates one automatically.

## Checking the page

- `npm test` includes `test/ui.test.js` (CSP, no inline script/handlers/styles, safe DOM APIs in both scripts, no
  token in URLs) and `test/journey-model.test.js` (the adapter's mapping, with fixtures).
- For visual and flow checks, run a local server with the worker on (`WORKER_ENABLED=true`) and use a real browser.
  Stages 12–14 used headless Edge with puppeteer-core and axe-core from a scratch folder (not project
  dependencies), with DevTools `Fetch` interception to hold, fail or delay specific requests. See the build notes.
