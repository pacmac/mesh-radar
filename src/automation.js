// automation — @verb commands, broadcast on the Private channel, acted on and
// answered as a reply. Spec: docs/modules/automation.md.
//
// THE POINT: one person in a field drives the home station and gets a measurement
// back, with nobody at the dashboard. Peter, 2026-08-14: "a remote survey where I
// pinged home 11 times to test different antannae locations".
//
// He set the surface: verbs prefixed "@" ("a commmand verb would be prefixed by
// `@` i.e `@xxxx`"), arriving as broadcasts, not DMs ("DM no, BC on Private
// Channels"), with every reply stamped and threaded ("all replies start with a
// short form time stamp: 12:15 XXXX and they should be REPLIES to the command").

import { getConfig } from './db.js';
// Automations run on the PRIVATE channel. Peter, 2026-08-16: "FYI for the time
// being automations will work on private channel." The role is asked for by name
// — `indexFor(radio, 'pri')` — never by index, and never by assuming index 1.
import { isRole, indexFor } from './channels.js';
import { sendMeshText } from './mesh-send.js';
import { nodeList } from './node-list.js';
import { rotator } from './rotator.js';
import { bearing as bearingOf, signalQuality, numToNodeId, nodeIdToNum } from './utils.js';
import { resolveDeviceLabel } from './node-label.js';
import { fmtStamp } from './format.js';
import { defineHook } from './hooks.js';

const BROADCAST_NUM = 0xffffffff;

// ── the ceiling lives in code ────────────────────────────────────────────────
// callout.js's rule, for callout.js's reason: config may only LOWER these, and
// there is deliberately no way to raise them without a commit. Private is not the
// public mesh, but a rotator that answers every broadcast forever is still a
// fault, and an unattended transmitter is the failure a commit cannot undo.
const HARD_MAX_REPLIES_PER_HOUR = 60;

// How long the beam is held for a @point, and it is a CEILING not a duration:
// the yagi is SHARED with the garage alarm. Long enough for the sender to send
// the next packet of a survey, short enough that the alarm is never locked out.
const POINT_HOLD_MS = 30_000;

const H = {
  ran: defineHook({
    name: 'automation-verb-ran', scope: 'actuator',
    purpose: 'records a @verb accepted from the private channel, who sent it, and what it did',
  }),
  refused: defineHook({
    name: 'automation-verb-refused', scope: 'actuator',
    purpose: 'records a @verb that a guard stopped, and names the guard — silence must be explainable',
  }),
};

// Packet ids already acted on.
//
// BOTH RADIOS HEAR THE SAME BROADCAST. Measured 2026-08-14 in the live store:
// packet 3049001458 was stored twice, once per radio. Without this set a single
// "@point" moves the rotator TWICE and answers twice.
//
// ws-relay has its own `_seenLivePktIds` and it is NOT shared: that one is
// cleared on bridge reconnect for reasons of its own, and a reconnect must not
// make us re-execute a command we already ran.
const _handled = new Set();
const HANDLED_CAP = 500;

// Reply timestamps, newest last — the rate ceiling's evidence.
let _replyTimes = [];

export function automationEnabled() {
  return getConfig('automation.enabled', false) === true;
}

/** WHO MAY COMMAND. Peter, 2026-08-14, declining a restriction I proposed:
 *  "no need to restrict from my nodes, this is a provate channel. I am not
 *  bothered about that at this point."
 *
 *  So this returns true, deliberately. It EXISTS rather than being absent because
 *  of his own "at this point": if an allowlist is ever wanted there is one
 *  function to change, not a hole to find. Do not delete it as dead code. */
export function senderAllowed(_fromNum) {
  return true;
}

/** Replies per hour, against the ceiling. Config may lower, never raise. */
function replyBudgetLeft() {
  const cfgMax = Number(getConfig('automation.max_replies_per_hour', HARD_MAX_REPLIES_PER_HOUR));
  const max = Math.min(HARD_MAX_REPLIES_PER_HOUR, Number.isFinite(cfgMax) ? cfgMax : HARD_MAX_REPLIES_PER_HOUR);
  const cutoff = Date.now() - 3_600_000;
  _replyTimes = _replyTimes.filter(t => t > cutoff);
  return max - _replyTimes.length;
}

/** Send one reply: stamped, threaded, on the private slot of the radio that heard
 *  the command.
 *
 *  DROPS RATHER THAN FALLS BACK when the private slot cannot be resolved. A
 *  fallback to channel 0 is PRIMARY — the public mesh — so answering a private
 *  command there would be the worst outcome this whole path can produce. */
