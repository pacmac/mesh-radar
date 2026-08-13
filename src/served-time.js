// Ages and countdowns, pushed at the instant they change. EVENT DRIVEN, NOT POLLED.
//
// Spec: docs/modules/served-time.md
//
// Peter, 2026-08-13: "NO TIMERS, NO POLLING FULL STOP. WS OR NOTHING", then
// "EVENT DRIVEN NOT POLLED".
//
// WHAT THIS REPLACES, and why the previous version was still wrong. ws-relay
// already pushed re-aged strings from two setIntervals at 1000 ms, each of which
// woke, recomputed, compared, and threw the result away when nothing had
// changed. That is a poll wearing a push's clothes: for a two-hour-old reading
// it is 3,600 wakes to produce one change.
//
// fmtAgo's output changes at instants that are a PURE FUNCTION of the timestamp
// (format.js:95-102) — every 1 s under a minute, 60 s under an hour, then hourly,
// then daily. So the next transition is COMPUTABLE, not discoverable by looking.
// Schedule exactly one timer for it, push, schedule the next. One wake per
// change, at every age, forever.

import { fmtAgo, fmtUntil } from './format.js';

const MINUTE = 60, HOUR = 3600, DAY = 86400;

/** Seconds until fmtAgo(ts) renders something different.
 *
 *  Never returns 0 — a zero delay would busy-loop the event loop rather than
 *  schedule. The floor is the smallest interval fmtAgo can distinguish. */
export function nextAgoTransition(ts, nowSec = Math.floor(Date.now() / 1000)) {
  const s = Math.max(0, nowSec - Number(ts));
  if (s < MINUTE) return 1;                          // "Ns ago", ticks every second
  if (s < HOUR)   return MINUTE - (s % MINUTE);      // to the next whole minute
  if (s < DAY)    return HOUR   - (s % HOUR);        // to the next whole hour
  return DAY - (s % DAY);                            // to the next whole day
}

/** The mirror, for a FUTURE instant. Deliberately separate because fmtUntil is:
 *  fmtAgo clamps negatives to "0s ago", which on a countdown reads as "now" —
 *  the opposite of the truth (format.js:104-114). */
export function nextUntilTransition(ts, nowSec = Math.floor(Date.now() / 1000)) {
  const s = Math.max(0, Number(ts) - nowSec);
  if (s <= MINUTE) return 1;
  if (s <= HOUR)   return ((s - 1) % MINUTE) + 1;
  if (s <= DAY)    return ((s - 1) % HOUR) + 1;
  return ((s - 1) % DAY) + 1;
}

/** Push `onChange(text)` every time the rendered string changes, and at no other
 *  moment. Returns an idempotent stop().
 *
 *  WIRE stop() TO ws.once('close'). A socket that closes with a pending timer
 *  keeps this closure — and the payload it captured — alive per dead connection.
 *
 *  `kind` picks the formatter and its transition rule: 'ago' for a past instant,
 *  'until' for a future one. Passing the wrong one is the countdown bug above,
 *  so it is an explicit argument rather than inferred from the sign.
 */
export function scheduleTime(ts, onChange, { kind = 'ago', clock = Date } = {}) {
  const fmt  = kind === 'until' ? fmtUntil : fmtAgo;
  const next = kind === 'until' ? nextUntilTransition : nextAgoTransition;

  let timer = null, stopped = false, last = null;

  const arm = () => {
    if (stopped) return;
    const nowSec = Math.floor(clock.now() / 1000);
    const delay  = Math.max(1, next(ts, nowSec));
    timer = setTimeout(() => {
      if (stopped) return;
      const text = fmt(ts, Math.floor(clock.now() / 1000));
      // A guard, NOT a poll: the schedule already guarantees a change, so this
      // only fires if the process was suspended past a boundary. If it ever
      // fires routinely, the transition maths is wrong and should be fixed here
      // rather than absorbed by a comparison.
      if (text !== last) { last = text; onChange(text); }
      arm();
    }, delay * 1000);
    if (typeof timer.unref === 'function') timer.unref();   // never hold the process open
  };

  last = fmt(ts, Math.floor(clock.now() / 1000));
  arm();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
