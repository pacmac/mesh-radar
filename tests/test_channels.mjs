// channels: a channel's identity is its NAME AND its KEY, and callers ask for a
// ROLE — (radio, 'pub'|'pri') — never for an index and never for a name.
//
// THIS IS THE TEST THAT STOPS A PRIVATE REPLY GOING OUT ON THE PUBLIC MESH, and
// that would have caught the YAGI outage on 2026-08-12 instead of five days
// later. Measured on the two live radios, 2026-08-16:
//
//   E9:B0 OMNI   0 PRIMARY   (unnamed)   key A
//                1 SECONDARY mqtt        NO KEY - unencrypted
//                2 SECONDARY Private     key P
//   F4:12 YAGI   0 PRIMARY   `Public`    key B   <- NOT key A. same psk, different NAME.
//                1 SECONDARY Private     key P
//
//   INDEX FAILS      Private is 2 on one radio and 1 on the other, and index 1 on
//                    the OMNI is `mqtt`, which is unencrypted.
//   KEY ALONE FAILS  the two PRIMARYs share a psk. Under key-only identity they
//                    looked like one channel; Meshtastic hashes name AND key, so
//                    on air they are two. From 2026-08-12 the YAGI completed ZERO
//                    traceroutes in 2,778 attempts and the OMNI two metres away
//                    stopped hearing it.
//   NAME+KEY WORKS   the two Private slots match; the two primaries do not.
//
// Fixtures below reproduce exactly that shape. They are deliberately NOT read from
// the live radios: this must keep failing if someone reintroduces index-matching
// or key-only identity, whether or not the radios are reachable or still
// configured this way.
import assert from 'node:assert/strict';

const { channelKey, setDeviceChannels, isRole, roleOf, indexFor,
        resolveChannel, channelsFor, divergences, ROLES, ROLE_CONFIG_KEY }
  = await import('../src/channels.js');
const { setConfig, getConfig } = await import('../src/db.js');

const OMNI = 'E9:B0:3F:17:27:91';
const YAGI = 'F4:12:FA:39:F7:B6';

const PSK_PRIMARY = 'AQ==';                                     // shared by BOTH primaries
const PSK_PRIVATE = 'zNQeQVAiaEPBcXtBQqp5rDlXJ2eD4XpWy2WcYQXhkm8=';

const KEY_PUB      = channelKey('',        PSK_PRIMARY);   // OMNI primary, UNNAMED
const KEY_PUB_MISN = channelKey('Public',  PSK_PRIMARY);   // YAGI primary, NAMED
const KEY_PRI      = channelKey('Private', PSK_PRIVATE);

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

// ── identity ────────────────────────────────────────────────────────────────
// THE ASSERTION THAT ENCODES THE OUTAGE: same key, different name, different
// channel. If this ever passes as equal, the YAGI fault is reintroduced.
ok(KEY_PUB !== KEY_PUB_MISN,
   'same psk + different NAME must be a DIFFERENT channel — this is the 2026-08-12 fault');
eq(channelKey('Private', PSK_PRIVATE), KEY_PRI, 'identity is stable across calls');
ok(KEY_PRI !== KEY_PUB, 'different name and key -> different identity');

// An unencrypted channel must never compare equal to a designated one, or `mqtt`
// and a designated channel are both null and `null === null` sends in clear.
eq(channelKey('mqtt', undefined), null, 'absent key -> null');
eq(channelKey('mqtt', ''),        null, 'empty key -> null');
eq(channelKey('',     null),      null, 'null key -> null');

// ── the live shape, as fixtures ─────────────────────────────────────────────
setDeviceChannels(OMNI, [
  { index: 0, name: '',        role: 'PRIMARY',   key: KEY_PUB      },
  { index: 1, name: 'mqtt',    role: 'SECONDARY', key: null         },
  { index: 2, name: 'Private', role: 'SECONDARY', key: KEY_PRI      },
]);
setDeviceChannels(YAGI, [
  { index: 0, name: 'Public',  role: 'PRIMARY',   key: KEY_PUB_MISN },
  { index: 1, name: 'Private', role: 'SECONDARY', key: KEY_PRI      },
]);

