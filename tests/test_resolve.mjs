// resolve: ONE answer to "which radio, and what is it capable of".
// Spec: docs/modules/radio-resolve-and-aim.md.
//
// THE TEST THAT ENCODES THE DEFECT THIS MODULE REPLACES. traceroute.js:217-222,
// before removal:
//
//     if (radio === 'omni') {
//       const tx = transmitterForMode(modeKey);
//       return (rot && tx && tx.toUpperCase() === rot.toUpperCase()) ? tx : tx;
//     }
//
// Both arms returned `tx`, so asking for the omni could return the YAGI — the
// exact radio the caller asked not to use. `resolveRadio('non-rotator')` is that
// branch done properly, and the assertion below fails if it ever regresses.
//
// FIXTURES, NOT LIVE RADIOS. The shapes below mirror the live pair as measured
// 2026-08-17 (OMNI beam 360 / not rotator, YAGI beam 35 / rotator), but they are
// written into config here so the test keeps its meaning when the radios are
// unreachable, re-labelled, or reconfigured.
import assert from 'node:assert/strict';

const { resolveRadio, isDirectional, rotatorFor, RADIO_SPECS }
  = await import('../src/resolve.js');
const { setConfig, getConfig } = await import('../src/db.js');
const { registerInstallLookup } = await import('../src/device-config.js');

const OMNI = 'E9:B0:3F:17:27:91';
const YAGI = 'F4:12:FA:39:F7:B6';
const PREFIX = 'device_cfg.';

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

// Snapshot whatever the machine really holds, so the test never leaves the live
// config altered — this runs on the same box as the running dashboard.
const saved = {};
for (const mac of [OMNI, YAGI]) saved[mac] = getConfig(PREFIX + mac, null);

function restore() {
  for (const mac of [OMNI, YAGI]) {
    if (saved[mac] === null) setConfig(PREFIX + mac, {});
    else                     setConfig(PREFIX + mac, saved[mac]);
  }
}

