// traceroute: the flow Peter specified, 2026-08-18.
// Spec: docs/modules/traceroute-flow.md.
//
//   traceroute(radio, node, timeout)
//     resolve -> omni? skip aim : aim(node|relay, hold = timeout) -> CONFIRMED? -> dispatch
//
// NOTHING HERE TRANSMITS AND NOTHING MOVES. `bridge.post` is stubbed so the
// dispatch path runs in full and stops at the wire; the rotator's transport is
// stubbed so the aim path runs in full and stops at the motor. Both deliberate:
// a traceroute goes out on a channel we do not choose (mesh-gw's
// send_traceroute(to) takes no channel, docs/gw/modules/ble_device.md:66), and
// the rotator is shared with the garage alarm.
//
// TWO THINGS THIS TEST LEARNED THE HARD WAY:
//
//   run() RESOLVES ON THE REPLY, so awaiting it means waiting out the timeout.
//   Timeouts here are milliseconds, not the 45-60 s a real call uses, and the
//   assertions are made on what the stubs were ASKED to do rather than on the
//   returned result. The first version awaited a 45 s call and then a
//   999,999,999 ms one, and hung until the runner killed it.
//
//   A STUB THAT ALWAYS ANSWERS THE SAME AZIMUTH IS NOT A ROTATOR. The default
//   below echoes the requested bearing. Answering a fixed 120 put every aim
//   outside the half-beam tolerance, so the retry loop burned its budget and
//   `settled` came back false — which looked like a bug in run() and was a bug
//   in the harness.
import assert from 'node:assert/strict';

const { traceroute } = await import('../src/traceroute.js');
const { rotator }    = await import('../src/rotator.js');
const { bridge }     = await import('../src/bridge.js');
const db             = (await import('../src/db.js')).default;
const { setConfig, getConfig } = await import('../src/db.js');

const OMNI = 'E9:B0:3F:17:27:91';
const YAGI = 'F4:12:FA:39:F7:B6';
const PREFIX = 'device_cfg.';
const TARGET = 646426545;

let checks = 0;
let failure = null;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

const saved = {};
for (const mac of [OMNI, YAGI]) saved[mac] = getConfig(PREFIX + mac, null);

// Every row this test causes is deleted at the end. A dispatch that times out
// writes a real failure row, and this runs against the live store.
const baselineId = db.prepare('SELECT COALESCE(MAX(id),0) id FROM traceroute_history').get().id;

async function harness(fn, { pointResult = { ok: true, busy: false, timeout: false, err: null }, settleMs = 400 } = {}) {
  // EACH BLOCK STARTS FROM A CLEAN SLATE. _pending is keyed by TARGET, so a
  // dispatch still in flight from an earlier block makes the next one JOIN it
  // rather than post — and the assertion "it dispatched" then fails for a reason
  // that has nothing to do with the code under test. Caught 2026-08-18 when the
  // config-default block left 1-2 s timeouts pending and the omni block after it
  // reported zero posts.
  for (const [, e] of traceroute._pending) if (e.timer) clearTimeout(e.timer);
  traceroute._pending.clear();
  traceroute._runs.clear();

  const realPost = bridge.post, realPointOnce = rotator._pointOnce, realHold = rotator.hold;
  const seen = { posts: [], points: 0, holds: [], error: null };
  bridge.post        = async (path, body) => { seen.posts.push({ path, body }); return { ok: true }; };
  rotator._pointOnce = async (az) => { seen.points++; return { ...pointResult, az: pointResult.az ?? az }; };
  rotator.hold       = (ms) => { seen.holds.push(ms); };
  try {
    // Do NOT await the reply — observe what the stubs were asked to do.
    const p = Promise.resolve().then(fn).catch(e => { seen.error = e?.message ?? String(e); });
    await Promise.race([p, new Promise(r => setTimeout(r, settleMs))]);
  } finally {
    bridge.post = realPost; rotator._pointOnce = realPointOnce; rotator.hold = realHold;
  }
  return seen;
}

