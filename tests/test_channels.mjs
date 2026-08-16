// channels: a channel's identity is its KEY, never its index and never its name.
//
// THIS IS THE TEST THAT STOPS A PRIVATE REPLY GOING OUT ON THE PUBLIC MESH.
// Measured on the two live radios, 2026-08-14:
//
//   E9:B0:3F:17:27:91   0 PRIMARY   (unnamed)   key A
//                       1 SECONDARY mqtt        NO KEY - unencrypted
//                       2 SECONDARY Private     key B
//   F4:12:FA:39:F7:B6   0 PRIMARY   Public      key A
//                       1 SECONDARY Private     key B
//
//   INDEX FAILS  Private is 2 on one radio and 1 on the other, and index 1 on
//                E9:B0 is `mqtt`. Code that hard-codes 1 broadcasts to MQTT.
//   NAME FAILS   the two PRIMARYs are the same channel by key while one is
//                named `Public` and the other is not named at all.
//
// Fixtures below reproduce exactly that shape. They are deliberately NOT read
// from the live radios: this must keep failing if someone reintroduces
// index-matching, whether or not the radios happen to be reachable or happen to
// still be configured this way.
import assert from 'node:assert/strict';

const { pskFingerprint, setDeviceChannels, isPrivate, privateIndexFor,
        resolveChannel, channelsFor, PRIVATE_FP_KEY } = await import('../src/channels.js');
const { setConfig, getConfig } = await import('../src/db.js');

const OMNI = 'E9:B0:3F:17:27:91';
const YAGI = 'F4:12:FA:39:F7:B6';

const KEY_PRIMARY = 'AQ==';
const KEY_PRIVATE = 'zNQeQVAiaEPBcXtBQqp5rDlXJ2eD4XpWy2WcYQXhkm8=';

const fpPrimary = pskFingerprint(KEY_PRIMARY);
const fpPrivate = pskFingerprint(KEY_PRIVATE);

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.equal(a, b, what); checks++; };

// ── the fingerprint itself ───────────────────────────────────────────────────
ok(fpPrimary !== fpPrivate, 'different keys must not share a fingerprint');
eq(pskFingerprint(KEY_PRIVATE), fpPrivate, 'fingerprint is stable across calls');

// AN UNENCRYPTED CHANNEL MUST NEVER COMPARE EQUAL TO A CONFIGURED ONE. If
// pskFingerprint returned a constant for "no key", `mqtt` and a designated
// private channel would both be null and `null === null` would call mqtt
// private — putting a private broadcast on an open channel.
eq(pskFingerprint(undefined), null, 'absent key -> null');
eq(pskFingerprint(''),        null, 'empty key -> null');
eq(pskFingerprint(null),      null, 'null key -> null');

// ── the live shape, as fixtures ──────────────────────────────────────────────
setDeviceChannels(OMNI, [
  { index: 0, name: '',        role: 'PRIMARY',   psk_fp: fpPrimary },
  { index: 1, name: 'mqtt',    role: 'SECONDARY', psk_fp: null      },
  { index: 2, name: 'Private', role: 'SECONDARY', psk_fp: fpPrivate },
]);
setDeviceChannels(YAGI, [
  { index: 0, name: 'Public',  role: 'PRIMARY',   psk_fp: fpPrimary },
  { index: 1, name: 'Private', role: 'SECONDARY', psk_fp: fpPrivate },
]);

// THIS TEST WRITES LIVE CONFIG, and that deserves a justification given what a
// test did to this project's config on 2026-08-13.
//
//   - it touches ONE key, `channels.private_psk_fp`, and restores it in `finally`
//     plus asserts the restoration at the end
//   - if the process is hard-killed mid-run the key is left either unset or
//     pointing at a key we do not hold. Both FAIL SAFE: nothing resolves as
//     private, so automation drops replies rather than sending them publicly.
//     There is no interruption point that leaves a MORE permissive state.
//
// The alternative — a test-only injection hook on privateFp() — would put a
// bypass of the designation into production code, which is a worse trade.
const restore = getConfig(PRIVATE_FP_KEY, null);
try {
  setConfig(PRIVATE_FP_KEY, fpPrivate);

  // THE HEADLINE: the same channel resolves to a DIFFERENT index per radio.
  eq(privateIndexFor(OMNI), 2, 'private is index 2 on OMNI');
  eq(privateIndexFor(YAGI), 1, 'private is index 1 on YAGI');

  // THE TRAP: index 1 on OMNI is mqtt, unencrypted. Anything hard-coding 1 sends
  // a private reply to the MQTT channel from this radio.
  eq(isPrivate(OMNI, 1), false, 'OMNI index 1 is mqtt, NOT private');
  eq(isPrivate(OMNI, 2), true,  'OMNI index 2 is private');
  eq(isPrivate(YAGI, 1), true,  'YAGI index 1 is private');

  // NAME IS NOT IDENTITY: both PRIMARYs are the same channel by key while only
  // one of them is named. Neither is private.
  eq(isPrivate(OMNI, 0), false, 'unnamed PRIMARY is not private');
  eq(isPrivate(YAGI, 0), false, '"Public" PRIMARY is not private');
  eq(resolveChannel(OMNI, 0).psk_fp, resolveChannel(YAGI, 0).psk_fp,
     'the two PRIMARYs are ONE channel by key, despite different names');

  // resolveChannel carries the verdict, so no caller has to recompute it.
  eq(resolveChannel(OMNI, 2).is_private, true,  'resolveChannel reports is_private');
  eq(resolveChannel(OMNI, 1).is_private, false, 'resolveChannel reports mqtt as not private');
  eq(resolveChannel(OMNI, 7),            null,  'an absent slot resolves to null');

  // An unknown radio must not resolve to anything.
  eq(privateIndexFor('AA:BB:CC:DD:EE:FF'), null,  'unknown radio -> null, NOT 0');
  eq(isPrivate('AA:BB:CC:DD:EE:FF', 1),    false, 'unknown radio is never private');
  eq(channelsFor('AA:BB:CC:DD:EE:FF').length, 0,  'unknown radio has no channels');

  // Case-insensitive: the store keys on MAC and callers are not consistent.
  eq(privateIndexFor(OMNI.toLowerCase()), 2, 'device key is case-insensitive');

  // ── FAILS SAFE ────────────────────────────────────────────────────────────
  // With nothing designated, NOTHING is private and there is no index to send
  // on. A fallback to 0 here would be PRIMARY, the public mesh — the single
  // worst outcome this module exists to prevent.
  setConfig(PRIVATE_FP_KEY, null);
  eq(privateIndexFor(OMNI), null,  'no designation -> null, never 0');
  eq(privateIndexFor(YAGI), null,  'no designation -> null on either radio');
  eq(isPrivate(OMNI, 2),    false, 'no designation -> nothing claims privacy');

  // A designation that matches no channel we hold must also fail closed, rather
  // than falling through to "the first secondary" or similar.
  setConfig(PRIVATE_FP_KEY, pskFingerprint('c29tZS1vdGhlci1rZXk='));
  eq(privateIndexFor(OMNI), null,  'unknown designation -> null');
  eq(isPrivate(OMNI, 2),    false, 'unknown designation -> nothing is private');
} finally {
  setConfig(PRIVATE_FP_KEY, restore);
}

// The designation must be exactly what it was before this test ran: a test that
// leaves live config altered is a config-damage incident, not a test.
eq(getConfig(PRIVATE_FP_KEY, null), restore, 'live designation restored');

console.log(`${checks} checks, channel identity resolves by key on both radios.`);
