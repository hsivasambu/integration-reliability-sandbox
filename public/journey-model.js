// Journey presentation-state adapter (Stage 14).
//
// A pure function from API responses (plus the browser's own submitting state) to what the journey
// shows. No DOM access, no clock of its own (`now` is passed in), no network. The page loads it before
// app.js; Node tests load it with require(). Input fields and the full mapping are documented in
// docs/frontend-notes.md ("Journey adapter").
//
// It only describes what the API reports. It never infers a send, a failure or a processing result
// that the data doesn't show, and it doesn't assume backend timing that the API doesn't expose.
(function (root) {
  'use strict';

  const ACTIVE = new Set(['pending', 'retry_scheduled', 'in_progress']);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The delivery service's state for one delivery (GET /v1/events → event.delivery, or one entry of
  // GET /v1/events/{id}/deliveries → deliveries[]). Badge codes: saved, waiting, sending, retrying,
  // stopped, confirmed, unknown.
  function deliveryStatus(d, now) {
    const n = d.attemptCount;
    const max = d.maxAttempts;
    switch (d.state) {
      case 'pending':
        return n === 0
          ? {
            code: 'saved', label: 'Saved', tone: 'is-waiting', icon: 'box', triesSoFar: 0, nextTry: 1, max,
            detail: 'Saved and queued. The first try starts when the delivery service picks it up.',
          }
          : {
            code: 'waiting', label: 'Waiting', tone: 'is-waiting', icon: 'clock', triesSoFar: n, nextTry: n + 1, max,
            detail: `The result of try ${n} is unknown because the delivery service restarted. It will be sent again.`,
          };
      case 'in_progress':
        return {
          code: 'sending', label: 'Sending', tone: 'is-active', icon: 'send', triesSoFar: n, currentTry: n, max,
          detail: `Sending try ${n} of ${max} and waiting for the reply.`,
        };
      case 'retry_scheduled': {
        const due = Date.parse(d.nextAttemptAt);
        const seconds = Number.isFinite(due) ? Math.ceil((due - now) / 1000) : null;
        if (seconds !== null && seconds > 0) {
          return {
            code: 'retrying', label: 'Trying again', tone: 'is-waiting', icon: 'retry', triesSoFar: n, nextTry: n + 1, max,
            nextAttemptAt: d.nextAttemptAt, countdownSeconds: seconds,
            detail: `Try ${n} of ${max} did not get through. Try ${n + 1} is scheduled.`,
          };
        }
        // The scheduled time has passed but no new try is reported yet: don't pretend one was sent.
        return {
          code: 'waiting', label: 'Waiting', tone: 'is-waiting', icon: 'clock', triesSoFar: n, nextTry: n + 1, max,
          nextAttemptAt: d.nextAttemptAt, countdownSeconds: 0,
          detail: `Waiting for the next attempt. Try ${n + 1} of ${max} is due and starts when the delivery service picks it up.`,
        };
      }
      case 'settling': // see reconcile(): a try just ended and the next step isn't recorded yet
        return {
          code: 'waiting', label: 'Waiting', tone: 'is-waiting', icon: 'clock', triesSoFar: n, max,
          detail: `Try ${n} did not get through. The delivery service is recording what happens next.`,
        };
      case 'delivered':
        return {
          code: 'confirmed', label: 'Confirmed', tone: 'is-done', icon: 'check', triesSoFar: n, max,
          detail: `The receiving system acknowledged try ${n} of ${max}.`,
        };
      case 'failed':
        return {
          code: 'stopped', label: 'Stopped', tone: 'is-failed', icon: 'stop', triesSoFar: n, max,
          reason: d.failureReason ?? null,
          detail: {
            attempts_exhausted: `All ${plural(max, 'try', 'tries')} failed, so the delivery service stopped trying.`,
            non_retryable: 'The receiving system refused it in a way that trying again cannot fix.',
            session_expired: 'The demo session ended before it could be delivered.',
          }[d.failureReason] ?? 'The delivery service stopped trying.',
        };
      default:
        return { code: 'unknown', label: 'Unknown', tone: 'is-unknown', icon: 'question', detail: `The API reported "${d.state}".` };
    }
  }

  // One attempt from deliveries[].attempts[] (outcome, errorCategory, responseStatus, retryable).
  function attemptStatus(a) {
    if (a.outcome === 'in_progress') return { code: 'sending', tone: 'is-active', icon: 'send', text: 'sending…' };
    if (a.outcome === 'delivered') return { code: 'confirmed', tone: 'is-done', icon: 'check', text: 'receiving system confirmed' };
    if (a.outcome === 'lease_expired') {
      return { code: 'unknown', tone: 'is-unknown', icon: 'question', text: 'result unknown, the delivery service restarted' };
    }
    switch (a.errorCategory) {
      case 'http_error':
        return {
          code: 'error', tone: 'is-failed', icon: 'cross',
          text: a.retryable === false ? 'refused by the receiving system' : 'error reply from the receiving system',
        };
      case 'timeout': return { code: 'timeout', tone: 'is-waiting', icon: 'hourglass', text: 'timed out, no reply in time' };
      case 'network_error': return { code: 'no_connection', tone: 'is-failed', icon: 'cross', text: 'could not connect to the receiving system' };
      default: return { code: 'unknown', tone: 'is-unknown', icon: 'question', text: 'did not get through' };
    }
  }

  // The reply path: what came back for the latest try of the delivery shown. `attempts` is null when
  // the attempt history has not been loaded (only the list summary is known). `responseObserved` is
  // true only when an HTTP reply actually arrived; otherwise no return arrow may be drawn.
  function acknowledgement(attempts) {
    const none = (code, label, tone, technical = null, note = null) => ({ code, label, tone, technical, note, responseObserved: false });
    if (!attempts) return none('unknown', 'Not loaded yet', 'is-unknown');
    const a = attempts.at(-1);
    if (!a) return none('none', 'No reply yet', 'is-idle');
    const http = a.responseStatus ? `HTTP ${a.responseStatus}` : 'no HTTP response';
    if (a.outcome === 'in_progress') return none('waiting', 'Waiting for a reply', 'is-active');
    if (a.outcome === 'delivered') {
      return { code: 'confirmed', label: 'Delivery confirmed', tone: 'is-done', technical: http, note: null, responseObserved: true };
    }
    if (a.outcome === 'lease_expired') return none('unknown', 'Unknown', 'is-unknown', 'lease expired');
    const s = attemptStatus(a);
    if (s.code === 'error') {
      return { code: 'error', label: 'Error reply', tone: 'is-failed', technical: http, note: null, responseObserved: Boolean(a.responseStatus) };
    }
    if (s.code === 'timeout') {
      return none('timeout', 'Timed out', 'is-waiting', http,
        'No reply arrived in time. That alone does not show whether the receiving system processed it.');
    }
    if (s.code === 'no_connection') return none('no_connection', 'No reply', 'is-idle', http, 'The delivery service could not connect.');
    return none(s.code, 'Not confirmed', 'is-unknown', http);
  }

  // The forward path: tries sent for the delivery shown.
  function forward(attempts, status) {
    if (status.code === 'sending') return { label: `Sending try ${status.currentTry}`, tone: 'is-active', active: true };
    if (!attempts) return { label: status.triesSoFar ? `${plural(status.triesSoFar, 'try', 'tries')} sent` : 'No try sent yet', tone: 'is-idle', active: false };
    if (attempts.length === 0) return { label: 'No try sent yet', tone: 'is-idle', active: false };
    return { label: `${plural(attempts.length, 'try', 'tries')} sent`, tone: 'is-idle', active: false };
  }

  // The receiving system's own record (GET /v1/receiver/receipts/{id}). If it couldn't be loaded,
  // processing is Unknown: that is not evidence that nothing was processed.
  function processing(receipt, receiptState, latest) {
    if (receiptState !== 'ok' || !receipt) {
      return {
        code: receiptState === 'loading' ? 'checking' : 'unknown',
        label: receiptState === 'loading' ? 'Checking…' : 'Unknown', tone: 'is-unknown', icon: 'question',
        detail: receiptState === 'loading'
          ? 'Checking what the receiving system recorded…'
          : 'The receiving system\'s record could not be loaded, so this is unknown. That is not proof that nothing was processed.',
      };
    }
    if (receipt.processed) {
      const repeats = receipt.duplicateCount;
      return {
        code: 'processed', label: 'Processed', tone: 'is-done', icon: 'inbox',
        confirmationCode: receipt.result?.confirmationCode ?? null,
        repeats,
        // A repeat delivery is recognized from the record; it never produces a second result.
        alreadyProcessedNote: repeats > 0 ? `Already processed: ${plural(repeats, 'repeat', 'repeats')} recognized, not processed again` : null,
        detail: repeats > 0
          ? `Processed once. It received the alert ${receipt.deliveriesReceived} times and recognized ${plural(repeats, 'repeat', 'repeats')}.`
          : 'Processed once.',
      };
    }
    if (latest && ACTIVE.has(latest.state)) {
      return { code: 'not_yet', label: 'Not processed yet', tone: 'is-idle', icon: 'dash', detail: 'No processing recorded so far.' };
    }
    return {
      code: 'none_recorded', label: 'No processing recorded', tone: 'is-idle', icon: 'dash',
      detail: 'The receiving system has no record of processing this alert.',
    };
  }

  // One plain sentence for "what is happening now".
  function explain({ status, ack, proc, attempts }) {
    const timedOut = attempts?.some((a) => a.errorCategory === 'timeout');
    switch (status.code) {
      case 'saved':
        return `The sandbox saved your alert. The delivery service will send it to the receiving system.`;
      case 'sending':
        return `The delivery service is sending try ${status.currentTry} to the receiving system and waiting for its reply.`;
      case 'retrying':
        if (proc.code === 'processed') {
          return 'The receiving system already processed your alert, but its reply did not arrive in time, so the delivery service will try again.';
        }
        return `The receiving system did not confirm try ${status.triesSoFar} (${ack.label.toLowerCase()}). The delivery service will try again when the countdown ends.`;
      case 'waiting':
        return status.detail;
      case 'confirmed':
        if (proc.code === 'processed' && proc.repeats > 0 && timedOut) {
          return 'The receiving system processed your alert once. A reply came too late, so the delivery service tried again; the receiving system recognized the repeat and did not process it twice.';
        }
        if (proc.code === 'processed') return 'The receiving system confirmed it received your alert, and its record shows it was processed.';
        if (proc.code === 'unknown') return 'Delivery was confirmed. What the receiving system did with it could not be checked right now.';
        return 'Delivery was confirmed, but the receiving system has no record of processing it.';
      case 'stopped':
        if (status.reason === 'attempts_exhausted') {
          return `${status.detail} You can deliver it again once the receiving system is working.`;
        }
        return status.detail;
      default:
        return 'The delivery is in a state this page does not recognize. The technical view shows the raw data.';
    }
  }

  // GET /v1/events/{id}/deliveries reads the delivery rows and then their attempts in two queries, not one
  // snapshot. If a worker claims or finishes a try between those reads, the attempt list is newer than the
  // delivery row. In that case the newer evidence wins: a recorded in-progress try means it really is being
  // sent, and a 2xx attempt means it really was delivered. Nothing else is inferred (a failed try's next
  // state, retry or stop, stays as the row says until the next refresh).
  function reconcile(d) {
    const newest = d.attempts?.at(-1);
    if (!newest) return d;
    const ahead = newest.attemptNumber > d.attemptCount
      || (newest.attemptNumber === d.attemptCount && d.state === 'in_progress');
    if (!ahead) return d;
    if (newest.outcome === 'in_progress') return { ...d, state: 'in_progress', attemptCount: newest.attemptNumber, nextAttemptAt: null };
    if (newest.outcome === 'delivered') return { ...d, state: 'delivered', attemptCount: newest.attemptNumber, nextAttemptAt: null };
    // The try ended without a 2xx, but the row doesn't yet say what follows (a retry or a stop).
    return { ...d, state: 'settling', attemptCount: newest.attemptNumber, nextAttemptAt: null };
  }

  // --- Stage 17: timeline and outcome -------------------------------------------------------------

  const seconds = (fromIso, toIso) => {
    const ms = Date.parse(toIso) - Date.parse(fromIso);
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  };

  // One stored attempt in plain words. Only recorded fields are used; no reason is invented.
  function attemptEntry(d, a) {
    const n = a.attemptNumber;
    const base = { key: `${d.id}:${n}`, attempt: n, at: a.startedAt, endedAt: a.endedAt ?? null };
    if (a.outcome === 'in_progress') return { ...base, tone: 'is-active', icon: 'send', text: `Attempt ${n}: in progress, no result yet.` };
    if (a.outcome === 'delivered') return { ...base, tone: 'is-done', icon: 'check', text: `Attempt ${n}: delivery confirmed (the receiving system acknowledged it).` };
    if (a.outcome === 'lease_expired') {
      return { ...base, tone: 'is-unknown', icon: 'question', interrupted: true,
        text: `Attempt ${n}: interrupted. The delivery service stopped before recording a result, so the outcome is unknown.` };
    }
    const text = {
      http_error: a.retryable === false
        ? `Attempt ${n}: the receiving system refused it (an error that retrying cannot fix).`
        : `Attempt ${n}: the receiving system returned an error.`,
      timeout: `Attempt ${n}: no reply in time (timed out). That alone does not show whether it was processed.`,
      network_error: `Attempt ${n}: could not connect to the receiving system.`,
    }[a.errorCategory] ?? `Attempt ${n}: did not get through (no reason was recorded).`;
    return { ...base, tone: a.errorCategory === 'timeout' ? 'is-waiting' : 'is-failed', icon: a.errorCategory === 'timeout' ? 'hourglass' : 'cross', text };
  }

  function stopText(d) {
    return {
      attempts_exhausted: `Delivery stopped: all ${d.maxAttempts} attempts allowed were used.`,
      non_retryable: 'Delivery stopped: the receiving system refused it in a way retrying cannot fix.',
      session_expired: 'Delivery stopped: the demo session ended first.',
    }[d.failureReason] ?? 'Delivery stopped (no reason was recorded).';
  }

  // The selected alert's history from stored records. Each delivery (the original, then each manual
  // retry) is its own labelled group; the receiving system's record is a separate group.
  function buildTimeline(event, records, receipt, receiptState) {
    let replayNumber = 0;
    const groups = (records ?? []).map((d, index) => {
      const isReplay = Boolean(d.replayOf);
      if (isReplay) replayNumber += 1;
      const items = [{
        key: `${d.id}:start`, at: d.createdAt ?? (isReplay ? null : event.createdAt), tone: 'is-idle', icon: isReplay ? 'replay' : 'box',
        text: isReplay ? 'Retried by hand: a new delivery of the same alert was started.' : 'Saved and queued for delivery.',
      }];
      d.attempts.forEach((a, i) => {
        items.push(attemptEntry(d, a));
        const next = d.attempts[i + 1];
        if (next && a.outcome === 'failed' && a.endedAt) {
          const waited = seconds(a.endedAt, next.startedAt);
          items.push({ key: `${d.id}:${a.attemptNumber}:wait`, at: a.endedAt, tone: 'is-waiting', icon: 'clock',
            text: `Waiting before another attempt${waited !== null ? ` (about ${waited} s, from the recorded times)` : ''}.` });
        }
        if (next && a.outcome === 'lease_expired') {
          items.push({ key: `${d.id}:${a.attemptNumber}:requeued`, at: null, tone: 'is-idle', icon: 'retry',
            text: 'Queued again straight away, because the result of that attempt is unknown.' });
        }
      });
      if (d.state === 'pending' && d.attempts.length === 0) {
        items.push({ key: `${d.id}:queued`, at: null, tone: 'is-waiting', icon: 'clock', text: 'Waiting for the first attempt.' });
      }
      if (d.state === 'retry_scheduled' || d.state === 'settling' || (d.state === 'pending' && d.attempts.length > 0)) {
        items.push({ key: `${d.id}:waiting`, at: d.attempts.at(-1)?.endedAt ?? null, tone: 'is-waiting', icon: 'clock',
          text: d.nextAttemptAt ? 'Waiting before another attempt.' : 'Waiting for the next step.', dueAt: d.nextAttemptAt ?? null });
      }
      if (d.state === 'delivered') items.push({ key: `${d.id}:end`, at: d.completedAt ?? null, tone: 'is-done', icon: 'check', text: 'Delivery confirmed.' });
      if (d.state === 'failed') items.push({ key: `${d.id}:end`, at: d.completedAt ?? null, tone: 'is-failed', icon: 'stop', text: stopText(d) });
      return {
        id: d.id,
        label: isReplay ? `Delivered again (${replayNumber})` : 'Original delivery',
        current: index === records.length - 1,
        items,
      };
    });

    let receiver;
    if (receiptState !== 'ok' || !receipt) {
      receiver = [{ key: 'receipt:unknown', at: null, tone: 'is-unknown', icon: 'question',
        text: receiptState === 'loading' ? 'Checking the receiving system\'s record…' : 'Unknown: the receiving system\'s record could not be loaded.' }];
    } else if (receipt.processed) {
      receiver = [{ key: 'receipt:processed', at: receipt.firstReceivedAt, tone: 'is-done', icon: 'inbox',
        text: `Processed the alert${receipt.result?.confirmationCode ? ` (confirmation ${receipt.result.confirmationCode})` : ''}.` }];
      if (receipt.duplicateCount > 0) {
        receiver.push({ key: 'receipt:repeats', at: receipt.lastReceivedAt, tone: 'is-done', icon: 'inbox',
          text: `Recognized ${plural(receipt.duplicateCount, 'repeat delivery', 'repeat deliveries')} and did not process again`
            + `${receipt.duplicateCount > 1 ? ' (the time shown is the latest)' : ''}.` });
      }
    } else {
      receiver = [{ key: 'receipt:none', at: null, tone: 'is-idle', icon: 'dash', text: 'No processing recorded so far.' }];
    }
    return { groups, receiver };
  }

  // The compact outcome. Sender evidence (acknowledgements) and receiver evidence (the receipt) stay
  // separate; "processed once" comes only from the receipt, never from attempt counts. Anything the data
  // can't support is left out (null).
  function buildOutcome(event, records, status, proc) {
    let delivery;
    const allAttempts = records ? records.flatMap((d) => d.attempts) : null;
    const byHand = Boolean(records && records.length > 1);
    if (status.code === 'confirmed') {
      const earlierFailure = allAttempts ? allAttempts.some((a) => a.outcome === 'failed') : false;
      delivery = earlierFailure
        ? { code: 'retried', label: 'Retried successfully', tone: 'is-done',
          text: `A later attempt was acknowledged after an earlier failure${byHand ? ' (after a retry by hand)' : ''}.` }
        : { code: 'confirmed', label: 'Delivery confirmed', tone: 'is-done', text: 'The receiving system acknowledged the alert.' };
    } else if (status.code === 'stopped') {
      delivery = { code: 'stopped', label: 'Stopped', tone: 'is-failed', text: {
        attempts_exhausted: `The configured attempt allowance (${status.max}) was exhausted.`,
        non_retryable: 'A terminal error occurred: the receiving system refused it.',
        session_expired: 'The demo session ended before it was delivered.',
      }[status.reason] ?? 'The delivery stopped; no reason was recorded.' };
    } else {
      delivery = { code: 'in_progress', label: 'Not finished', tone: 'is-waiting', text: 'Delivery is still under way.' };
    }

    let processingOutcome = null;
    if (proc.code === 'processed') {
      processingOutcome = proc.repeats > 0
        ? { code: 'processed_once', label: 'Processed once', tone: 'is-done',
          text: `The receiver's record shows one synthetic processing result, although the alert reached it ${proc.repeats + 1} times.` }
        : { code: 'processed', label: 'Processed', tone: 'is-done', text: 'The receiver\'s record shows one synthetic processing result.' };
    } else if (proc.code === 'none_recorded') {
      processingOutcome = { code: 'none', label: 'Not processed', tone: 'is-idle', text: 'The receiver\'s record shows no processing.' };
    }

    // A timing figure only where both ends are recorded, and only for the original delivery (a retry by
    // hand includes human waiting time, which would make the number misleading).
    let timing = null;
    const latest = records?.at(-1);
    if (status.code === 'confirmed' && latest && !latest.replayOf && latest.completedAt) {
      const s = seconds(event.createdAt, latest.completedAt);
      if (s !== null) timing = `Confirmed about ${s} s after the alert was accepted (from the recorded times).`;
    }

    // Which delivery the summary describes: always the newest one; earlier ones stay in the timeline.
    const current = records && records.length > 1
      ? `This summary describes the newest delivery (Delivered again (${records.length - 1})). Earlier deliveries and their failures stay in the timeline below.`
      : null;
    return { delivery, processing: processingOutcome, timing, current };
  }

  // Main entry point.
  //   local:        null | { status: 'sending' | 'uncertain', title, message }  (browser-only, before the server confirms)
  //   event:        null | event resource (GET /v1/events data[] or the POST response's `event`)
  //   deliveries:   null | GET /v1/events/{id}/deliveries → deliveries[] (oldest first)
  //   receipt:      null | GET /v1/receiver/receipts/{id} response
  //   receiptState: 'ok' | 'loading' | 'unavailable'
  //   now:          milliseconds since the epoch
  //   stale:        null | { since: ISO time of the last successful update }
  function toJourneyView({ local = null, event = null, deliveries = null, receipt = null, receiptState = 'loading', now, stale = null }) {
    if (local) {
      const uncertain = local.status === 'uncertain';
      return {
        key: 'local',
        server: false,
        title: local.title,
        alert: uncertain
          ? { label: 'Unconfirmed', tone: 'is-waiting', icon: 'question', detail: 'Unknown whether the sandbox saved it.' }
          : { label: 'Sending to the sandbox', tone: 'is-active', icon: 'send', detail: 'Not saved yet.' },
        handover: { label: uncertain ? 'Unknown' : 'Not saved yet', tone: uncertain ? 'is-unknown' : 'is-idle' },
        delivery: uncertain
          ? { code: 'unknown', label: 'Unknown', tone: 'is-unknown', icon: 'question', detail: 'Nothing is known about delivery until the sandbox confirms it saved the alert.' }
          : { code: 'none', label: 'Not started', tone: 'is-idle', icon: 'dash', detail: 'Delivery starts after the sandbox saves the alert.' },
        forward: { label: 'No try sent yet', tone: 'is-idle', active: false },
        ack: { code: 'none', label: 'No reply yet', tone: 'is-idle', technical: null },
        processing: { code: 'none', label: 'Not started', tone: 'is-idle', icon: 'dash', detail: 'Nothing has reached the receiving system.' },
        explanation: uncertain
          ? 'We could not confirm whether the sandbox saved your alert. Use Check again in the composer; it cannot create a second alert.'
          : 'Your alert is on its way to the sandbox. It is not saved until the sandbox confirms it.',
        deliveries: [],
        stale,
      };
    }
    if (!event) return null;

    // The delivery shown in the diagram is the latest one; the history keeps every delivery separately.
    const records = deliveries?.length ? deliveries.map(reconcile) : null;
    const latest = records ? records.at(-1) : event.delivery;
    const attempts = records ? latest.attempts : null;
    const status = deliveryStatus(latest, now);
    // The retry wait runs from the end of the last try to nextAttemptAt (both from the API).
    if (status.nextAttemptAt && attempts?.length) status.waitFrom = attempts.at(-1).endedAt ?? null;
    const ack = acknowledgement(attempts);
    const proc = processing(receipt, receiptState, latest);
    let replayNumber = 0;
    const history = (records ?? []).map((d) => {
      const isReplay = d.replayOf !== null && d.replayOf !== undefined;
      if (isReplay) replayNumber += 1;
      return {
        id: d.id,
        label: isReplay ? `Delivered again (${replayNumber})` : 'Original delivery',
        replayOf: d.replayOf ?? null,
        status: deliveryStatus(d, now),
        attempts: d.attempts.map((a) => ({
          key: `${d.id}:${a.attemptNumber}`,
          number: a.attemptNumber,
          startedAt: a.startedAt,
          ...attemptStatus(a),
        })),
      };
    });

    return {
      key: `event:${event.id}`,
      server: true,
      eventId: event.id,
      deliveryId: latest.id,
      title: event.payload.title,
      acceptedAt: event.createdAt,
      alert: { label: 'Accepted', tone: 'is-done', icon: 'bell', detail: 'Saved by the sandbox.' },
      handover: { label: 'Handed over', tone: 'is-done' },
      delivery: status,
      forward: forward(attempts, status),
      ack,
      processing: proc,
      explanation: (latest.replayOf ? 'This is a new delivery, started by hand. ' : '') + explain({ status, ack, proc, attempts }),
      deliveries: history,
      timeline: buildTimeline(event, records, receipt, receiptState),
      outcome: buildOutcome(event, records, status, proc),
      stale,
    };
  }

  const api = { toJourneyView, deliveryStatus, attemptStatus, acknowledgement, processing, reconcile };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JourneyModel = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
