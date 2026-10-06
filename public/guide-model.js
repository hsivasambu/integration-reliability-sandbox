// Guided scenarios (Stage 16): definitions and the step logic.
//
// guideStep(guide, ctx) is pure. It turns the guide's saved milestones (what the visitor did and what the
// API confirmed: receiver set, alert accepted, receiver restored, retry requested) plus the observed
// journey view (from journey-model.js) into one short instruction and the actions allowed now. Steps
// advance only from API evidence, never from elapsed time. Node tests load it with require().
(function (root) {
  'use strict';

  const SCENARIOS = {
    normal: {
      id: 'normal', title: 'Normal delivery', icon: 'send', mode: 'success', guided: false,
      eventTitle: 'Normal delivery', summary: 'The receiver works normally. Send one alert and follow it from start to finish.',
    },
    recover: {
      id: 'recover', title: 'Recover from a temporary problem', icon: 'retry', mode: 'server_error', guided: true, steps: 4,
      eventTitle: 'Guided: temporary problem',
      summary: 'The receiver rejects the first try. You restore it, and a scheduled retry succeeds.',
    },
    twice: {
      id: 'twice', title: 'Avoid processing twice', icon: 'hourglass', mode: 'process_then_timeout', guided: true, steps: 3,
      eventTitle: 'Guided: reply arrives too late',
      summary: 'The receiver processes the alert but replies too late. A retry is recognized as the same alert.',
    },
    rescue: {
      id: 'rescue', title: 'Rescue a stopped delivery', icon: 'replay', mode: 'server_error', guided: true, steps: 4,
      eventTitle: 'Guided: stopped delivery',
      summary: 'Every automatic try fails. You restore the receiver and retry the delivery by hand.',
    },
  };

  const step = (n, total, phase, text, actions = [], tone = 'is-active') => ({ step: n, total, phase, text, actions, tone });
  const attemptsOf = (view) => (view?.deliveries ?? []).flatMap((d) => d.attempts);

  // ctx:
  //   view        journey view of the guide's alert (null if not selected or not loaded)
  //   selected    whether the guide's alert is the one shown in the journey
  //   busy        'configuring' | 'sending' | 'restoring' | 'replaying' | null  (requests in flight in this page)
  //   pending     the composer's unconfirmed submission (Stage 13) or null
  //   eventKnown  whether an alert with the guide's submission key is in the alert list
  function stepFor(guide, ctx) {
    const s = SCENARIOS[guide.scenario];
    const total = s.steps;
    const leave = { id: 'leave', label: 'Leave guide' };

    // Step 1: set the receiver, then send one new alert.
    if (guide.stage === 'configuring') {
      if (ctx.busy === 'configuring') return step(1, total, 'configuring', 'Setting the test receiver…', []);
      return step(1, total, 'config-failed',
        'The receiver setting was not confirmed, so nothing was sent. You can try again.',
        [{ id: 'retry-start', label: 'Try again', primary: true }, leave], 'is-waiting');
    }
    if (guide.stage === 'sending') {
      if (ctx.busy === 'sending') return step(1, total, 'sending', 'Sending a new alert…', []);
      if (ctx.pending) {
        return step(1, total, 'send-unconfirmed',
          'We could not confirm whether the alert was accepted. Use Check again in the composer; it cannot create a second alert.',
          [leave], 'is-waiting');
      }
      return step(1, total, 'send-failed',
        `The alert was not sent (see the message under the composer). The receiver is still set to "${ctx.modeLabel ?? s.mode}"; Normal delivery sets it back.`,
        [{ id: 'retry-start', label: 'Try again', primary: true }, leave], 'is-waiting');
    }
    if (guide.stage === 'done') return doneStep(guide, s, ctx);

    // Running: the guide's alert was accepted. Everything below comes from what the API reports.
    if (!ctx.selected) {
      return step(2, total, 'elsewhere', `This guide follows "${guide.title ?? s.eventTitle}". Show it in the journey to continue.`,
        [{ id: 'show', label: 'Show the guided alert', primary: true }, leave]);
    }
    const v = ctx.view;
    if (!v || !v.server || v.deliveries.length === 0) return step(2, total, 'loading', 'Loading the alert\'s journey…', [leave]);
    const d = v.delivery;
    const attempts = attemptsOf(v);

    if (guide.scenario === 'recover') {
      if (d.code === 'confirmed') return finish(guide, s, ctx);
      if (d.code === 'stopped') {
        return step(3, total, 'stopped-early',
          'Every try was used before the receiver was restored. You can still rescue it: restore the receiver and retry by hand.',
          [{ id: 'restore-retry', label: 'Restore and retry', primary: true }, leave], 'is-failed');
      }
      if (guide.restored || ctx.busy === 'restoring') {
        if (ctx.busy === 'restoring') return step(3, total, 'restoring', 'Restoring the receiver…', []);
        return step(3, total, 'await-retry',
          'Receiver restored. The next scheduled try will deliver the alert. Restoring did not send anything by itself.',
          [leave]);
      }
      if (attempts.some((a) => a.code === 'error')) {
        return step(3, total, 'restore',
          'The first try was rejected. Press Restore receiver. Nothing is sent when you press it: the next scheduled try will deliver the alert.',
          [{ id: 'restore', label: 'Restore receiver', primary: true }, leave], 'is-waiting');
      }
      return step(2, total, 'await-failure', 'The receiver is rejecting alerts. Watch the first try fail.', [leave]);
    }

    if (guide.scenario === 'twice') {
      if (d.code === 'confirmed') return finish(guide, s, ctx);
      if (d.code === 'stopped') {
        return step(3, total, 'stopped', 'Delivery stopped before a retry was confirmed. Deliver again is available in the journey.', [leave], 'is-failed');
      }
      const timedOut = attempts.some((a) => a.code === 'timeout');
      if (timedOut || (v.processing.code === 'processed' && d.code !== 'confirmed')) {
        return step(3, total, 'await-repeat',
          'The reply timed out, but the receiver\'s record already shows the alert processed. The next try is sent automatically; watch the receiver recognize it.',
          [leave]);
      }
      return step(2, total, 'await-timeout', 'The receiver will process the alert, then reply too late. Watch the first try.', [leave]);
    }

    // rescue
    const replays = v.deliveries.filter((x) => x.replayOf);
    if (replays.length > 0 || guide.replay?.status === 'confirmed') {
      if (replays.length === 0) return step(3, total, 'await-replay', 'The retry was accepted. Loading the new delivery…', [leave]);
      if (d.code === 'confirmed') return finish(guide, s, ctx);
      if (d.code === 'stopped') {
        return step(3, total, 'replay-stopped', 'The new delivery stopped too. Deliver again is available in the journey.', [leave], 'is-failed');
      }
      return step(3, total, 'await-replay',
        'A new delivery of the same alert has started. The stopped delivery stays in the history.', [leave]);
    }
    if (ctx.busy === 'restoring') return step(3, total, 'restoring', 'Restoring the receiver…', []);
    if (ctx.busy === 'replaying') return step(3, total, 'replaying', 'Asking the delivery service to retry…', []);
    if (guide.replay?.status === 'requested') {
      return step(3, total, 'replay-unconfirmed',
        'We could not confirm the retry request. Check again sends the same request, so it cannot start a second retry.',
        [{ id: 'replay-check', label: 'Check again', primary: true }, leave], 'is-waiting');
    }
    if (d.code === 'stopped') {
      return step(3, total, 'rescue',
        'Delivery stopped: every automatic try failed. Press Restore and retry: the receiver is restored first, then the delivery is retried by hand.',
        [{ id: 'restore-retry', label: 'Restore and retry', primary: true }, leave], 'is-failed');
    }
    return step(2, total, 'await-stop',
      `Every try is rejected. Wait until delivery stops${d.max ? ` (${d.triesSoFar ?? 0} of ${d.max} tries used)` : ''}.`, [leave]);
  }

  function finish(guide, s, ctx) {
    return doneStep({ ...guide, stage: 'done' }, s, ctx);
  }

  function doneStep(guide, s, ctx) {
    const v = ctx.view;
    const repeats = v?.processing?.repeats ?? 0;
    const code = v?.processing?.confirmationCode;
    const text = {
      recover: `Delivered on try ${v?.delivery?.triesSoFar ?? '?'}. The rejected tries stay in the history${code ? `, and the receiver processed it once (${code})` : ''}.`,
      twice: repeats > 0
        ? `One processing result${code ? ` (${code})` : ''}. The repeat was recognized and not processed again.`
        : 'Delivered. The receiver\'s record shows one processing result.',
      rescue: 'The new delivery was confirmed. The stopped delivery stays in the history with its failed tries.',
    }[guide.scenario];
    const after = s.mode === 'process_then_timeout'
      ? ' The receiver is still set to "Processes, then replies late"; Normal delivery sets it back.' : '';
    return step(s.steps, s.steps, 'done', text + after,
      [{ id: 'again', label: 'Run it again' }, { id: 'close', label: 'Close guide' }], 'is-done');
  }

  // Where to look while the guide waits for the sandbox (Stage 19): the part of the journey whose state the next step
  // depends on. Steps that need the visitor have none; their turn is shown on the button instead.
  const WATCH = {
    'await-failure': 'delivery', 'await-retry': 'delivery', 'await-stop': 'delivery', 'await-replay': 'delivery',
    'await-timeout': 'receiver', 'await-repeat': 'receiver',
  };
  function guideStep(guide, ctx) {
    const result = stepFor(guide, ctx);
    return { ...result, watch: WATCH[result.phase] ?? null };
  }

  // Whether the guide's step is one where its event is finished (used to decide if the guide is "done").
  const isFinished = (result) => result.phase === 'done';

  const api = { SCENARIOS, guideStep, isFinished };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuideModel = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
