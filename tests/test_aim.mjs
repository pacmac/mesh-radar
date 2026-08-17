// aim: deciding where to point is separate from pointing, and the shared-rotator
// hold ceiling binds every caller. Spec: docs/modules/radio-resolve-and-aim.md.
//
// NOTHING HERE MOVES THE ROTATOR. It is shared with the garage alarm — Peter,
// 2026-08-12: "the rotator has many users, not just node dash, it does NOT have
// exclusive access to it". The two tests that need point() stub the rotator's
// own transport (`_pointOnce`) and its `hold()`, so the REAL clamp in point()
// runs against a fake radio. A test that had to move an antenna would not be run.
import assert from 'node:assert/strict';

const { decideAim, aimAt, resolveAim, bearingToNode } = await import('../src/aim.js');
const { rotator, HOLD_CEILING_MS } = await import('../src/rotator.js');
const { DISCOVERY_LIMITS } = await import('../src/config-api.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

const YAGI = 'F4:12:FA:39:F7:B6';
const steerable    = { mac: YAGI, node_id: '!39f7b6', beam_deg: 35,  directional: true,  steerable: true,  rotatorId: YAGI };
const notSteerable = { mac: 'E9:B0:3F:17:27:91', node_id: '!2687afb1', beam_deg: 360, directional: false, steerable: false, rotatorId: null };

// ── the ceiling is ONE number, in ONE place ─────────────────────────────────
// It was a literal 120 in config-api AND a separate expression in traceroute.
// The form and the pointer could drift apart; now the form imports the pointer's.
eq(DISCOVERY_LIMITS.hold_sec[1], HOLD_CEILING_MS / 1000,
   'the config form bound and the rotator ceiling are the same number');

// ── THE CEILING BINDS EVERY CALLER, not just the one that used to clamp ─────
// This is the finding `shared-rotator-hold-ceiling-lives-in-the-caller`: the
// clamp lived in traceroute, so every other caller of point() was unbounded.
{
  const realPointOnce = rotator._pointOnce;
  const realHold      = rotator.hold;
  let heldMs = null;
  rotator._pointOnce = async () => ({ ok: true, busy: false, timeout: false, err: null, az: 120 });
  rotator.hold       = (ms) => { heldMs = ms; };
  try {
    await rotator.point(120, { hold: 999_999_999, by: 'test', patienceMs: 0 });
    eq(heldMs, HOLD_CEILING_MS,
       'an absurd hold is clamped to the ceiling — an unbounded hold locks the alarm out');

    heldMs = null;
    await rotator.point(120, { hold: 5_000, by: 'test', patienceMs: 0 });
    eq(heldMs, 5_000, 'a hold under the ceiling passes through untouched');

    heldMs = null;
    await rotator.point(120, { hold: HOLD_CEILING_MS, by: 'test', patienceMs: 0 });
    eq(heldMs, HOLD_CEILING_MS, 'exactly the ceiling is allowed — the bound is inclusive');
  } finally {
    rotator._pointOnce = realPointOnce;
    rotator.hold       = realHold;
  }
}

// ── aim NEVER touches the rotator for a radio that cannot be steered ────────
// The old code did a MAC comparison here and got it wrong in both directions.
// Now it is a field read on the resolved bundle.
{
  const realPoint = rotator.point;
  let called = 0;
  rotator.point = async () => { called++; return { ok: true, busy: false, az: 0 }; };
  try {
    const r = await aimAt(notSteerable, 90);
    eq(called, 0,        'aimAt does not point a radio that is not on a rotator');
    eq(r.settled, false, '...and reports unsettled rather than pretending');
    eq(r.azActual, null, '...with no arrived azimuth');

    const r2 = await aimAt(steerable, null);
    eq(called, 0,         'a null azimuth is not a move');
    eq(r2.settled, false, '...and is reported unsettled');
  } finally {
    rotator.point = realPoint;
  }
}

// ── resolveAim: 'none' means none, and an unsteerable radio is recorded honestly
{
  const realPoint = rotator.point;
  let called = 0;
  rotator.point = async () => { called++; return { ok: true, busy: false, az: 0 }; };
  try {
    const none = await resolveAim(1234, 'none', steerable);
    eq(none.mode, 'none',    "want:'none' aims at nothing");
    eq(none.az, null,        '...with no azimuth');
    eq(none.beam_deg, 35,    '...but still reports the transmitting antenna beam width');
    eq(called, 0,            '...and never points');

    // A number is an explicit azimuth, and it must still be refused on a radio
    // that cannot be steered — recorded as 'none', never as a move that happened.
    const fixed = await resolveAim(1234, 90, notSteerable);
    eq(fixed.mode, 'none',   'an explicit azimuth on an unsteerable radio is not an aim');
    eq(fixed.note, 'radio is not on a rotator', '...and the row says why');
    eq(called, 0,            '...and still nothing moved');
  } finally {
    rotator.point = realPoint;
  }
}

// ── decideAim's contract, independent of what the live database holds ───────
// Rule 3b (door_near / endpoint_near) is GATED on the transmitting radio being
// steerable. Peter's rule 3 refused to move an antenna we do not transmit
// through — "the beam is theatre" — and 3b is the exception for when we DO.
// So an unsteerable radio must never reach those two modes, whatever the data.
const MODES = ['none', 'endpoint', 'door', 'bypass', 'door_near', 'endpoint_near'];
for (const num of [1234, 0xda5af428, 646426545]) {
  const d = decideAim(num, notSteerable);
  ok(MODES.includes(d.mode), `decideAim returns a known mode (${d.mode})`);
  ok(d.mode !== 'door_near' && d.mode !== 'endpoint_near',
     'rule 3b must not fire for a radio we cannot steer');
  // An azimuth without a mode, or a mode without an azimuth, is a row that lies
  // about what happened.
  if (d.mode === 'none') eq(d.az, null, "mode 'none' carries no azimuth");
  else                   ok(d.az != null, `mode '${d.mode}' carries an azimuth`);
}

// decideAim is PURE with respect to hardware: it must be callable with no
// rotator reachable at all, which is what makes the policy testable.
{
  const realPoint = rotator.point;
  let called = 0;
  rotator.point = async () => { called++; return {}; };
  try {
    decideAim(1234, steerable);
    eq(called, 0, 'decideAim decides and does not move anything');
  } finally {
    rotator.point = realPoint;
  }
}

// ── bearingToNode returns a compass bearing or null, never NaN ──────────────
for (const num of [1234, 0xda5af428]) {
  const b = bearingToNode(num);
  ok(b === null || (Number.isFinite(b) && b >= 0 && b < 360),
     `bearingToNode(${num}) is a bearing in [0,360) or null, never NaN`);
}

console.log(`test_aim: ${checks} checks passed`);
