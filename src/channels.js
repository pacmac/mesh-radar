// channels — THE single source of truth for "which channel is this, and which
// slot do I send it on". Nothing else may decide a channel. Spec:
// docs/modules/channels.md.
//
// Peter, 2026-08-16: "the resolver needs to resolve this, needs an arg passed to
// it 'pub or pri' ... I suspect there are lots of other places where the wrong
// channel is used. resolve should be the SSOT", and "so 2 args (RADIO,PUB/PRI)".
// Earlier: "you CANNOT use channel index and assume that channel 1 is the
// private channel on all devices."
//
// A CHANNEL'S IDENTITY IS ITS NAME **AND** ITS KEY, and getting that wrong cost
// five days of the YAGI. An earlier version of this module keyed on the PSK alone
// and therefore called our two PRIMARYs the same channel — same key, one unnamed
// and one named `Public`. Meshtastic hashes the name AND the key, so they are
// not: from 2026-08-12 the YAGI transmitted into a channel nobody was listening
// to, completed ZERO traceroutes in 2,778 attempts, and the OMNI two metres away
// stopped hearing it. Measured 2026-08-16:
//
//   OMNI  E9:B0  0 PRIMARY   (unnamed)   865e781a56f3
//                1 SECONDARY mqtt        (no key)
//                2 SECONDARY Private     fffb995be728
//   YAGI  F4:12  0 PRIMARY   Public      b7ecd210d6cd   <- differs. the fault.
//                1 SECONDARY Private     fffb995be728   <- matches, at a different index
//
// THE KEY ITSELF IS NEVER STORED, only its hash: `psk` is in the browser's
// SENSITIVE_FIELDS and the audit spec lets only psk_present and a length out.

import { createHash } from 'node:crypto';
import { getConfig } from './db.js';

/** The roles a caller may ask for. Closed set — an open one invites `resolve(dev,
 *  'primary')` and a silent undefined. */
export const ROLES = ['pub', 'pri'];

// Config keys naming the designated channels, by identity hash.
//
// CONFIGURED, NOT INFERRED. "The channel both radios share" singles neither out,
// and inferring `pub` from "index 0" is precisely the assumption that hid the
// YAGI fault: index 0 on the YAGI IS a primary, it is just the wrong one.
export const ROLE_CONFIG_KEY = { pub: 'channels.pub_key', pri: 'channels.pri_key' };

// device (MAC, upper) -> [{ index, name, role, key }]
const _byDevice = new Map();

/** A channel's identity: name AND key.
 *
 *  NULL WHEN THERE IS NO KEY, deliberately. `mqtt` above is unencrypted; if this
 *  returned a constant then `null === null` would match it against a designated
 *  channel and a private broadcast would go out in clear. Every comparison below
 *  therefore requires a non-null identity on BOTH sides. */
export function channelKey(name, psk) {
  if (typeof psk !== 'string' || psk === '') return null;
  return createHash('sha256').update(`${name ?? ''}\0${psk}`).digest('hex');
}

const _dev = d => (typeof d === 'string' ? d.toUpperCase() : null);

/** Record a radio's channel table. Called by ws-relay's refreshDeviceChannels on
 *  every device READY. This module does NO HTTP of its own — a second fetcher is
 *  a second source of truth for one question, and they drift. */
export function setDeviceChannels(device, channels) {
  const k = _dev(device);
  if (!k) return;
  _byDevice.set(k, (channels || []).map(c => ({
    index: c.index,
    name:  c.name ?? '',
    role:  c.role ?? null,        // the RADIO's PRIMARY/SECONDARY, not our pub/pri
    key:   c.key ?? null,
  })));
}

/** Every known channel on a radio. */
export function channelsFor(device) {
  return _byDevice.get(_dev(device)) ?? [];
}

/** The configured identity for a role, or null if undesignated. */
export function designatedKey(role) {
  const cfgKey = ROLE_CONFIG_KEY[role];
  if (!cfgKey) return null;
  const v = getConfig(cfgKey, null);
  return (typeof v === 'string' && v !== '') ? v : null;
}

/** THE SLOT TO TRANSMIT `role` ON, FOR THIS RADIO. Two args, as Peter specified:
 *  (radio, 'pub'|'pri').
 *
 *  RETURNS NULL RATHER THAN A DEFAULT, and callers must treat null as "cannot
 *  send" rather than "send anyway". A fallback to 0 transmits on whatever that
 *  radio's primary happens to be — which on the YAGI is the misnamed channel, and
 *  on any radio is the PUBLIC MESH when you asked for private. */
export function indexFor(device, role) {
  const want = designatedKey(role);
  if (!want) return null;
  const ch = channelsFor(device).find(c => c.key && c.key === want);
  return ch ? ch.index : null;
}

/** What a RECEIVED channel actually is: 'pub', 'pri', or null for neither. */
export function roleOf(device, index) {
  const ch = channelsFor(device).find(c => c.index === index);
  if (!ch || !ch.key) return null;
  for (const role of ROLES) {
    const want = designatedKey(role);
    if (want && ch.key === want) return role;
  }
  return null;
}

/** The only permitted membership test. False when undesignated, when the radio is
 *  unknown, or when the slot carries no key. Never guesses. */
export function isRole(device, index, role) {
  return roleOf(device, index) === role;
}

/** Full identity of one slot, or null. */
export function resolveChannel(device, index) {
  const ch = channelsFor(device).find(c => c.index === index);
  if (!ch) return null;
  return { ...ch, designated: roleOf(device, index) };
}

/** WHERE A DESIGNATED CHANNEL IS MISSING FROM A RADIO.
 *
 *  This is the check that would have caught the YAGI on 2026-08-12 rather than
 *  five days later. A radio with no slot carrying the public channel is not a
 *  quiet edge case: every public transmission it makes goes nowhere, silently,
 *  while the dashboard shows a plausible combined success rate carried by the
 *  other radio.
 *
 *  Reports nothing when a role is undesignated — that is a configuration gap, not
 *  a radio divergence, and conflating them would cry wolf on a fresh install. */
export function divergences() {
  const out = [];
  for (const [device, chans] of _byDevice) {
    for (const role of ROLES) {
      const want = designatedKey(role);
      if (!want) continue;
      if (!chans.some(c => c.key && c.key === want)) {
        out.push({ device, role, reason: 'no slot carries the designated key' });
      }
    }
  }
  return out;
}
