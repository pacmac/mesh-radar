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
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

const saved = {};
for (const mac of [OMNI, YAGI]) saved[mac] = getConfig(PREFIX + mac, null);
const savedEnabled = getConfig('traceroute.enabled', null);

// Every row this test causes is deleted at the end. A dispatch that times out
// writes a real failure row, and this runs against the live store.
const baselineId = db.prepare('SELECT COALESCE(MAX(id),0) id FROM traceroute_history').get().id;

async function harness(fn, { pointResult = { ok: true, busy: false, timeout: false, err: null }, settleMs = 400 } = {}) {
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
  setConfig('traceroute.enabled', true);

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
    const s = await harness(() => traceroute.run('rotator', TARGET, null));
    ok(/timeout required/.test(s.error ?? ''), 'a missing timeout is refused — it is arg 3, not an option');
    eq(s.points, 0, '...and nothing is pointed');
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
    const s = await harness(() => traceroute.run('non-rotator', TARGET, 200, { via: 3663393832 }));
    eq(s.points, 0,       'via does not make an omni point at anything');
    eq(s.posts.length, 1, '...and the traceroute still goes');
  }
  {
    // A DIRECTIONAL radio honours it — the aim happens before the dispatch.
    const s = await harness(() => traceroute.run('rotator', TARGET, 300, { via: 3663393832 }));
    ok(s.points >= 1,     'via aims a directional radio');
    eq(s.posts.length, 1, '...and dispatches once confirmed');
  }
  {
    // A via that cannot be pointed at REFUSES. It must not quietly fall back to
    // the node/relay rule and transmit as though nothing was asked for.
    const s = await harness(() => traceroute.run('rotator', TARGET, 300, { via: 999_999_999 }));
    eq(s.posts.length, 0, 'AN UNHONOURABLE via DOES NOT TRANSMIT');
    ok(/aim not confirmed/.test(s.error ?? ''), '...and the caller is told');
  }

  // The hold ceiling itself is proven in tests/test_aim.mjs against
  // rotator.point() directly — it cannot be exercised here without passing a
  // timeout so large the dispatch would never return.

  console.log(`test_traceroute_flow: ${checks} checks passed`);
} finally {
  for (const mac of [OMNI, YAGI]) {
    if (saved[mac] === null) setConfig(PREFIX + mac, {});
    else                     setConfig(PREFIX + mac, saved[mac]);
  }
  if (savedEnabled === null) setConfig('traceroute.enabled', false);
  else                       setConfig('traceroute.enabled', savedEnabled);
  const removed = db.prepare('DELETE FROM traceroute_history WHERE id > ?').run(baselineId).changes;
  if (removed) console.log(`test_traceroute_flow: cleaned up ${removed} row(s) this test created`);
  process.exit(0);   // pending dispatch timers would otherwise hold the process open
}
