// ── Probe plans — a tunable sequence per endpoint class ─────────────────────
//
// Peter, 2026-08-05:
//
//   "the traceroute for different classes based on distance, proximity etc can
//    include a route table array with key-verbs as a list of sequential actions
//    / methods. this will also allow us to tweak them without needing to touch
//    the source code."
//
//   "we may find that repeating a step in the array or switching them around
//    gives better results, but the hard part will be in defining the verbs and
//    probably args for maybe repetitions."
//
// WHY THIS EXISTS, in one measurement: over 30 days, 443 targets were attempted
// more than once for a total of 21,395 attempts — and by construction every
// repeat was the SAME experiment. The aim was derived from (target, mode) with
// no attempt index, so attempt 40 was identical to attempt 1.
//
// Meanwhile callout.js has varied its probe per target since the day it was
// built (`eligibleTemplates` picks a template NOT recently used on that node).
// The machinery existed next door and traceroute never used it.
//
// THE SEQUENCE IS A SCHEDULE, NOT A SCRIPT.
//
// Repetition, not variation, is where the yield is. Measured over 30 days:
//
//   targets attempted            560
//   never answered               454  (81.1%)
//   answered on the FIRST try     19  ( 3.4%)
//   answered only on a LATER try  87  (15.5%)   <- 82% of all successes
//
//   gap between the failed attempt and the one that worked:
//   p25 29 min · median 62 min · p75 5.6 h · p90 63 h
//
// So a step can say "try again in an hour", which means the position in the
// sequence must SURVIVE RESTARTS. traceroute._pending is an in-memory Map and
// dies on every restart — and pm2 watches src/, so it dies whenever either of us
// edits a file. Hence a table.
//
// TWO KINDS OF VARIATION, deliberately separated:
//   spatial   aim / radio / target  — "we do not know the path"
//   temporal  repeat / every_min    — "they were not listening"
// The measurement says temporal dominates, so a plan that only varies the aim
// is optimising the minority case.

import db, { getConfig } from './db.js';

// ── the verb vocabulary ──────────────────────────────────────────────────────
//
// Small and CLOSED. An open-ended DSL in a config file becomes a programming
// language nobody can validate, and the failure mode is a silently-ignored step.
export const VERBS = {
  aim:    ['auto', 'door', 'endpoint', 'bypass', 'none'],
  radio:  ['auto', 'omni', 'yagi'],
  // WHAT WE TRACEROUTE, which is not the same as what we point at. Pointing at a
  // relay only biases who hears us — the mesh still chooses the path. Tracerouting
  // the RELAY ITSELF proves the direct link outright, and that is the cheap
  // experiment nothing currently runs.
  target: ['endpoint', 'door', 'hop2'],
};

export const STEP_KEYS = ['aim', 'radio', 'target', 'repeat', 'every_min', 'timeout_sec'];

// Defaults are a starting point, not a recommendation — the whole purpose is
// that Peter tunes them without touching this file.
const DEFAULT_PLANS = {
  // Never attempted and beyond the record: the only success that means anything
  // is a DIRECT contact, so lead with the endpoint bet and repeat it across wake
  // windows before spending anything exotic.
  'unknown-record': [
    { aim: 'endpoint', radio: 'auto', target: 'endpoint', repeat: 3, every_min: 60 },
    { aim: 'auto',     radio: 'yagi', target: 'endpoint', repeat: 2, every_min: 180 },
  ],
  // Beating the proven distance: follow the working path first, then try to
  // shorten it.
  record: [
    { aim: 'auto', radio: 'auto', target: 'endpoint', repeat: 3, every_min: 60 },
    { aim: 'auto', radio: 'yagi', target: 'hop2',     repeat: 1 },
  ],
  // Re-confirming ground we already hold. Cheap, never rotates.
  reconfirm: [
    { aim: 'none', radio: 'auto', target: 'endpoint', repeat: 1, every_min: 360 },
  ],
  // A repeat of a failed probe proves nothing. This class exists to VARY.
  retry: [
    { aim: 'auto',     radio: 'auto', target: 'endpoint', repeat: 2, every_min: 60 },
    { aim: 'endpoint', radio: 'yagi', target: 'endpoint', repeat: 2, every_min: 120 },
    { aim: 'auto',     radio: 'auto', target: 'door',     repeat: 1 },
  ],
  default: [
    { aim: 'auto', radio: 'auto', target: 'endpoint', repeat: 2, every_min: 60 },
  ],
};

