// resolve — the single answer to "which radio, and what is it capable of".
// Spec: docs/modules/radio-resolve-and-aim.md.
//
// THE RULE THIS MODULE EXISTS FOR. Peter, 2026-08-17: "aim, resolve and
// traceroute are 3 functions that may be called independently as well as in the
// case of traceroute dependently. traceroute should call and not duplicate what
// the other functions provide."
//
// Before this, traceroute.js carried its own resolver (`_resolveRadio`), its own
// beamwidth lookup, its own MAC translation and its own is-it-on-the-rotator
// test. Three separate vocabularies for "which radio" existed at once —
// dash-mode's TX_ROLES, traceroute's auto|yagi|omni, and raw MAC/node_id — and
// none of them was the SSOT.
//
// THE DEFECT THAT PROVED THE POINT, traceroute.js:217-222 before removal:
//
//     if (radio === 'omni') {
//       const tx = transmitterForMode(modeKey);
//       return (rot && tx && tx.toUpperCase() === rot.toUpperCase()) ? tx : tx;
//     }
//
// Both arms of the ternary returned `tx`. Asking for the omni returned whatever
// the mode's transmitter was — possibly the YAGI, the exact radio the caller had
// asked not to use. Its own comment said it "cannot infer the other one here
// without device config" while device-config was imported eleven lines above.
// `'non-rotator'` below is that branch done properly.
//
// THIS MODULE NEVER MOVES HARDWARE. Peter, 2026-08-06, on the mode SSOT: it
// "does NOT own the pointer — modes use it, they must not control or gate it."
// The same boundary applies here: resolve REPORTS which rotator serves a radio;
// src/aim.js is the only thing that points it.

import { getDeviceCfg, getAllDeviceCfgs, getPrimaryMac, getRotatorAddress,
         macToNodeId, getLiveDirectional } from './device-config.js';
import { dashMode, modeName, transmitterForMode } from './dash-mode.js';
// No channel import — a radio record no longer carries channel indices.

/** Radio specs this module understands, for validation and for the config form.
 *
 *  DELIBERATELY THE SAME WORDS dash-mode.js already uses in TX_ROLES. Adding a
 *  fourth vocabulary is what created the mess this replaces. 'omni' and 'yagi'
 *  from traceroute's private set are NOT carried over: 'non-rotator' and
 *  'rotator' say the same things and already exist. */
export const RADIO_SPECS = ['auto', 'rotator', 'non-rotator', 'primary'];

/** The MAC of the configured radio that is NOT on the rotator.
 *
 *  This is the lookup traceroute claimed it could not do. It is one pass over
 *  the device config. Returns null when there is no such radio, or when there is
 *  more than one and the answer would be a guess — an ambiguous answer here
 *  chooses a transmitter, so it must never be arbitrary. */
function nonRotatorMac() {
  const rot = getRotatorAddress()?.toUpperCase() ?? null;
  const found = Object.entries(getAllDeviceCfgs())
    .filter(([mac, cfg]) => cfg && mac.toUpperCase() !== rot && !cfg.is_rotator)
    // A device_cfg entry exists for placeholders and for radios we have merely
    // seen. Require a label, which is set for radios the operator has actually
    // configured — the same test the Devices page uses to show one.
    .filter(([, cfg]) => !!cfg.label)
    .map(([mac]) => mac);
  return found.length === 1 ? found[0] : null;
}

/** MAC for a spec, or null. Accepts a MAC or a `!hex` node id verbatim. */
function macFor(spec, ctx) {
  if (spec && typeof spec === 'string' && (spec.includes(':') || spec.startsWith('!'))) {
    // An explicit address. Resolved against the config so an unknown one comes
    // back null rather than being passed through to the radio layer.
    const s = spec.includes(':') ? spec.toUpperCase() : spec;
    for (const mac of Object.keys(getAllDeviceCfgs())) {
      if (mac.toUpperCase() === s) return mac;
      if (macToNodeId(mac) === spec) return mac;
    }
    return null;
  }
  if (spec === 'rotator')     return getRotatorAddress();
  if (spec === 'primary')     return getPrimaryMac();
  if (spec === 'non-rotator') return nonRotatorMac();
  if (!spec || spec === 'auto') {
    // The mode's transmitter. transmitterForMode returns a node_id, so it is
    // converted back here rather than at every call site.
    const nodeId = transmitterForMode(modeName(dashMode.value), ctx);
    if (!nodeId) return null;
    for (const mac of Object.keys(getAllDeviceCfgs())) {
      if (macToNodeId(mac) === nodeId || mac.toUpperCase() === String(nodeId).toUpperCase()) return mac;
    }
    return null;
  }
  return null;
}