async function reply(device, toPktId, body) {
  const channel = indexFor(device, 'pri');
  if (channel == null) {
    H.refused.emit({
      summary: `automation reply dropped — no private channel resolves on ${resolveDeviceLabel(device) || device}`,
      detail: { guard: 'no-private-channel', device }, severity: 'warn',
    });
    console.warn(`[automation] no private channel on ${device} — reply dropped, NOT sent on 0`);
    return false;
  }
  // Peter: "all replies start with a short form time stamp: 12:15 XXXX".
  // fmtStamp is the same server-side formatter the pages use — "12:15" today,
  // "19 Jul 07:08" if a reply is ever read back later.
  const text = `${fmtStamp(Math.floor(Date.now() / 1000))} ${body}`;
  await sendMeshText({
    gatewayNodeId: device,
    text,
    channel,
    // Peter: "they should be REPLIES to the command." With several pings in
    // flight this is the only thing that says which answer belongs to which.
    reply_id: toPktId ?? null,
    category: 'automation',
  });
  _replyTimes.push(Date.now());
  return true;
}

/** Resolve a verb's argument to a node num. `!hex`, or omitted = the sender.
 *
 *  DEFAULTING TO THE SENDER is deliberate and is not what Peter's sketch said
 *  ("point xxx"). In a field, one-handed, the node you want pointed at is you,
 *  and typing your own id is exactly the friction this exists to remove. */