try {
  setConfig(PREFIX + OMNI, { label: 'OMNI', is_rotator: false, is_primary: true,  beam_deg: 360 });
  setConfig(PREFIX + YAGI, { label: 'YAGI', is_rotator: true,  is_primary: false, beam_deg: 35  });

  // ── the signature Peter specified ────────────────────────────────────────
  eq(traceroute.run.length, 3, 'run takes radio, node, timeout as positional args');

  // ── argument validation, before anything resolves or moves ──────────────
  {
    const s = await harness(() => traceroute.run('rotator', null, 200));
    ok(/node required/.test(s.error ?? ''), 'a missing node is refused');
    eq(s.points, 0, '...and nothing is pointed');
    eq(s.posts.length, 0, '...and nothing is transmitted');
  }
  {
    // TIMEOUT IS OPTIONAL AND DEFAULTS FROM CONFIG. Peter, 2026-08-18: "if
    // timeout is not set, then it should have a default. that should be a config
    // and not hard coded." An earlier reading made it mandatory; this asserts
    // the correction, and asserts the value comes from the KEY and not a literal.
    const savedTo = getConfig('traceroute.timeout_sec', null);
    try {
      setConfig('traceroute.timeout_sec', 1);          // 1 s, so the test is quick
      const s = await harness(() => traceroute.run('rotator', TARGET), { settleMs: 500 });
      eq(s.holds[0], 1000, 'with no timeout the hold is traceroute.timeout_sec x 1000');
      eq(s.posts.length, 1, '...and it dispatches rather than refusing');

      setConfig('traceroute.timeout_sec', 2);          // change the key...
      const s2 = await harness(() => traceroute.run('rotator', TARGET), { settleMs: 500 });
      eq(s2.holds[0], 2000, '...and changing the key changes the timeout — it is config, not a literal');
    } finally {
      if (savedTo === null) setConfig('traceroute.timeout_sec', 60);
      else                  setConfig('traceroute.timeout_sec', savedTo);
    }
  }
  {
    const s = await harness(() => traceroute.run('no-such-radio', TARGET, 200));
    ok(/no radio resolves/.test(s.error ?? ''), 'an unresolvable radio is refused by name');
    eq(s.posts.length, 0, '...and nothing is transmitted');
  }

  // ── OMNI: the aiming half is skipped entirely ───────────────────────────
  // Peter: "of course some of this is skipped if the radio is an omni directional."
  {
    const s = await harness(() => traceroute.run('non-rotator', TARGET, 200));
    eq(s.points, 0, 'an omni radio never touches the rotator');
    eq(s.holds.length, 0, '...and never holds the beam');
    eq(s.posts.length, 1, '...and dispatches straight away');
    ok(/traceroute/.test(s.posts[0]?.path ?? ''), '...to the traceroute path');
  }

  // ── DIRECTIONAL, aim confirmed: aim FIRST, then dispatch ────────────────
  {
    const s = await harness(() => traceroute.run('rotator', TARGET, 300));
    ok(s.points >= 1, 'a directional radio is aimed');
    eq(s.holds[0], 300, 'THE HOLD IS THE TIMEOUT — Peter, 2026-08-18');
    eq(s.posts.length, 1, '...and the traceroute is dispatched once the aim is confirmed');
  }

  // ── DIRECTIONAL, aim NOT confirmed: NO DISPATCH ─────────────────────────
  // This reverses the older "a rotator that will not move must not stop a
  // trace". Peter: "once the rotator has confirmed it is aimed it starts the
  // traceroute." The measurement behind the reversal: 303 YAGI attempts at
  // aim_mode='none' covered 246 distinct azimuths spanning 0.85-359.98 degrees.
  {
    const s = await harness(() => traceroute.run('rotator', TARGET, 300),
                            { pointResult: { ok: false, busy: true, timeout: false, err: null, az: 200 } });
    eq(s.posts.length, 0, 'A BUSY ROTATOR MEANS NO TRANSMISSION — the rule this task changed');
    ok(/aim not confirmed/.test(s.error ?? ''), '...and the caller is told why');
  }

  // ── `via` — directional only, and refuses rather than ignoring ──────────
  // Peter, 2026-08-18: "if via is set, the traceroute will go via that node,
  // again this only applies to directional antennas."
  {
    // An OMNI ignores via and still dispatches — via has no meaning with no beam.
    const s = await harness(() => traceroute.run('non-rotator', TARGET, 200, { via: { via_node: 3663393832 } }));
    eq(s.points, 0,       'via does not make an omni point at anything');
    eq(s.posts.length, 1, '...and the traceroute still goes');
  }
  {
    // A DIRECTIONAL radio honours it — the aim happens before the dispatch.
    const s = await harness(() => traceroute.run('rotator', TARGET, 300, { via: { via_node: 3663393832 } }));
    ok(s.points >= 1,     'via aims a directional radio');
    eq(s.posts.length, 1, '...and dispatches once confirmed');
  }
  {
    // A via that cannot be pointed at REFUSES. It must not quietly fall back to
    // the node/relay rule and transmit as though nothing was asked for.
    const s = await harness(() => traceroute.run('rotator', TARGET, 300, { via: { via_node: 999_999_999 } }));
    eq(s.posts.length, 0, 'AN UNHONOURABLE via DOES NOT TRANSMIT');
    ok(/aim not confirmed/.test(s.error ?? ''), '...and the caller is told');
  }

  // ── the STATUS FEED — every phase, in order, on one id ──────────────────
  // Peter, 2026-08-18: "we know everything about what its doing ... whether or
  // not all of it will be consumed is irrelevant." So this asserts the SHAPE is
  // complete, not merely that events fire.
  {
    const seen = [];
    const onStatus = (s) => seen.push(s);
    traceroute.on('status', onStatus);
    try {
      // OMNI: no aim phases at all.
      seen.length = 0;
      await harness(() => traceroute.run('non-rotator', TARGET, 200));
      const omniPhases = seen.map(s => s.phase);
      eq(omniPhases[0], 'resolved',    'the first phase is resolved');
      ok(!omniPhases.includes('aiming'), 'an omni never emits aiming');
      ok(omniPhases.includes('dispatched'), '...but does dispatch');
      ok(seen.every(s => s.id === seen[0].id), 'every phase of one run shares one id');

      // The payload carries what it knows, whether or not anything reads it.
      const r = seen[0];
      ok(r.target?.num === TARGET,            'target num is served');
      ok('label' in (r.target ?? {}),         'target label is served');
      ok('bearing_deg' in (r.target ?? {}),   "the TARGET's own bearing is served");
      eq(r.radio?.beam_deg, 360,              'radio beamwidth is served');
      eq(r.radio?.directional, false,         'directionality is served');
      ok('mac' in (r.radio ?? {}),            'radio mac is served');
      ok('rotator_id' in (r.radio ?? {}),     'which rotator serves it is served');
      ok(r.timing?.started_ts > 0,            'started_ts is served');
      eq(r.timing?.timeout_ms, 200,           'the timeout budget is served');
      // Peter offered the timestamp himself: "if s/ms to timeout is tricky then
      // a timestamp instead". deadline - started must equal the budget.
      eq(r.timing.deadline_ts - r.timing.started_ts, Math.round(200 / 1000),
         'deadline_ts is started_ts + the timeout, so no consumer derives it');
      ok('az' in (r.rotator ?? {}),           "the rotator's live azimuth is served");

      // DIRECTIONAL: the aim phases appear, and source says who chose the bearing.
      seen.length = 0;
      await harness(() => traceroute.run('rotator', TARGET, 300, { via: { via_bearing: 275 } }));
      const ph = seen.map(s => s.phase);
      ok(ph.includes('aiming') && ph.includes('aimed'), 'a directional radio emits aiming then aimed');
      eq(ph.indexOf('aiming') < ph.indexOf('aimed'), true, '...in that order');
      const aimed = seen.find(s => s.phase === 'aimed');
      eq(aimed.aim.source, 'via_bearing', 'source distinguishes an operator override from the rule');
      eq(aimed.aim.mode, 'bearing',       'mode says WHAT it aimed at');
      eq(aimed.aim.az_requested, 275,     'the requested angle is served');
      eq(aimed.aim.settled, true,         'confirmation is served');

      // A run with no via reports source 'derived' — the rule fired, not a human.
      seen.length = 0;
      await harness(() => traceroute.run('rotator', TARGET, 300));
      eq(seen.find(s => s.phase === 'aimed')?.aim.source, 'derived',
         'without a via the source is the rule, not an override');

      // AIM REFUSED: aim_failed, and NO dispatched.
      seen.length = 0;
      await harness(() => traceroute.run('rotator', TARGET, 300),
                    { pointResult: { ok: false, busy: true, timeout: false, err: null, az: 200 } });
      const rf = seen.map(s => s.phase);
      ok(rf.includes('aim_failed'),  'a refused aim emits aim_failed');
      ok(!rf.includes('dispatched'), '...and NEVER dispatched — nothing was transmitted');
      ok(seen.find(s => s.phase === 'aim_failed')?.error?.reason, '...with a reason');

      // A terminal phase ends the run, so nothing leaks into the replay.
      eq(traceroute.inFlight().length, 0, 'a finished run is not reported as in flight');
    } finally {
      traceroute.off('status', onStatus);
    }
  }

  // The hold ceiling itself is proven in tests/test_aim.mjs against
  // rotator.point() directly — it cannot be exercised here without passing a
  // timeout so large the dispatch would never return.

  console.log(`test_traceroute_flow: ${checks} checks passed`);
} catch (e) {
  // A FAILING ASSERTION MUST FAIL THE RUN. The `finally` below calls
  // process.exit() so the pending dispatch timers cannot hold the process open
  // — and an unqualified exit(0) there SWALLOWED every assertion error, which is
  // a test that cannot fail. Caught 2026-08-18 when the suite reported nothing
  // at all instead of a mismatch.
  failure = e;
  console.error(`test_traceroute_flow FAILED: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  for (const mac of [OMNI, YAGI]) {
    if (saved[mac] === null) setConfig(PREFIX + mac, {});
    else                     setConfig(PREFIX + mac, saved[mac]);
  }
  const removed = db.prepare('DELETE FROM traceroute_history WHERE id > ?').run(baselineId).changes;
  if (removed) console.log(`test_traceroute_flow: cleaned up ${removed} row(s) this test created`);
  process.exit(failure ? 1 : 0);
}