/** Everything one call needs to know about a radio before transmitting on it.
 *
 *  @param spec  a MAC, a `!hex` node id, or one of RADIO_SPECS. Null = 'auto'.
 *  @param ctx   passed through to transmitterForMode for the 'rx' role
 *               (`{ rxDevice }`), which is the only role that needs context.
 *  @returns the bundle below, or null when nothing resolves. NEVER a partial
 *           bundle: a caller that gets an object must be able to trust every
 *           field in it. */
export function resolveRadio(spec, ctx = {}) {
  const mac = macFor(spec, ctx);
  if (!mac) return null;
  const cfg = getDeviceCfg(mac);

  // BEAM WIDTH IS THE TRUTH FOR DIRECTIONALITY. Peter, 2026-08-17: "if the
  // requested radio (device) is defined as omnidirectional i.e beam width 360
  // degrees then no further discovery is needed."
  //
  // NULL MEANS UNKNOWN and must never become a guessed default — a 3-element and
  // a 7-element yagi have to stay separable in the data when the antenna is
  // upgraded. So `directional` is false for an unknown beam: we do not claim a
  // radio needs aiming on the strength of a missing number.
  const beamRaw  = Number(cfg?.beam_deg);
  const beam_deg = Number.isFinite(beamRaw) && beamRaw > 0 ? beamRaw : null;

  // mesh-gw's LIVE antenna.directional wins the moment it has reported one —
  // same SSOT rule as is_rotator (2026-09-03). Added 2026-09-10: a stale/unset
  // local beam_deg (360, the omnidirectional default) made a real 9-element
  // mast-mounted Yagi read as non-directional here, so traceroute.js skipped
  // aiming before transmitting. Falls back to the beam_deg computation only
  // when mesh-gw has not said either way.
  const liveDirectional = getLiveDirectional(mac);
  const directional = liveDirectional ?? (beam_deg != null && beam_deg < 360);

  // STEERABLE IS A DIFFERENT QUESTION FROM DIRECTIONAL, and the old code could
  // not express the difference — it answered "directional?" with beam_deg for
  // the recorded provenance and with is_rotator for the behavioural gate, two
  // fields for one fact. A fixed yagi is directional and NOT steerable, which is
  // a real configuration; so is an omni bolted to a rotator.
  const rotatorMac = getRotatorAddress();
  const steerable  = !!(cfg?.is_rotator && rotatorMac);

  return {
    mac,
    node_id: macToNodeId(mac),
    label:   cfg?.label ?? null,
    beam_deg,
    directional,
    steerable,
    // WHICH rotator, not WHERE it is. mesh-gw's aim plugin owns the connection
    // now (aim-client.js — the old direct-WS rotator module was retired 2026-09-03,
    // task rotator-command-via-meshgw-aim). Peter's sketch asked for host/port
    // here; duplicating that would create a second place to be wrong about
    // where the rotator lives, and mesh-gw is the one that reconnects.
    rotatorId: steerable ? rotatorMac : null,
    // NO `channels` FIELD. A radio record used to carry
    // `{ pub: <index>, pri: <index> }`, which is exactly the knowledge this repo
    // gave up on 2026-08-19: a caller wanting to transmit says 'public' or
    // 'private' and the gateway resolves it on the radio addressed.
    // docs/modules/channels.md.
  };
}

/** Does this radio need aiming before we transmit through it? */
export function isDirectional(spec, ctx = {}) {
  return resolveRadio(spec, ctx)?.directional ?? false;
}

/** Which rotator serves this radio, or null if none can steer it. */
export function rotatorFor(spec, ctx = {}) {
  return resolveRadio(spec, ctx)?.rotatorId ?? null;
}