export function plans() {
  return { ...DEFAULT_PLANS, ...(getConfig('probe_plans', {}) || {}) };
}

export function planFor(cls) {
  const p = plans();
  return p[cls] || p.default || DEFAULT_PLANS.default;
}

/** Validate a plan before it is stored. A config that can express nonsense will
 *  eventually contain nonsense, and a silently-ignored step is the worst outcome
 *  — it looks like it ran. */
export function validatePlan(steps) {
  const errs = [];
  if (!Array.isArray(steps) || !steps.length) return ['plan must be a non-empty array'];
  steps.forEach((s, i) => {
    for (const k of Object.keys(s)) {
      if (!STEP_KEYS.includes(k)) errs.push(`step ${i}: unknown key '${k}'`);
    }
    for (const k of ['aim', 'radio', 'target']) {
      if (s[k] !== undefined && !VERBS[k].includes(s[k]))
        errs.push(`step ${i}: ${k}='${s[k]}' not one of ${VERBS[k].join('|')}`);
    }
    for (const [k, min, max] of [['repeat', 1, 20], ['every_min', 0, 10080], ['timeout_sec', 5, 600]]) {
      if (s[k] !== undefined && !(Number(s[k]) >= min && Number(s[k]) <= max))
        errs.push(`step ${i}: ${k} must be ${min}..${max}`);
    }
  });
  return errs;
}

// ── durable per-target position ──────────────────────────────────────────────

export function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_state (
      to_num      INTEGER PRIMARY KEY,
      plan_class  TEXT,
      step_index  INTEGER NOT NULL DEFAULT 0,
      step_tries  INTEGER NOT NULL DEFAULT 0,
      last_ts     INTEGER,
      updated_at  INTEGER
    )`);
}

export function stateFor(num) {
  ensureSchema();
  return db.prepare('SELECT * FROM probe_state WHERE to_num = ?').get(num) ?? null;
}

/** The step to run for this target NOW, or null with a reason.
 *
 *  Returns null when the plan says WAIT — that is not a failure, it is the
 *  schedule working. The caller must move to another target rather than
 *  hammering this one.
 */
export function nextStep(num, cls, now = Math.floor(Date.now() / 1000)) {
  ensureSchema();
  const plan = planFor(cls);
  const st = stateFor(num);
  // A class change restarts the plan: the target is a different kind of question
  // than it was, so its position in the old sequence means nothing.
  let idx = (st && st.plan_class === cls) ? st.step_index : 0;
  let tries = (st && st.plan_class === cls) ? st.step_tries : 0;
  if (idx >= plan.length) return { step: null, reason: 'plan exhausted', index: idx };

  let step = plan[idx];
  const repeat = Number(step.repeat ?? 1);
  if (tries >= repeat) {                       // this step is done, advance
    idx += 1; tries = 0;
    if (idx >= plan.length) return { step: null, reason: 'plan exhausted', index: idx };
    step = plan[idx];
  }
  const every = Number(step.every_min ?? 0) * 60;
  if (every > 0 && st?.last_ts && (now - st.last_ts) < every) {
    return { step: null, reason: 'waiting', index: idx,
             ready_in_sec: every - (now - st.last_ts) };
  }
  return { step, index: idx, tries, plan_class: cls, of: plan.length };
}

/** Record that a step was dispatched. Called at DISPATCH time, not at result
 *  time — a step that was tried and timed out has still been tried, and not
 *  advancing on a timeout is how a plan gets stuck on step 0 forever. */
export function recordAttempt(num, cls, index, now = Math.floor(Date.now() / 1000)) {
  ensureSchema();
  const st = stateFor(num);
  const same = st && st.plan_class === cls && st.step_index === index;
  db.prepare(`INSERT INTO probe_state (to_num, plan_class, step_index, step_tries, last_ts, updated_at)
              VALUES (@n, @c, @i, @t, @ts, @ts)
              ON CONFLICT(to_num) DO UPDATE SET
                plan_class=@c, step_index=@i, step_tries=@t, last_ts=@ts, updated_at=@ts`)
    .run({ n: num, c: cls, i: index, t: same ? st.step_tries + 1 : 1, ts: now });
}

/** A reply ends the plan for this target — there is nothing further to learn
 *  from probing something that just answered. */
export function clearState(num) {
  ensureSchema();
  db.prepare('DELETE FROM probe_state WHERE to_num = ?').run(num);
}
