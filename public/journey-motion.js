// Journey motion (Stage 15): illustrative animations on top of the truthful journey.
//
// Two parts:
//  - createPlanner(): pure bookkeeping. Given successive journey views (from journey-model.js) it decides
//    which effects to play. Effects are keyed by stable attempt IDs (`<deliveryId>:<attemptNumber>`) and
//    event IDs, so re-renders, reselecting an alert or a page refresh never replay them. The first time an
//    alert's history is seen (page load, first selection, or after the tab was hidden) it is recorded
//    silently: history is never animated as if it were happening now.
//  - createPlayer(layer): draws the effects in an overlay layer with the Web Animations API, using only
//    transform and opacity. Moving tokens are icon-only and travel in lanes clear of text; node effects are rings
//    around the node, never labels on top of it. Animations are short and bounded, never loop, and never delay the state text,
//    which the page renders independently. They are illustrations, not measurements of real transmission.
//
// Node tests load this file with require() and use only the planner.
(function (root) {
  'use strict';

  // Effect types: accepted, send, ack, error-reply, timeout, no-connection, latest (a finished attempt seen
  // for the first time, shown as a labelled historical illustration), processed, duplicate.
  const OUTCOME_EFFECT = { confirmed: 'ack', error: 'error-reply', timeout: 'timeout', no_connection: 'no-connection' };

  function createPlanner() {
    const seen = new Map();       // attempt key -> last observed attempt code
    const receipts = new Map();   // event id -> { processed, repeats }
    const liveEvents = new Set(); // event ids accepted in this page (for diagnostics)
    let current = null;           // the event whose changes are being watched continuously
    let silenceNext = false;      // set when the tab comes back: record the current state without effects

    function record(view) {
      for (const d of view.deliveries) for (const a of d.attempts) seen.set(a.key, a.code);
      if (['processed', 'not_yet', 'none_recorded'].includes(view.processing.code)) {
        receipts.set(view.eventId, { processed: view.processing.code === 'processed', repeats: view.processing.repeats ?? 0 });
      }
      current = view.eventId;
    }

    return {
      // The visitor's own send was accepted: its attempts are observed live from the start.
      accepted(eventId) {
        current = eventId;
        liveEvents.add(eventId);
        return [{ type: 'accepted', key: `accepted:${eventId}` }];
      },
      // After the tab was hidden, the next observation only records the current state.
      resync() { silenceNext = true; },

      // Returns the effects implied by what changed since the last observation of this event.
      // The first observation after the displayed alert changes (page load, selecting or reselecting an
      // alert, the tab coming back) only records: whatever happened meanwhile is history, not live.
      observe(view) {
        if (!view || !view.server || view.deliveries.length === 0) return []; // nothing reliable to compare yet
        if (silenceNext || view.eventId !== current) {
          silenceNext = false;
          record(view);
          return [];
        }
        const effects = [];
        const all = view.deliveries.flatMap((d) => d.attempts);
        const latestKey = all.at(-1)?.key;
        for (const a of all) {
          const before = seen.get(a.key);
          if (before === a.code) continue;
          if (before === undefined && a.code === 'sending') {
            effects.push({ type: 'send', key: a.key, attempt: a.number });
          } else if (before === 'sending' && OUTCOME_EFFECT[a.code]) {
            effects.push({ type: OUTCOME_EFFECT[a.code], key: a.key, attempt: a.number });
          } else if (before === undefined && OUTCOME_EFFECT[a.code] && a.key === latestKey) {
            // Finished between two refreshes: its outcome is already on screen; this is only a short,
            // labelled look back at it. Older unseen attempts are not illustrated at all.
            effects.push({ type: 'latest', key: a.key, attempt: a.number, outcome: OUTCOME_EFFECT[a.code] });
          }
          seen.set(a.key, a.code);
        }
        const p = view.processing;
        if (['processed', 'not_yet', 'none_recorded'].includes(p.code)) {
          const before = receipts.get(view.eventId);
          const now = { processed: p.code === 'processed', repeats: p.repeats ?? 0 };
          if (now.processed && !before?.processed) effects.push({ type: 'processed', key: `processed:${view.eventId}` });
          else if (now.processed && now.repeats > (before?.repeats ?? 0)) {
            effects.push({ type: 'duplicate', key: `duplicate:${view.eventId}:${now.repeats}` });
          }
          receipts.set(view.eventId, now);
        }
        return effects;
      },

      // For tests and diagnostics.
      isLive: (eventId) => liveEvents.has(eventId),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Player (browser only)

  const MAX_PENDING = 2; // bounded queue: when many updates arrive, older pending effects are dropped
  const TOKEN = 18;      // diameter (CSS px) of a travelling token; app.css .jm-token uses the same size

  function createPlayer(layer, { getGeometry, label }) {
    let running = null;   // { animations: Animation[], elements: Element[] }
    let pending = [];
    const played = new Set(); // effect keys already shown (never twice)

    function clear() {
      if (running) {
        for (const a of running.animations) a.cancel();
        for (const el of running.elements) el.remove();
      }
      running = null;
      layer.replaceChildren();
    }

    function cancelAll() {
      pending = [];
      clear();
    }

    function enqueue(effects) {
      for (const effect of effects) {
        // One attempt can have a live send and later its outcome: deduplicate per effect type and key.
        const id = `${effect.type}|${effect.key}`;
        if (played.has(id)) continue;
        played.add(id);
        pending.push(effect);
      }
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING); // prefer the newest
      if (!running) next();
    }

    function next() {
      const effect = pending.shift();
      if (!effect) { running = null; return; }
      const g = getGeometry();
      if (!g) { next(); return; } // nothing to draw on (journey not visible)
      running = { animations: [], elements: [] };
      const done = draw(effect, g, running);
      Promise.all(done).then(() => {
        for (const el of running?.elements ?? []) el.remove();
        next();
      }, () => { /* cancelled */ });
    }

    // Small helpers that create an element at a point and animate it with transform/opacity only.
    function place(el, x, y, run) {
      el.dataset.motion = 'true';
      layer.append(el);
      const w = el.offsetWidth;
      const hgt = el.offsetHeight;
      el.style.left = `${Math.round(x - w / 2)}px`;
      el.style.top = `${Math.round(y - hgt / 2)}px`;
      run.elements.push(el);
      return el;
    }
    function animate(el, frames, options, run) {
      const anim = el.animate(frames, { fill: 'forwards', easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', ...options });
      run.animations.push(anim);
      return anim.finished;
    }
    function travel(el, from, to, duration, delay, run) {
      place(el, from.x, from.y, run);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      return animate(el, [
        { transform: 'translate(0, 0)', opacity: 0 },
        { transform: `translate(${dx * 0.1}px, ${dy * 0.1}px)`, opacity: 1, offset: 0.15 },
        { transform: `translate(${dx * 0.9}px, ${dy * 0.9}px)`, opacity: 1, offset: 0.85 },
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
      ], { duration, delay }, run);
    }
    function flash(el, at, duration, delay, run) {
      place(el, at.x, at.y, run);
      return animate(el, [
        { opacity: 0, transform: 'translateY(4px) scale(0.96)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.2 },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.8 },
        { opacity: 0, transform: 'translateY(-2px) scale(1)' },
      ], { duration, delay }, run);
    }
    const tag = (cls, text, effect, iconName) => {
      const el = document.createElement('div');
      el.className = `jm ${cls}`;
      el.dataset.effect = effect.type;
      if (effect.key) el.dataset.key = effect.key;
      if (iconName) el.append(label.icon(iconName));
      if (text) el.append(document.createTextNode(text));
      return el;
    };

    // A ring around a node (alert accepted, receiver processed): it lights the node's edge and never covers its text.
    function pulse(el, box, duration, delay, run) {
      el.dataset.motion = 'true';
      Object.assign(el.style, { left: `${Math.round(box.x)}px`, top: `${Math.round(box.y)}px`,
        width: `${Math.round(box.width)}px`, height: `${Math.round(box.height)}px` });
      layer.append(el);
      run.elements.push(el);
      return animate(el, [
        { opacity: 0, transform: 'scale(1)' },
        { opacity: 1, transform: 'scale(1.015)', offset: 0.3 },
        { opacity: 0, transform: 'scale(1.03)' },
      ], { duration, delay }, run);
    }

    // Draws one effect. Returns promises that settle when its animations end. Everything that moves is an icon-only
    // token in a lane clear of text (see journeyGeometry in app.js); the words are already on screen as static text.
    function draw(effect, g, run) {
      const out = [];
      const token = (tone, iconName) => tag(`jm-token ${tone}`, null, effect, iconName);
      const ring = (tone) => tag(`jm-ring ${tone}`, null, effect, null);
      const reply = (outcome, duration, delay) => {
        if (outcome === 'ack') return travel(token('is-done', 'check'), g.ackFrom, g.ackTo, duration, delay, run);
        if (outcome === 'error-reply') return travel(token('is-failed', 'cross'), g.ackFrom, g.ackTo, duration, delay, run);
        // No reply arrived: nothing travels back; a waiting token pulses on the reply path.
        if (outcome === 'timeout') return flash(token('is-waiting', 'hourglass'), g.ackMid, duration + 600, delay, run);
        if (outcome === 'no-connection') return flash(token('is-failed', 'cross'), g.forwardMid, duration + 600, delay, run);
        return null;
      };
      switch (effect.type) {
        case 'accepted':
          out.push(pulse(ring('is-done'), g.alertBox, 900, 0, run));
          break;
        case 'send':
          out.push(travel(token('is-packet', 'mail'), g.forwardFrom, g.forwardTo, 900, 0, run));
          break;
        case 'ack': case 'error-reply': case 'timeout': case 'no-connection':
          out.push(reply(effect.type, 800, 0));
          break;
        case 'processed':
          out.push(pulse(ring('is-done'), g.receiverBox, 1200, 0, run));
          break;
        case 'duplicate':
          out.push(pulse(ring('is-done'), g.receiverBox, 1500, 0, run));
          break;
        case 'latest': {
          // A short historical look back, clearly labelled; it never pretends to be live.
          out.push(flash(tag('jm-history', 'Latest attempt (already finished)', effect, 'clock'), g.top, 1700, 0, run));
          out.push(travel(token('is-packet', 'mail'), g.forwardFrom, g.forwardTo, 600, 150, run));
          const back = reply(effect.outcome, 550, 800);
          if (back) out.push(back);
          break;
        }
        default:
          break;
      }
      return out;
    }

    return {
      enqueue,
      cancelAll,
      isBusy: () => Boolean(running) || pending.length > 0,
    };
  }

  const api = { createPlanner, createPlayer, MAX_PENDING, TOKEN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JourneyMotion = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
