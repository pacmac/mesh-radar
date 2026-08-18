// aim: deciding where to point is separate from pointing, the target is the node
// or its relay, and the shared-rotator hold ceiling binds every caller.
// Spec: docs/modules/traceroute-flow.md, docs/modules/radio-resolve-and-aim.md.
//
// NOTHING HERE MOVES THE ROTATOR. It is shared with the garage alarm — Peter,
// 2026-08-12: "the rotator has many users, not just node dash, it does NOT have
// exclusive access to it". Every test that reaches point() stubs the rotator's
// own transport (`_pointOnce`) and its `hold()`, so the REAL clamp and the REAL
// retry loop run against a fake radio. A test that had to move an antenna would
// not get run, and an unrun test is not a test.
import assert from 'node:assert/strict';

const { decideAim, aimAt, aimForNode, bearingToNode, parseVia } = await import('../src/aim.js');
const { rotator, HOLD_CEILING_MS } = await import('../src/rotator.js');
const { DISCOVERY_LIMITS } = await import('../src/config-api.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

const YAGI = 'F4:12:FA:39:F7:B6';
const steerable    = { mac: YAGI, node_id: '!39f7b6', beam_deg: 35,  directional: true,  steerable: true,  rotatorId: YAGI };
const notSteerable = { mac: 'E9:B0:3F:17:27:91', node_id: '!2687afb1', beam_deg: 360, directional: false, steerable: false, rotatorId: null };
const fixedYagi    = { mac: 'AA:BB:CC:DD:EE:FF', node_id: '!aabbcc', beam_deg: 40, directional: true, steerable: false, rotatorId: null };

/** Run fn with the rotator's transport stubbed. Returns what point() was told. */
async function withStubbedRotator(fn, pointResult = { ok: true, busy: false, timeout: false, err: null, az: 120 }) {
  const realPointOnce = rotator._pointOnce;
  const realHold      = rotator.hold;
  const seen = { holds: [], points: 0 };
  rotator._pointOnce = async (az) => { seen.points++; return { ...pointResult, az: pointResult.az ?? az }; };
  rotator.hold       = (ms) => { seen.holds.push(ms); };
  try { seen.value = await fn(); } finally {
    rotator._pointOnce = realPointOnce;
    rotator.hold       = realHold;
  }
  return seen;
}

// ── the ceiling is ONE number, in ONE place ─────────────────────────────────
eq(DISCOVERY_LIMITS.hold_sec[1], HOLD_CEILING_MS / 1000,
   'the config form bound and the rotator ceiling are the same number');

// ── THE CEILING BINDS EVERY CALLER ─────────────────────────────────────────
// It used to be enforced inside traceroute, so every other point() caller was
// unbounded. This matters more now that the hold is the traceroute TIMEOUT.
{
  let s = await withStubbedRotator(() => rotator.point(120, { hold: 999_999_999, by: 'test', patienceMs: 0 }));
  eq(s.holds[0], HOLD_CEILING_MS, 'an absurd hold is clamped — an unbounded hold locks the alarm out');

  s = await withStubbedRotator(() => rotator.point(120, { hold: 5_000, by: 'test', patienceMs: 0 }));
  eq(s.holds[0], 5_000, 'a hold under the ceiling passes through untouched');

  s = await withStubbedRotator(() => rotator.point(120, { hold: HOLD_CEILING_MS, by: 'test', patienceMs: 0 }));
  eq(s.holds[0], HOLD_CEILING_MS, 'exactly the ceiling is allowed — the bound is inclusive');
}

// ── aimAt(bearing, hold) — Peter's two-argument signature ───────────────────
eq(aimAt.length, 2, 'aimAt takes bearing and hold as positional arguments');
{
  // THE HOLD IS THE CALLER'S ARGUMENT, not config. Peter, 2026-08-18: "aim
  // accepts min 2 args bearing and hold time ... which is the same as the
  // timeout passed to traceroute."
  const s = await withStubbedRotator(() => aimAt(90, 60_000, { patience_ms: 0 }));
  eq(s.holds[0], 60_000, 'the hold passed to aimAt reaches the rotator unchanged');
  eq(s.value.settled, true, 'a clean point is settled');
  eq(s.value.azActual, 120, 'the ARRIVED azimuth is reported, not the requested one');
}
{
  const s = await withStubbedRotator(() => aimAt(90, null, { patience_ms: 0 }));
  ok(s.holds[0] !== undefined || s.points === 1,
     'with no hold argument aimAt still points, falling back to config');
}
{
  const s = await withStubbedRotator(() => aimAt(null, 60_000));
  eq(s.points, 0, 'a non-numeric bearing is not a move');
  eq(s.value.settled, false, '...and is reported unsettled');
}

// ── a busy rotator is NOT settled ──────────────────────────────────────────
// This is what makes traceroute refuse to dispatch, so it must be exact.
{
  const s = await withStubbedRotator(
    () => aimAt(90, 30_000, { patience_ms: 0 }),
    { ok: false, busy: true, timeout: false, err: null, az: 200 });
  eq(s.value.settled, false, 'a busy rotator is not a confirmed aim');
}

// ── decideAim: the node, or its relay. Two branches, no more ───────────────
// Peter, 2026-08-18: "aims the antenna EITHER at the node or it's relay node."
const MODES = ['none', 'node', 'relay'];
for (const num of [1234, 0xda5af428, 646426545]) {
  const d = decideAim(num, steerable);
  ok(MODES.includes(d.mode), `decideAim returns node|relay|none, got '${d.mode}'`);
  if (d.mode === 'none') eq(d.az, null, "mode 'none' carries no azimuth");
  else                   ok(d.az != null && d.az >= 0 && d.az < 360, `mode '${d.mode}' carries a real bearing`);
}
// The retired rules must not come back silently.
for (const num of [1234, 0xda5af428]) {
  const m = decideAim(num, steerable).mode;
  ok(!['door', 'door_near', 'endpoint', 'endpoint_near', 'bypass'].includes(m),
     `retired rule '${m}' must not fire — target is node-or-relay only`);
}

// decideAim is PURE with respect to hardware.
{
  const s = await withStubbedRotator(async () => { decideAim(1234, steerable); return null; });
  eq(s.points, 0, 'decideAim decides and moves nothing');
}

// ── aimForNode: only a STEERABLE radio is aimed ────────────────────────────
{
  const s = await withStubbedRotator(() => aimForNode(1234, notSteerable, 60_000));
  eq(s.points, 0, 'an omni is never pointed');
  eq(s.value.settled, false, '...and is reported unsettled');
  eq(s.value.note, 'radio is not on a rotator', '...with the reason on the row');
}
{
  // A DIRECTIONAL antenna that is NOT on a rotator — a real configuration that
  // the pre-2026-08-17 code could not express at all.
  const s = await withStubbedRotator(() => aimForNode(1234, fixedYagi, 60_000));
  eq(s.points, 0, 'a fixed directional antenna cannot be aimed');
  eq(s.value.beam_deg, 40, '...but its beamwidth is still reported for the row');
}
{
  const s = await withStubbedRotator(() => aimForNode(646426545, steerable, 45_000, { patience_ms: 0 }));
  eq(s.holds[0], 45_000, 'aimForNode passes its hold straight through to the rotator');
  ok(['node', 'relay'].includes(s.value.mode), 'the row records which branch fired');
  eq(s.value.beam_deg, 35, 'the TRANSMITTING antenna beamwidth is recorded');
}

// ── `via` — an explicit aim override ───────────────────────────────────────
// Peter, 2026-08-18: "if via is set, the traceroute will go via that node, again
// this only applies to directional antennas." It is an AIM target: Meshtastic
// has no source routing and send_traceroute(to) carries only the target, so the
// beam is the only mechanism there is.
{
  const TA2M = 3663393832;
  const bTa2m = bearingToNode(TA2M);

  // via must BEAT the rule that would otherwise apply, whichever branch that is.
  for (const target of [1234, 0xda5af428, 646426545]) {
    const d = decideAim(target, steerable, TA2M);
    if (bTa2m == null) { ok(d.mode === 'none', 'via with no bearing refuses'); continue; }
    eq(d.mode, 'via',         `via overrides the derived target for ${target}`);
    eq(d.aimTarget, TA2M,     '...and aims at the via node');
    eq(d.az, bTa2m,           "...at the via node's own bearing");
  }

  // AN UNRESOLVABLE via REFUSES AND DOES NOT FALL BACK. Falling through to the
  // node/relay rule would transmit while silently ignoring an explicit
  // instruction, and write a row that looks deliberate.
  const bad = decideAim(646426545, steerable, 999_999_999);
  eq(bad.mode, 'none',        'a via with no resolvable bearing does not aim');
  eq(bad.az, null,            '...and carries no azimuth');
  ok(/via 999999999/.test(bad.note ?? ''), '...and names the via node as the problem, not the target');

  // The refusal must reach aimForNode as a refusal, with that same note.
  const s = await withStubbedRotator(() => aimForNode(646426545, steerable, 30_000, { via: 999_999_999 }));
  eq(s.points, 0,             'an unhonourable via points nothing');
  ok(/via 999999999/.test(s.value.note ?? ''), '...and the row records why');

  // With no via, the derived rule is untouched.
  const plain = decideAim(646426545, steerable);
  ok(['node', 'relay', 'none'].includes(plain.mode), 'without via the node/relay rule is unchanged');
}

// ── `via` as a BEARING — the radar-cluster case ────────────────────────────
// Peter, 2026-08-18: "we need to able to force a traceroute via a node or via a
// bearing. so I might look at the radar and see a cluster and attempt to route
// via them by a bearing / angle."
{
  const GZG = 80054436;   // relayed — without via its beam would go to the relay

  // A bare number in 0..360 is a BEARING, and it beats whatever the route says.
  const b = decideAim(GZG, steerable, 90);
  eq(b.mode, 'bearing',   'a bare 0-360 number is a bearing, not a node');
  eq(b.az, 90,            '...and is used verbatim');
  eq(b.aimTarget, null,   'a bearing has NO node identity — claiming one would be a lie in the row');

  eq(decideAim(GZG, steerable, 0).az, 0,   'bearing 0 is due north, not "absent"');
  eq(decideAim(GZG, steerable, 360).az, 0, '360 normalises to 0 rather than being read as a node');

  // Above the bearing range it is a node again.
  eq(parseVia(3663393832).kind, 'node', 'a large number is a node num');
  eq(parseVia('!da5af428').kind, 'node', 'a !hex id is a node');
  eq(parseVia(219).kind, 'bearing',      '219 is a bearing');

  // The EXPLICIT forms escape the range rule in both directions.
  const fb = parseVia({ bearing: 219 }); eq(fb.kind, 'bearing', '{bearing} forces a bearing');
  const fn = parseVia({ node: 219 });    eq(fn.kind, 'node',    '{node} forces a node, inside the bearing range');
  eq(fn.num, 219,                                              '...with the number intact');

  // THE COLLISION GUARD. Cannot fire against the live store (no node is below
  // 360 — smallest measured 2026-08-18 is 3,119,745), so it is driven here.
  const clash = parseVia(219, (n) => n === 219);
  ok(clash?.error && /ambiguous/.test(clash.error), 'a number that is BOTH a bearing and a known node is refused');
  ok(/\{"bearing":219\}/.test(clash.error) && /\{"node":219\}/.test(clash.error),
     '...and the refusal shows both explicit forms');

  // Malformed input is an error, never a silent zero — 0 is due north.
  ok(parseVia('nonsense')?.error, 'an unparseable via is an error');
  ok(parseVia({})?.error,         'a via object with neither node nor bearing is an error');
  eq(parseVia(null), null,        'no via is not an error, it is simply absent');

  // A bearing needs no lookup, so it is always honourable — it must reach the
  // rotator even for a target we know nothing about.
  const s = await withStubbedRotator(() => aimForNode(999_999_999, steerable, 20_000, { via: 137 }));
  eq(s.value.mode, 'bearing', 'a bearing aims even when the TARGET is unknown');
  eq(s.value.az, 137,         '...at exactly the bearing given');
  ok(s.points >= 1,           '...and the rotator is actually commanded');
}

// ── bearingToNode is a bearing or null, never NaN ──────────────────────────
for (const num of [1234, 0xda5af428]) {
  const b = bearingToNode(num);
  ok(b === null || (Number.isFinite(b) && b >= 0 && b < 360),
     `bearingToNode(${num}) is in [0,360) or null, never NaN`);
}

console.log(`test_aim: ${checks} checks passed`);
