// hooks — named, self-describing units of work.
//
// Task `event-log`. Spec: docs/modules/hooks.md
//
// WHY THE CEREMONY EARNS ITS KEEP. Peter, 2026-08-03: "the beauty of hooks is
// they can describe what they are doing… otherwise hooks may just as well be
// small funcs integrated into the core code."
//
// Exactly so. Registration and naming are overhead UNLESS a hook is obliged to
// say what it is and report what it did. That obligation is the entire feature,
// and it is enforced here by throwing rather than by convention.
//
// Every failure found on 2026-08-02/03 was a step that ran and said nothing:
// a mode gate that returned silently for 9.5 hours; an aim that executed
// perfectly at 148 degrees off; a filter that dropped 191 candidates; a master
// switch that sat false for five days. None of those is a missing log line —
// they are steps with no obligation to speak.

import { insertEventLog } from './db.js';

// ONE UNIFORM STRUCTURE. Peter, 2026-08-03: "shouldn't our commanding of the
// pointer also be a hook, instead of buried in the core code... in terms of a
// uniform structure."
//
//   store      really WORKER — runs on a cadence, mines what we already hold.
//              Nothing hooks into it.
//   per-node   announces a decision taken about ONE node.
//   per-mode   announces a decision gated by the dashboard mode.
//   actuator   announces an ACT ON THE WORLD — transmitting, or moving the
//              antenna — emitted at that actuator's OWN single chokepoint so no
//              caller can act silently and no future caller has to remember to.
//
// `actuator` replaced a narrower `transmit` scope added earlier the same day.
// Two names for "acts on the world" is precisely the non-uniformity Peter is
// pointing at, and it cost nothing to fold: event_log held 0 rows of the old
// kind because the callout engine ships disabled.
const SCOPES = ['store', 'per-node', 'per-mode', 'actuator'];

// ADDRESSABLE BY SCOPE, THEN BY NAME. Peter, 2026-08-03: "shouldnt hooks be an
// object: {'per-node':{do this(), do that()}, xxx:{xxx(), yyy()} - effectively
// addressable".
//
// Right, and it changes how consumers read. A flat list makes every caller
// filter; this makes the grouping structural:
//
//     for (const h of Object.values(hooks['per-node'])) ...   // the probe steps
//     hooks['per-node']['select-target'].emit({...})          // one, by name
//
// Insertion order is preserved for string keys, so REGISTRATION ORDER IS
// EXECUTION ORDER for a scope's hooks. That is deliberate and load-bearing for
// `per-node`, whose steps are a sequence — declare them in the order they run.
export const hooks = { store: {}, 'per-node': {}, 'per-mode': {}, actuator: {} };

// Names stay globally unique even though the object is nested: `source` in
// event_log is a bare name, and two hooks sharing one would make the log
// ambiguous exactly where it is read.
const _names = new Set();

// LIVE PUSH. Peter wants the board to feel alive; an event that only lands in a
// table is not alive until something carries it. Subscribers are notified after
// the row is written, so a listener never sees an event the database does not
// have. Core announces; the plugin subscribes — same shape as
// registerSettingsListener, and this file names no consumer.
const _listeners = [];
export function onEvent(fn) { _listeners.push(fn); }

function _announce(row) {
  for (const fn of _listeners) {
    // Isolated: a dead socket must not break the next listener, nor the work
    // that emitted.
    try { fn(row); } catch (e) { console.error(`[hooks] listener failed: ${e.message}`); }
  }
}

/** Register a hook. Throws unless it declares what it is.
 *
 *  The throw is the point. "Add a step that says nothing" must be IMPOSSIBLE,
 *  not merely discouraged — a convention is exactly what failed all through
 *  2026-08-02/03.
 *
 *  scope decides the trigger and what the hook is handed:
 *    store     a cadence, the whole database   (ghost-relays, asymmetric-paths)
 *    per-node  a probe_id and one target       (select, history, dispatch)
 *    per-mode  only the modes that permit it   (passive tracing, scanner)
 *
 *  `per-mode` is today's headline bug made structural. Passive tracing carried
 *  its rule as a bare `dashMode.value !== 0` inside the consumer; declaring
 *  modes here puts the list somewhere enumerable and stops a hook holding a
 *  hidden mode check. A declared scope can be inspected; an inline conditional
 *  cannot.
 */