try {
  setConfig(PREFIX + OMNI, { label: 'OMNI', is_rotator: false, is_primary: true,  beam_deg: 360 });
  setConfig(PREFIX + YAGI, { label: 'YAGI', is_rotator: true,  is_primary: false, beam_deg: 35  });

  // ── the rotator radio ──────────────────────────────────────────────────────
  const yagi = resolveRadio('rotator');
  ok(yagi != null,            'the rotator radio resolves');
  eq(yagi.mac, YAGI,          'resolved to the YAGI');
  eq(yagi.beam_deg, 35,       'beam width comes from device config, not a default');
  eq(yagi.directional, true,  'beam < 360 is directional');
  eq(yagi.steerable, true,    'on the rotator, so steerable');
  eq(yagi.rotatorId, YAGI,    'names WHICH rotator serves it');

  // ── THE REGRESSION TEST FOR THE OMNI DEFECT ───────────────────────────────
  // The old branch could return the rotator here. If this ever comes back as the
  // YAGI, a caller asking for the omni is transmitting on a 35-degree beam
  // pointed wherever somebody else left it.
  const omni = resolveRadio('non-rotator');
  ok(omni != null,             'the non-rotator radio resolves');
  eq(omni.mac, OMNI,           'non-rotator must NOT return the rotator — the 2026-08-17 defect');
  ok(omni.mac !== yagi.mac,    'non-rotator and rotator are different radios');
  eq(omni.beam_deg, 360,       'omni beam width');
  eq(omni.directional, false,  '360 degrees is not directional — Peter\'s own test');
  eq(omni.steerable, false,    'not on the rotator');
  eq(omni.rotatorId, null,     'no rotator serves it');

  // ── directional and steerable are DIFFERENT questions ─────────────────────
  // The old code answered "directional?" with beam_deg for the recorded
  // provenance and with is_rotator for the behavioural gate — two fields for one
  // fact. A fixed yagi is directional and NOT steerable; that must be sayable.
  setConfig(PREFIX + OMNI, { label: 'FIXEDYAGI', is_rotator: false, is_primary: true, beam_deg: 40 });
  const fixed = resolveRadio('non-rotator');
  eq(fixed.directional, true,  'a fixed yagi IS directional');
  eq(fixed.steerable,  false,  '...and is NOT steerable. The old code could not say both.');
  setConfig(PREFIX + OMNI, { label: 'OMNI', is_rotator: false, is_primary: true, beam_deg: 360 });

  // ── unknown beam width must not become a guessed default ──────────────────
  // A 3-element and a 7-element yagi have to stay separable in the data.
  setConfig(PREFIX + OMNI, { label: 'OMNI', is_rotator: false, is_primary: true, beam_deg: null });
  const unknown = resolveRadio('non-rotator');
  eq(unknown.beam_deg, null,     'unknown beam width stays null, never a default');
  eq(unknown.directional, false, 'we do not claim a radio needs aiming on a missing number');
  setConfig(PREFIX + OMNI, { label: 'OMNI', is_rotator: false, is_primary: true, beam_deg: 360 });

  // ── explicit addresses ────────────────────────────────────────────────────
  eq(resolveRadio(YAGI)?.mac, YAGI,          'an explicit MAC resolves');
  eq(resolveRadio(YAGI.toLowerCase())?.mac, YAGI, 'MAC match is case-insensitive');

  // ── a bundle is whole or it is null ───────────────────────────────────────
  // A caller that gets an object must be able to trust every field in it.
  eq(resolveRadio('!ffffffff'), null, 'an unknown node id resolves to null, not a partial bundle');
  eq(resolveRadio('AA:AA:AA:AA:AA:AA'), null, 'an unknown MAC resolves to null');
  eq(resolveRadio('nonsense-spec'), null, 'an unrecognised spec resolves to null');

  // ── A RADIO RECORD CARRIES NO CHANNELS AT ALL ─────────────────────────────
  // This used to assert `{ pub: <index>, pri: <index> }` and that neither was 0
  // by coercion. The field is gone: an index means different things on different
  // radios — private is 2 on the OMNI and 1 on the YAGI — and a caller that wants
  // to transmit says 'public' or 'private' and lets the gateway resolve it.
  // Peter, 2026-08-19: "all you need to know is public and private."
  // docs/modules/channels.md.
  //
  // Asserting the ABSENCE, not merely dropping the old check: a `channels` field
  // reappearing here is the resolver coming back, and this is where it shows.
  ok(!('channels' in resolveRadio('primary')),
     'a radio record carries no channels field — resolution belongs to the gateway');

  // ── the convenience wrappers agree with the bundle ────────────────────────
  eq(isDirectional('rotator'), true,      'isDirectional agrees with the bundle');
  eq(isDirectional('non-rotator'), false, 'isDirectional agrees for the omni');
  eq(rotatorFor('rotator'), YAGI,         'rotatorFor names the rotator');
  eq(rotatorFor('non-rotator'), null,     'rotatorFor is null for an unsteerable radio');

  // ── mesh-gw's LIVE directional flag wins over a stale local beam_deg ──────
  // Reproduced live 2026-09-10: YAGI2's local device_cfg had never had
  // beam_deg set (defaulted to 360, "omnidirectional"), so resolve.js believed
  // a real 9-element mast-mounted Yagi was not directional and traceroute.js
  // skipped aiming entirely — a directional-antenna transmit went out unaimed.
  // is_rotator already defers to mesh-gw's install object once it has reported
  // one; directional never got the same treatment until now.
  registerInstallLookup(mac => mac === YAGI
    ? { antenna: { directional: true, rotator: { host: '192.168.10.185' } } } : null);
  setConfig(PREFIX + YAGI, { label: 'YAGI', is_rotator: true, is_primary: false, beam_deg: 360 });
  const liveDirectional = resolveRadio('rotator');
  eq(liveDirectional.directional, true,
     "mesh-gw's live antenna.directional overrides a stale/unset local beam_deg");
  registerInstallLookup(() => null);
  setConfig(PREFIX + YAGI, { label: 'YAGI', is_rotator: true, is_primary: false, beam_deg: 35 });

  // ── the vocabulary is shared, not a fourth one ────────────────────────────
  // 'omni' and 'yagi' were traceroute's private words for radios that dash-mode
  // already called 'non-rotator' and 'rotator'. They must not come back.
  ok(!RADIO_SPECS.includes('omni'), "'omni' is not a spec — 'non-rotator' says it, and dash-mode already did");
  ok(!RADIO_SPECS.includes('yagi'), "'yagi' is not a spec — 'rotator' says it");

  console.log(`test_resolve: ${checks} checks passed`);
} finally {
  restore();
}