function resolveTarget(arg, fromNum) {
  if (!arg) return fromNum;
  const a = arg.trim();
  if (a.startsWith('!')) {
    const n = nodeIdToNum(a);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;   // no name lookup — see the spec's "what this module does not do"
}

// ── the verbs ────────────────────────────────────────────────────────────────
// Closed and small, in probe-plan.js's shape and for its stated reason: an
// open-ended DSL becomes a language nobody can validate, and its failure mode is
// a silently-ignored step. Contents hard-coded for now by Peter's instruction;
// the SHAPE is the eventual one, so a config-backed table later replaces the
// contents and not the machinery.
export const VERBS = {
  point: {
    args:    '[!node]  (default: you)',
    purpose: 'aim the YAGI at that node, hold briefly, release',
    async run({ target, device, pktId }) {
      const home = nodeList.homePos;
      if (!home) return reply(device, pktId, 'point: no home position set');
      // POSITION IS `position.latitude_i` — Meshtastic integer degrees x 1e7 —
      // NOT `lat`/`lon`. Reading `node.lat` returned undefined for a node whose
      // position we plainly held, and the verb answered "no position" over the
      // air. Caught by a real @point, not by a fixture; active-tracker.js:43
      // does the same conversion.
      const node = nodeList._cache?.get(target);
      const latI = node?.position?.latitude_i;
      const lonI = node?.position?.longitude_i;
      if (latI == null || lonI == null) {
        return reply(device, pktId, `point: no position for ${numToNodeId(target)}`);
      }
      const az = Math.round(bearingOf(home.lat, home.lon, latI / 1e7, lonI / 1e7));
      // THE ROTATOR IS SHARED with the garage alarm. point() already waits out
      // another holder's stated hold rather than fighting it; `by` names us in
      // its lock, and the hold is a brief one we release.
      const r = await rotator.point(az, { hold: POINT_HOLD_MS, by: 'automation' });
      if (r?.busy)    return reply(device, pktId, `point: ${az}deg busy, retry in ${Math.round((r.retryInMs ?? 0) / 1000)}s`);
      if (r?.timeout) return reply(device, pktId, `point: ${az}deg timed out`);
      if (!r?.ok)     return reply(device, pktId, `point: ${az}deg failed`);
      return reply(device, pktId, `point: yagi at ${az}deg, holding ${POINT_HOLD_MS / 1000}s`);
    },
  },

  ping: {
    args:    '(none)',
    purpose: 'answer with the signal of the packet that carried the command',
    async run({ device, pktId, rssi, snr, hops, radioName }) {
      const q = signalQuality(rssi, snr);
      const bits = [
        rssi != null ? `${Math.round(rssi)}dBm` : 'rssi?',
        snr  != null ? `${snr.toFixed(1)}dB`    : 'snr?',
        hops != null ? `${hops}hop`             : 'hops?',
        `${q}%`,
      ];
      // NAMES THE RADIO, because both may have heard it and a signal number that
      // does not say which antenna produced it is useless for a survey.
      return reply(device, pktId, `pong ${radioName} ${bits.join(' ')}`);
    },
  },

  // @route — REMOVED 2026-08-17, task `traceroute-callers-rewrite`.
  //
  // Peter: "no re-implementation logic will be decided until all existing calls
  // to it are completely removed from code." Nothing in node-dash dispatches a
  // traceroute now, so this verb could not do what its name says.
  //
  // It is DELETED rather than left answering "not available". An advertised verb
  // that always fails is worse than an absent one: it reads as a fault in the
  // radio path, which is the hardest thing here to diagnose from a field.
  // @point and @ping are unaffected and still work.
};

/** Handle one bridge event. Called from registerBridgeEvents.
 *
 *  EVERY GATE FAILURE IS SILENCE. A command we cannot verify is private, or
 *  cannot answer safely, produces nothing — never a guess and never a public
 *  transmission. */
export function handleAutomationEvent(ev) {
  if (ev?.type !== 'packet') return;
  const pkt = ev.data?.packet;
  if (pkt?.decoded?.portnum !== 'TEXT_MESSAGE_APP') return;

  // BROADCAST ONLY. Peter: "DM no, BC on Private Channels".
  if ((pkt.to >>> 0) !== BROADCAST_NUM) return;

  const device = ev.__ble_addr ?? ev.addr ?? ev.device ?? null;
  if (!device) return;

  // THE ONLY PERMITTED PRIVACY TEST — channels.js, never an index literal.
  // Private is index 2 on one of our radios and 1 on the other, and index 1 on
  // the first is `mqtt`, which is unencrypted.
  if (!isRole(device, pkt.channel ?? 0, 'pri')) return;

  const text = pkt.decoded?.payload
    ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8').trim() : '';
  if (!text.startsWith('@')) return;

  // Both radios hear the same broadcast — act once. See _handled above.
  const pktId = pkt.id ?? null;
  if (pktId != null) {
    if (_handled.has(pktId)) return;
    _handled.add(pktId);
    if (_handled.size > HANDLED_CAP) {
      for (const id of _handled) { _handled.delete(id); if (_handled.size <= HANDLED_CAP) break; }
    }
  }

  const fromNum = pkt.from >>> 0;
  const [rawVerb, ...rest] = text.slice(1).split(/\s+/);
  const verb = (rawVerb || '').toLowerCase();

  // Disabled ships silent: it must not answer to say it is off, or an unattended
  // process is transmitting for a feature nobody turned on.
  if (!automationEnabled()) {
    H.refused.emit({
      summary: `@${verb} from ${numToNodeId(fromNum)} ignored — automation is disabled`,
      detail: { guard: 'disabled', verb, from: fromNum },
    });
    return;
  }
  if (!senderAllowed(fromNum)) {
    H.refused.emit({
      summary: `@${verb} from ${numToNodeId(fromNum)} refused — sender not permitted`,
      detail: { guard: 'sender', verb, from: fromNum }, severity: 'warn',
    });
    return;
  }
  if (replyBudgetLeft() <= 0) {
    H.refused.emit({
      summary: `@${verb} from ${numToNodeId(fromNum)} dropped — hourly reply ceiling reached`,
      detail: { guard: 'rate-ceiling', verb, from: fromNum }, severity: 'warn',
    });
    console.warn(`[automation] reply ceiling reached — @${verb} from ${numToNodeId(fromNum)} dropped`);
    return;
  }

  const spec = VERBS[verb];
  if (!spec) {
    // AN UNKNOWN VERB IS ANSWERED WITH SILENCE, and this is not laziness — the
    // first live test proved why. A third party on the private channel sent
    // "@claude", ordinary human chatter that merely began with "@", and this
    // branch broadcast "? @point @ping @route" back at the whole channel.
    //
    // "@" is not ours. It is a perfectly normal way to address a person, and a
    // machine that answers every message beginning with one is the nuisance
    // callout.js exists to avoid: "we dont want to make ourselves unpopular".
    //
    // The cost is that a typo gets no response. That is the right trade: the
    // refusal is recorded here and on the dashboard's event log, so it is
    // explainable to US without being broadcast at everybody else.
    H.refused.emit({
      summary: `@${verb} from ${numToNodeId(fromNum)} is not a known verb — no reply sent`,
      detail: { guard: 'unknown-verb', verb, from: fromNum, known: Object.keys(VERBS) },
    });
    return;
  }

  const target = resolveTarget(rest[0], fromNum);
  if (target == null) {
    reply(device, pktId, `${verb}: bad target — use !hex or omit for yourself`)
      .catch(e => console.warn(`[automation] bad-target reply failed: ${e?.message}`));
    return;
  }

  const hops = (pkt.hop_start != null && pkt.hop_limit != null)
    ? Math.max(0, pkt.hop_start - pkt.hop_limit) : null;

  H.ran.emit({
    summary: `@${verb} from ${numToNodeId(fromNum)} on the private channel, target ${numToNodeId(target)}`,
    detail: { verb, from: fromNum, target, device, pkt_id: pktId },
  });

  spec.run({
    target, device, pktId, fromNum,
    rssi: pkt.rx_rssi ?? null,
    snr:  pkt.rx_snr  ?? null,
    hops,
    // The RADIO THAT HEARD IT, by its friendly name (OMNI/YAGI). Both may have
    // heard the broadcast; a signal figure that does not say which antenna
    // produced it is useless for an antenna survey, which is the whole use case.
    radioName: resolveDeviceLabel(device) || device,
  }).catch(e => {
    console.warn(`[automation] @${verb} failed: ${e?.message}`);
    reply(device, pktId, `${verb}: error`).catch(() => {});
  });
}
