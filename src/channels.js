// channels — the one place that answers "which channel is this".
//
// A Meshtastic channel's identity is its PRE-SHARED KEY. Not its index, and not
// its name. Spec: docs/modules/channels.md.
//
// Peter, 2026-08-14: "it should be a global func, that selects the private
// channel based on a shared key (which may be in a config file) you CANNOT use
// channel index and assume that channel 1 is the private channel on all devices."
//
// HE IS RIGHT, AND BOTH OBVIOUS ALTERNATIVES ARE WRONG. Measured on our two
// radios, 2026-08-14 (fingerprints truncated here; the key is never printed):
//
//   E9:B0:3F:17:27:91   0 PRIMARY   (unnamed)   5d4dc0ce1ab5
//                       1 SECONDARY mqtt        (no key — unencrypted)
//                       2 SECONDARY Private     1ee0ab2c7a2b
//   F4:12:FA:39:F7:B6   0 PRIMARY   Public      5d4dc0ce1ab5
//                       1 SECONDARY Private     1ee0ab2c7a2b
//
//   INDEX FAILS  Private is 2 on one radio and 1 on the other. Index 1 on E9:B0
//                is `mqtt` — unencrypted, and the one channel that is emphatically
//                NOT private. Hard-coding 1 broadcasts to MQTT from that radio.
//   NAME FAILS   the two PRIMARYs are the SAME channel by key, but one is named
//                `Public` and the other is UNNAMED. A name is decoration.
//   KEY WORKS    the fingerprint matches across radios in both cases.
//
// THE KEY IS NEVER STORED. `psk` is already in the browser's SENSITIVE_FIELDS and
// the audit spec lets only `psk_present` and a length leave the system. A sha256
// fingerprint answers every question here exactly as well — it is what proved the
// two `Private` channels are one channel — while being safe to persist and log.

import { createHash } from 'node:crypto';
import { getConfig } from './db.js';

// Config key naming the designated private channel, by fingerprint.
//
// IT CANNOT BE DERIVED, which is why it is configured. "The key both radios
// share" does not single it out — the two PRIMARYs are shared too.
export const PRIVATE_FP_KEY = 'channels.private_psk_fp';

// device (MAC, upper) -> [{ index, name, role, psk_fp }]
const _byDevice = new Map();

/** sha256 of a channel's pre-shared key.
 *
 *  NULL FOR AN ABSENT OR EMPTY KEY, deliberately. An unencrypted channel must
 *  never compare equal to a configured one — `mqtt` above is exactly that case,
 *  and `null === null` returning "same channel" would put a private-channel
 *  broadcast onto an open one. Every comparison below therefore tests for a
 *  non-null fingerprint FIRST. */
export function pskFingerprint(psk) {
  if (typeof psk !== 'string' || psk === '') return null;
  return createHash('sha256').update(psk).digest('hex');
}

const _key = device => (typeof device === 'string' ? device.toUpperCase() : null);

/** Record a radio's channel table. Called by ws-relay's refreshDeviceChannels on
 *  every device READY — this module does NO HTTP of its own, because a second
 *  fetcher for the same question is a second source of truth that can drift. */
export function setDeviceChannels(device, channels) {
  const k = _key(device);
  if (!k) return;
  _byDevice.set(k, (channels || []).map(c => ({
    index:  c.index,
    name:   c.name ?? '',
    role:   c.role ?? null,
    psk_fp: c.psk_fp ?? null,
  })));
}

/** The configured private-channel fingerprint, or null if none is designated. */
export function privateFp() {
  const fp = getConfig(PRIVATE_FP_KEY, null);
  return (typeof fp === 'string' && fp !== '') ? fp : null;
}

/** Every known channel on a radio. Empty array if the radio has not reported. */
export function channelsFor(device) {
  return _byDevice.get(_key(device)) ?? [];
}

/** THE ONLY PERMITTED "is this private" TEST.
 *
 *  False when nothing is designated, when the radio is unknown, or when the slot
 *  carries no key. Never guesses. */
export function isPrivate(device, index) {
  const want = privateFp();
  if (!want) return false;
  const ch = channelsFor(device).find(c => c.index === index);
  return !!(ch && ch.psk_fp && ch.psk_fp === want);
}

/** The slot to transmit the private channel on, for THIS radio.
 *
 *  RETURNS NULL RATHER THAN A DEFAULT. A caller that fell back to 0 on null would
 *  transmit on PRIMARY — the public mesh — which is the single worst outcome this
 *  module exists to prevent. Callers must treat null as "cannot send", not as
 *  "send anyway". */
export function privateIndexFor(device) {
  const want = privateFp();
  if (!want) return null;
  const ch = channelsFor(device).find(c => c.psk_fp && c.psk_fp === want);
  return ch ? ch.index : null;
}

/** Full identity of one slot: {index, name, role, psk_fp, is_private}, or null. */
export function resolveChannel(device, index) {
  const ch = channelsFor(device).find(c => c.index === index);
  if (!ch) return null;
  return { ...ch, is_private: isPrivate(device, index) };
}