export function defineHook({ name, purpose, scope, modes = null } = {}) {
  if (!name || typeof name !== 'string')       throw new Error('defineHook: name is required');
  if (!purpose || typeof purpose !== 'string') throw new Error(`defineHook(${name}): purpose is required — a hook that cannot say what it is for is a function`);
  if (!SCOPES.includes(scope))                 throw new Error(`defineHook(${name}): scope must be one of ${SCOPES.join(', ')}`);
  // `modes` may be a FUNCTION, resolved on first read. A per-mode hook usually
  // derives its list from dash-mode, and calling that during module evaluation
  // hit a circular-import TDZ error that took the service down on 2026-08-03.
  // A thunk defers the read to after every module has initialised.
  if (scope === 'per-mode') {
    const ok = typeof modes === 'function' || (Array.isArray(modes) && modes.length);
    if (!ok) throw new Error(`defineHook(${name}): scope 'per-mode' must declare which modes it runs in`);
  }
  if (_names.has(name)) throw new Error(`defineHook: ${name} is already registered`);

  const hook = {
    name, purpose, scope,
    get modes() { return typeof modes === 'function' ? modes() : modes; },
    /** Report what happened. `summary` is written HERE, at the decision site —
     *  never composed downstream, because a trace assembled elsewhere
     *  reintroduces the hiding this exists to end.
     *
     *  REPORTING NOTHING FOUND IS MANDATORY. "82 route members checked, 0
     *  unknown" is evidence; silence is indistinguishable from the hook being
     *  broken, which is precisely how the passive tracer failed. */
    emit({ summary, detail = null, severity = 'info', probe_id = null } = {}) {
      if (!summary) return;                       // nothing to say is a caller bug, not a crash
      try {
        const row = {
          ts:       Math.floor(Date.now() / 1000),
          // SCOPE IS NOT KIND, and conflating them mis-filed real events.
          // Peter, 2026-08-03: "should it be a hook? — not sure and maybe hook
          // is the wrong term, should be 'workers'?" He is right, and this line
          // is the evidence: `store` was doing double duty, meaning both
          // "operates on the whole store" AND "runs on a cadence". A public
          // transmission is neither, so `callout-sent` was being filed as
          // kind 'task' beside "58 nodes have never been traced".
          kind:     scope === 'per-node' ? 'probe'
                  : scope === 'per-mode' ? 'mode'
                  : scope === 'actuator' ? 'action'
                  : 'task',
          severity,
          summary,
          detail:   detail == null ? null : JSON.stringify(detail),
          source:   name,
          probe_id,
        };
        insertEventLog(row);
        _announce(row);
      } catch (e) {
        // A BROKEN LOG MUST NOT STOP THE WORK IT DESCRIBES. Emitting runs inside
        // the discovery loop; a full disk or a locked database must cost us a
        // log line, never a probe.
        console.error(`[hooks] ${name} emit failed: ${e.message}`);
      }
    },
  };
  _names.add(name);
  hooks[scope][name] = hook;
  return hook;
}

/** THE PIPELINE, ENUMERABLE. Answers "what does this system execute, and what
 *  does each step claim to do?" without reading code — the direct answer to
 *  Peter's complaint that the logic is hidden, and something logging alone
 *  cannot provide. */
export function listHooks() {
  return SCOPES.flatMap(s => Object.values(hooks[s]))
    .map(({ name, purpose, scope, modes }) => ({ name, purpose, scope, modes }));
}

export function getHook(name) {
  for (const s of SCOPES) if (hooks[s][name]) return hooks[s][name];
  return null;
}

/** Direct path for events that are not hook emissions — a config write, a boot.
 *  Same isolation rule: logging must never throw into the caller. */
export function logEvent({ kind, severity = 'info', summary, detail = null, source = null, probe_id = null } = {}) {
  if (!kind || !summary) return;
  try {
    const row = {
      ts: Math.floor(Date.now() / 1000),
      kind, severity, summary,
      detail: detail == null ? null : JSON.stringify(detail),
      source, probe_id,
    };
    insertEventLog(row);
    _announce(row);
  } catch (e) {
    console.error(`[hooks] logEvent(${kind}) failed: ${e.message}`);
  }
}

/** One probe's steps share an id so the trace can be grouped. Time-ordered and
 *  human-legible on purpose — this ends up on screen beside the events it
 *  groups. Date.now() base 36 keeps it short and sortable. */
export function newProbeId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}