// THIS TEST WRITES LIVE CONFIG, justified given what a test did to this project's
// config on 2026-08-13: it touches only the two designation keys, restores them in
// `finally`, and asserts the restoration. Every interruption point leaves a role
// undesignated or pointing at a key we do not hold — both FAIL CLOSED, so there is
// no way to be interrupted into a MORE permissive state.
const restore = Object.fromEntries(ROLES.map(r => [r, getConfig(ROLE_CONFIG_KEY[r], null)]));
try {
  setConfig(ROLE_CONFIG_KEY.pub, KEY_PUB);
  setConfig(ROLE_CONFIG_KEY.pri, KEY_PRI);

  // ── (radio, role) resolves per radio — Peter: "so 2 args (RADIO,PUB/PRI)" ──
  eq(indexFor(OMNI, 'pri'), 2, 'private is index 2 on the OMNI');
  eq(indexFor(YAGI, 'pri'), 1, 'private is index 1 on the YAGI — same channel, different slot');
  eq(indexFor(OMNI, 'pub'), 0, 'public resolves on the OMNI');

  // THE FAULT, SURFACED RATHER THAN PAPERED OVER. The YAGI's primary carries a
  // different identity, so there is NO slot for `pub` — and the resolver says so
  // instead of quietly handing back 0.
  eq(indexFor(YAGI, 'pub'), null,
     'the YAGI has NO public slot — its primary is misnamed. null, never 0');

  // roleOf answers what a RECEIVED channel actually is.
  eq(roleOf(OMNI, 2), 'pri', 'OMNI idx 2 is private');
  eq(roleOf(YAGI, 1), 'pri', 'YAGI idx 1 is private');
  eq(roleOf(OMNI, 0), 'pub', 'OMNI idx 0 is public');
  eq(roleOf(OMNI, 1), null,  'mqtt is neither — unencrypted, and must never match');
  eq(roleOf(YAGI, 0), null,  'the misnamed primary is NOT the public channel');

  eq(isRole(OMNI, 1, 'pri'), false, 'mqtt is not private');
  eq(isRole(YAGI, 0, 'pub'), false, 'the misnamed primary is not public');

  // ── divergences: the SSOT reporting its own gaps ─────────────────────────
  const d = divergences();
  eq(d.length, 1, 'exactly one divergence');
  eq(d[0].device, YAGI, 'and it is the YAGI');
  eq(d[0].role,   'pub', 'missing the PUBLIC channel — the 2026-08-12 outage, detected');

  // resolveChannel carries the verdict so no caller recomputes it.
  eq(resolveChannel(OMNI, 2).designated, 'pri', 'resolveChannel reports the role');
  eq(resolveChannel(OMNI, 1).designated, null,  'and null for mqtt');
  eq(resolveChannel(OMNI, 7),            null,  'an absent slot resolves to null');

  // Unknown radio: nothing resolves, nothing claims a role.
  eq(indexFor('AA:BB:CC:DD:EE:FF', 'pri'), null,  'unknown radio -> null, NOT 0');
  eq(roleOf('AA:BB:CC:DD:EE:FF', 1),       null,  'unknown radio has no roles');
  eq(channelsFor('AA:BB:CC:DD:EE:FF').length, 0,  'unknown radio has no channels');
  eq(indexFor(OMNI, 'nonsense'),           null,  'an unknown role resolves to null');
  eq(indexFor(OMNI.toLowerCase(), 'pri'),  2,     'device key is case-insensitive');

  // ── THE RESOLVER ABSORBS THE VOCABULARY ──────────────────────────────────
  // callout is handed a node id by dash-mode.transmitterForMode(), never a MAC.
  // If only MACs resolved, callout would silently stop transmitting — so a node
  // id must give the SAME answer as the MAC, and a short form must give none.
  setDeviceChannels(YAGI, channelsFor(YAGI), '!fa39f7b4');
  eq(indexFor('!fa39f7b4', 'pri'), indexFor(YAGI, 'pri'),
     'a node id resolves identically to the MAC');
  eq(indexFor('!FA39F7B4', 'pri'), 1, 'and is case-insensitive');
  eq(indexFor('!fa39f7b4', 'pub'), null,
     'the YAGI has no public slot under EITHER vocabulary');
  eq(roleOf('!fa39f7b4', 1), 'pri', 'roleOf works through the alias too');
  eq(indexFor('F7:B6', 'pri'), null,
     'a SHORT form must not resolve — last-4 collides 20x across 1056 nodes');
  eq(indexFor('TA2y', 'pri'), null, 'nor a short name — 26 collisions');
  eq(divergences().filter(d => d.device === YAGI).length, 1,
     'the aliased radio is reported ONCE, not twice — divergences keys on the MAC');

  // ── FAILS SAFE ───────────────────────────────────────────────────────────
  // Undesignated: nothing is anything, and there is no slot to send on. A
  // fallback to 0 here is PRIMARY — the public mesh — when private was asked for.
  setConfig(ROLE_CONFIG_KEY.pri, null);
  eq(indexFor(OMNI, 'pri'), null,  'no designation -> null, never 0');
  eq(roleOf(OMNI, 2),       null,  'no designation -> nothing claims the role');
  eq(divergences().filter(x => x.role === 'pri').length, 0,
     'an UNDESIGNATED role is a config gap, not a radio divergence — do not cry wolf');

  // A designation matching no slot we hold must fail closed, not fall through to
  // "the first secondary" or similar.
  setConfig(ROLE_CONFIG_KEY.pri, channelKey('Nope', 'c29tZS1vdGhlci1rZXk='));
  eq(indexFor(OMNI, 'pri'), null, 'unknown designation -> null');
  eq(divergences().filter(x => x.role === 'pri').length, 2,
     'and BOTH radios are reported as diverged from it');
} finally {
  for (const r of ROLES) setConfig(ROLE_CONFIG_KEY[r], restore[r]);
}

for (const r of ROLES) {
  eq(getConfig(ROLE_CONFIG_KEY[r], null), restore[r], `live ${r} designation restored`);
}

console.log(`${checks} checks — identity is name+key, (radio,role) resolves per radio, gaps are reported.`);
