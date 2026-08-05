// ── Traceroute SSOT module ────────────────────────────────────────────────────
//
// Single owner of the entire traceroute lifecycle:
//   dispatch()     — send a traceroute request via bridge
//   handlePacket() — decode TRACEROUTE_APP response, extract relay_positions,
//                    persist to SQLite, emit 'result'
//
// Callers pass args (to, device, cooldown) — this module knows nothing about
// which mode triggered it.  Mode logic stays in the caller.
//
// Events emitted:
//   'start'   { to, device }   — fired when a NEW dispatch begins (not when joining existing)
//   'result'  { from, route, route_back, snr_towards, snr_back, relay_positions, ts }
//             — fired for EVERY completed traceroute regardless of trigger
//   'cancel'  { to }           — fired on timeout or bridge send error
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { bridge }       from './bridge.js';
import { nodeList }     from './node-list.js';
import { stmts, getConfig, radioAirtime } from './db.js';
import { pasvConfig, discoveryConfig } from './config-api.js';
import { getRotatorAddress } from './device-config.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { rotator } from './rotator.js';
import { dashMode, modeName, modeAim, transmitterForMode } from './dash-mode.js';
import { doorAim } from './doors.js';
// Proven direct-reach set — the bypass branch may only aim at a relay we have
// actually transmitted to, never at one we merely know about.
import { provenDoors } from './node-kind.js';
import { getDeviceCfg } from './device-config.js';

/** ONE DEVICE VOCABULARY FOR EVERY LOOKUP AND COMPARE. Task
 *  `aim-provenance-requested-az`.
 *
 *  `transmitterForMode()` returns a NODE_ID (it ends in `macToNodeId(mac)`).
 *  `getRotatorAddress()` returns a MAC. `getDeviceCfg()` keys on uppercase MAC.
 *  Handing a node_id to either the config lookup or the rotator identity compare
 *  silently fails — and both were being handed one:
 *
 *    getDeviceCfg('!39f7b6')                  -> {...DEFAULT}, beam_deg 360
 *    '!39F7B6' !== 'F4:12:FA:39:F7:B6'        -> "radio is not on the rotator"
 *
 *  ...said about the rotator's own radio, so every `radio: 'auto'` dispatch went
 *  out unaimed, in every mode. The recorded beam_deg of 360 on a device configured
 *  35 was the fingerprint; the discovery loop never pointing the antenna was the
 *  defect. Same resolution rule already used by the row recorder below.
 *
 *  NOT applied to the device passed on to dispatch() — that value goes to the
 *  bridge REST call, and the transmit path is deliberately left untouched. */
function toMac(device) {
  if (!device) return null;
  const s = String(device);
  return s.includes(':') ? s.toUpperCase() : (getLiveMacByNodeId(device) ?? s);
}

/** The transmitting antenna's beamwidth, so a 3-element and a 7-element yagi
 *  stay separable in the data when Peter upgrades. Null when unknown — never a
 *  guessed default, which would silently merge the two. */
function beamwidthFor(device) {
  const mac = toMac(device);
  if (!mac) return null;
  const cfg = getDeviceCfg(mac);
  const d = Number(cfg?.beam_deg);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Bearing from home to a node, for aim:'endpoint'. Deliberately separate from
 *  doorAim: pointing at the endpoint is a DIFFERENT and usually worse choice,
 *  and the two must never quietly substitute for one another. */
function bearingToNode(num) {
  // `nodeList.get(num)` DOES NOT EXIST — the class has getters `homePos`,
  // `nodes`, `ownDeviceNodes` and no `get(num)` method. Written as
  // `nodeList.get?.(num)`, the optional call swallowed that silently: it
  // evaluated to undefined every single time, so this returned null on every
  // call and `aim: 'endpoint'` could NEVER aim. Verified 2026-08-04 by
  // dispatching on the yagi with aim=endpoint and getting aim_mode='none'.
  //
  // That also invalidates the claim in run()'s header that endpoint-aiming
  // "underperforms not aiming at all in every distance band" — it was never
  // measured against anything, because it never ran.
  //
  // Read the same source doors.js uses (`nodes` table via db), so the two aim
  // modes cannot silently disagree about where a node is.
  const n = stmts.getNodeByNum.get(num) ?? null;
  const lat = n?.lat;
  const lon = n?.lon;
  if (!lat || !lon) return null;
  const h = { lat: getConfig('home.lat'), lon: getConfig('home.lon') };
  if (h.lat == null || h.lon == null) return null;
  const r = Math.PI / 180;
  const y = Math.sin((lon - h.lon) * r) * Math.cos(lat * r);
  const x = Math.cos(h.lat * r) * Math.sin(lat * r)
          - Math.sin(h.lat * r) * Math.cos(lat * r) * Math.cos((lon - h.lon) * r);
  return Math.round((Math.atan2(y, x) / r + 360) % 360);
}

const log = {
  info: (...a) => console.log('[traceroute]',      ...a),
  warn: (...a) => console.log('[traceroute] warn:', ...a),
};

// Single copy of relay_positions lookup — previously duplicated in
// index.js:635–641 and passive-tracer.js:63–71.
function extractRelayPositions(route) {
  const relay_positions = {};
  for (const num of route ?? []) {
    const info = stmts.getNodeinfoByNum.get(num);
    if (info?.lat != null && info?.lon != null) {
      relay_positions[num] = {
        latitude_i:  Math.round(info.lat * 1e7),
        longitude_i: Math.round(info.lon * 1e7),
      };
    }
  }
  return relay_positions;
}

// Is AUTOMATIC traceroute dispatch enabled? Persisted (config key
// THE GLOBAL SWITCH IS GONE. Peter, 2026-08-04: "the traceroute button that
// exists should not be there. traceroute is a node function and NOT a global
// switch."
//
// tracerouteEnabled() gated every non-manual dispatch on a single config key.
// It was a SECOND OWNER of behaviour dash-mode owns: with it off, DISC ran and
// attempted nothing, and the only clue was one line in the mission runner's
// idle reason — the same hole that hid passive tracing for 9.5 hours.
//
// Automatic tracing is now a property of the MODE (Config -> Modes), where
// rx/tx/aim/radio already live. To stop tracing, change mode.

class TracerouteManager extends EventEmitter {
  constructor() {
    super();
    // _pending: to_num → { callbacks: [{resolve, reject}], timer }
    // Multiple callers waiting on the same node share one pending entry.
    this._pending   = new Map();
    // _cooldowns: cooldownKey → timestamp of last dispatch
    this._cooldowns = new Map();
  }

  // ── run(target, opts) ──────────────────────────────────────────────────────
  //
  // TRACEROUTE AS A FUNCTION, NOT A RADIO COMMAND. Peter, 2026-08-04: "it needs
  // to be able to do all of the things that we actually would do manually step
  // by step."
  //
  // The manual sequence, run by hand on 2026-08-04, IS this function. Three of
  // its steps existed nowhere: resolving the DOOR, WAITING FOR THE BEAM, and
  // RECORDING what was aimed at.
  //
  //   opts.radio  'auto' | 'omni' | 'yagi' | <mac>   default: the mode's tx
  //   opts.aim    'door' | 'endpoint' | 'none' | <az>  default: the mode's aim
  //
  // `aim: 'none'` is a FIRST-CLASS setting, not a fallback.
  //
  // THE CLAIM THAT USED TO BE HERE — "endpoint-aiming underperforms not aiming at
  // all in every distance band" — WAS FALSE, and is struck rather than quietly
  // deleted. bearingToNode() called a `nodeList.get()` that does not exist, so
  // endpoint-aiming never once executed; the "measurement" compared unaimed
  // attempts against other unaimed attempts. Door-aiming likewise did not run
  // until 2026-08-04 17:18. NEITHER mode has been evaluated. Both now execute and
  // record requested-vs-arrived azimuth, so the comparison can finally be made.
  //
  // Peter: "just because yagi pointing has not resulted in any
  // benefits ... it should not be removed, it is an asset." So it stays,
  // configurable, and now records enough to prove itself when the yagi goes
  // from 3 to 5 to 7 elements.
  async run(target, opts = {}) {
    const to = Number(target);
    if (!to) throw new Error('target required');

    const modeKey  = modeName(dashMode.value);
    const device   = this._resolveRadio(opts.radio, modeKey);
    if (!device) throw new Error('no radio for this mode');

    // ONE AIM PER MISSION. Task `mission-runner-single-aim`.
    //
    // A caller that has ALREADY pointed the beam supplies its aim context here
    // and we do not point again. Two commands to a SHARED rotator is not free
    // even when the second is a no-op: it widens the window for the neighbouring
    // app to take the beam between our aim and our transmit, and it lets this
    // function silently override a decision the caller made — mission-runner
    // declines to move when the door is inside omni reach, and _resolveAim has
    // no such rule.
    //
    // The context must be the same shape _resolveAim returns, so the recorded
    // provenance is identical either way.
    // beam_deg is ALWAYS ours, even on a supplied context. It describes the
    // TRANSMITTING antenna, and only this function knows which radio the dispatch
    // resolved to — mission-runner's context is built around the ROTATOR, so
    // taking its beam_deg verbatim would stamp 35 on rows the OMNI transmitted.
    // (Introduced and caught here, before it reached a row.)
    const aim = opts.aimCtx
      ? { ...opts.aimCtx, beam_deg: beamwidthFor(device) }
      : await this._resolveAim(to, opts.aim, modeKey, device, opts);

    return this.dispatch({
      to, device,
      timeoutMs:   opts.timeoutMs,
      cooldownMs:  opts.cooldownMs,
      cooldownKey: opts.cooldownKey,
      manual:      opts.manual ?? false,
      aimCtx:      aim,
    });
  }

  /** Which radio. An ARGUMENT, not a side-effect of the mode — that is the
   *  defect that let DISC compute a door bearing and then transmit omni. */
  _resolveRadio(radio, modeKey) {
    if (!radio || radio === 'auto') return transmitterForMode(modeKey);
    const rot = getRotatorAddress();
    if (radio === 'yagi') return rot;
    if (radio === 'omni') {
      const tx = transmitterForMode(modeKey);
      // The non-rotator radio. If the mode's tx IS the rotator, we cannot infer
      // the other one here without device config; fall back rather than guess.
      return (rot && tx && tx.toUpperCase() === rot.toUpperCase()) ? tx : tx;
    }
    return radio;   // an explicit MAC or node id
  }

  // ── _decideAim(to) ─────────────────────────────────────────────────────────
  //
  // THE DECISION THE REWORK WAS FOR. Peter, 2026-08-05: "right now traceroute
  // still points at eps".
  //
  // Until now _resolveAim was a flat switch on a static per-mode setting —
  // whatever the config said, every time, regardless of what we know about the
  // target. That shipped the instrumentation and skipped the intelligence.
  //
  // WHY AIMING AT THE ENDPOINT IS WRONG. Measured over 2726 completed traces:
  // the first hop is inside the endpoint's 35 degree beam only 12.9% of the
  // time, and more than 135 degrees away — behind the antenna — 53.4% of the
  // time. Mean separation 102.6 degrees. We transmit to the DOOR, not to the
  // destination, so the destination's bearing is the wrong thing to point at.
  //
  // THE RULE, in evidence order:
  //
  //   1. Known route, door FAR      -> aim at the door. It is the node our
  //                                    transmission actually has to reach, and
  //                                    it is far enough for gain to matter.
  //   2. Known route, door CLOSE    -> try to BYPASS it: aim at hop 2, if we
  //                                    provably reach hop 2 directly and it is
  //                                    better aligned to the endpoint. Reaching
  //                                    it removes a hop permanently.
  //                                    Measured: 155 such cases. PJ1 alone has
  //                                    44 — endpoint 62deg/3km, hop1 T4 at
  //                                    274deg, hop2 WLCD at 62deg/3km.
  //   3. Known route, door close,
  //      no bypass candidate        -> do not rotate. The door is inside omni
  //                                    reach and the beam is theatre.
  //   4. No known route             -> aim at the endpoint. NOT to follow a
  //                                    route — there isn't one — but as a bet on
  //                                    DIRECT contact, which is the only thing
  //                                    that creates a new door.
  //
  // Every branch records its own mode, so the row says which rule fired.
  _decideAim(to) {
    const none = { az: null, aimTarget: null, mode: 'none' };
    let route = null;
    try { route = JSON.parse(stmts.latestRouteTo.get(to)?.route ?? 'null'); } catch { /* no route */ }

    // 4. Nothing known: bet on a direct contact.
    if (!Array.isArray(route) || !route.length) {
      const b = bearingToNode(to);
      return b == null ? none : { az: b, aimTarget: to, mode: 'endpoint' };
    }

    const d = doorAim(to);
    // 1. The door is far enough that the beam buys something.
    if (d && d.az != null && d.needsBeam) return { az: d.az, aimTarget: d.door, mode: 'door' };

    // 2. The door is close. Can we skip it?
    const hop2 = route[1];
    if (hop2 != null && hop2 !== 0xffffffff && provenDoors().has(Number(hop2))) {
      const b2 = bearingToNode(hop2), be = bearingToNode(to);
      if (b2 != null && be != null) {
        const sep = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
        const b1 = d?.az;
        // Only worth it if hop2 points nearer the endpoint than the door does —
        // otherwise we are just aiming somewhere else for no reason.
        if (b1 == null || sep(b2, be) < sep(b1, be)) {
          return { az: b2, aimTarget: hop2, mode: 'bypass' };
        }
      }
    }
    // 3. Close door, no bypass worth taking: do not spend the beam.
    return none;
  }

  /** Where to point, and WAIT FOR IT TO GET THERE.
   *
   *  Returns { mode, target, az, beam_deg, settled } — the provenance that goes
   *  on the row. Never throws: a rotator that will not move must not stop a
   *  trace, it must be recorded as unaimed. */
  async _resolveAim(to, aimOpt, modeKey, device, opts = {}) {
    const beam_deg = beamwidthFor(device);
    const want = aimOpt ?? modeAim(modeKey) ?? 'none';

    if (want === 'none' || want == null) return { mode: 'none', target: null, az: null, beam_deg, settled: false };

    let az = null, aimTarget = null, mode = 'none';
    if (typeof want === 'number') { az = want; mode = 'endpoint'; }
    else if (want === 'auto')     ({ az, aimTarget, mode } = this._decideAim(to));
    else if (want === 'door') {
      const d = doorAim(to);
      if (d && d.az != null) { az = d.az; aimTarget = d.door; mode = 'door'; }
    } else if (want === 'endpoint') {
      const b = bearingToNode(to);
      if (b != null) { az = b; aimTarget = to; mode = 'endpoint'; }
    }
    if (az == null) return { mode: 'none', target: null, az: null, beam_deg, settled: false };

    // ONLY THE ROTATOR RADIO CAN BE AIMED. Recorded as 'none' rather than
    // pretending, so the row is honest about what actually happened.
    // BOTH SIDES IN MAC SPACE. A node_id-vs-MAC compare here is always false, so
    // this returned "not on the rotator" about the rotator itself — see toMac().
    const rot = getRotatorAddress();
    const devMac = toMac(device);
    if (!rot || !devMac || devMac.toUpperCase() !== rot.toUpperCase())
      return { mode: 'none', target: null, az: null, beam_deg, settled: false, note: 'radio is not on the rotator' };

    this.emit('aiming', { to, az, via: aimTarget, mode });
    let settled = false, azActual = null;
    try {
      // point(), NOT move(). Peter, 2026-08-04: "remember that the pointer has a
      // hold and handshakes when it is moving."
      //
      // point() IS that handshake — are you free, move now, maybe hold; if it is
      // busy it says so and waits out the other holder's window. move() fires
      // and forgets, so the first version of this polled status on a timer and
      // could still transmit mid-slew. It also HOLDS the beam through the reply,
      // which is the whole reason the antenna is pointed in the first place.
      //
      // THE ROTATOR IS SHARED, AND IT TELLS YOU SO. Peter, 2026-08-04: "the
      // rotator is also being used by a different app, every 15 minutes it might
      // point and hold the rotator for up to 15 seconds, but the pointer will
      // tell you that if you know how to ask."
      //
      // NOT SPECIFIED HERE. Peter: "that is an issue with the node-dash pointer
      // code and not really traceroute. traceroute calls the pointer code, it is
      // the one that needs fixing." Waiting out a neighbour's hold is the
      // rotator's policy and now its default — this asks, it does not dictate.
      // NO INVENTED NUMBERS. Peter, 2026-08-04: "stop setting arbitrary timings
      // and stop hard coding timings ... what is the basis for your 5 second
      // calculation, why not use 2 days instead of 5 seconds ... they are simply
      // just a random number you pick. STOP DOING THAT."
      //
      // He is right, and every value I had invented already existed as config
      // with a stated meaning. Each one below names its source and its basis:
      //
      //   hold      discovery.hold_sec       the operator's answer to "how long
      //                                      may we hold a SHARED beam" — this
      //                                      is a policy about the neighbour,
      //                                      not about us, so it is config
      //   timeoutMs discovery.aim_timeout_sec  the existing budget for an aim
      //   patience  NOT PASSED — the rotator honours the hold it was told about
      //
      // Anything unset falls through to the caller's opts, and only then to the
      // rotator's own defaults. Nothing here is a literal.
      const d = discoveryConfig();
      const holdMs = opts.hold_ms ?? (Number(d.hold_sec) > 0 ? Number(d.hold_sec) * 1000 : undefined);
      const aimMs  = opts.settle_ms ?? (Number(d.aim_timeout_sec) > 0 ? Number(d.aim_timeout_sec) * 1000 : undefined);
      let r = await rotator.point(az, {
        by: 'traceroute',
        ...(holdMs !== undefined ? { hold: holdMs } : {}),
        ...(aimMs  !== undefined ? { timeoutMs: aimMs } : {}),
        ...(opts.patience_ms !== undefined ? { patienceMs: opts.patience_ms } : {}),
      });
      settled = !!(r && r.ok && !r.busy);
      if (r && r.az != null && Number.isFinite(Number(r.az))) azActual = Number(r.az);

      // ASK IT A SECOND TIME IF IT LANDED OUTSIDE THE BEAM. Peter, 2026-08-04:
      // "if it's so far out you can ask it a second time. this issue is resolved
      // in v5 but you have to make do with what you have for now."
      //
      // Measured on the first five door aims: the v4 either lands within 0-2
      // degrees or misses by 112-140. A miss leaves a 9 dBi beam pointing at
      // nothing, which is WORSE than not aiming — so one re-issue is worth the
      // seconds. Long arcs overshoot; a second, shorter move usually lands.
      //
      // The threshold is HALF THE CONFIGURED BEAMWIDTH — from device config,
      // never a literal, and null means "cannot judge, do not retry".
      // One retry, never a loop: mission-runner already settled on that rule.
      const half = beam_deg != null ? beam_deg / 2 : null;
      const errOf = (got) => Math.abs(((Number(got) - az + 540) % 360) - 180);
      // ONE RE-ISSUE IS USUALLY ENOUGH, AND SOMETIMES IT IS NOT. Measured
      // 2026-08-04 over seven aims with deliberately long slews:
      //
      //   first attempt inside the 35 deg beam:  2/7   (29%)
      //   after one re-issue:                    6/7   (86%)
      //
      // The one that still missed was a 121->351 slew: it stopped at 276, and the
      // re-issue overshot to 59. Both outside the beam, so that shot went out
      // pointed at nothing — worse than not aiming, because the gain is real.
      //
      // So the count is a KNOB, not a literal, and its default has the numbers
      // above as its basis (`discovery.aim_retries`). It stops the moment the aim
      // is inside the half-beam, so a good first move costs nothing extra.
      const maxRetries = Number.isFinite(Number(d.aim_retries)) ? Number(d.aim_retries) : 0;
      for (let i = 0; i < maxRetries; i++) {
        if (half == null || !r || r.az == null || r.busy || errOf(r.az) <= half) break;
        r = await rotator.point(az, {
          by: 'traceroute',
          ...(holdMs !== undefined ? { hold: holdMs } : {}),
          ...(aimMs  !== undefined ? { timeoutMs: aimMs } : {}),
        });
        if (r && r.az != null) { settled = !!(r.ok && !r.busy) && errOf(r.az) <= half; azActual = Number(r.az); }
      }
      // WHERE IT SAYS IT GOT TO. Peter, 2026-08-04: "the yagi rotates at about
      // 60rpm, point and settle should never take more than about 1.5 seconds,
      // but the point is, the pointer will tell you when it has reached, you do
      // not have to guess."
      //
      // point() already waits for the rotator's `done` handshake, and that
      // message carries the arrived azimuth. Captured HERE, at the moment of
      // arrival — see _recordFailure for why sampling it later was wrong.
    } catch { /* a rotator failure must not stop the trace — record unsettled */ }
    this.emit('aimed', { to, az, az_actual: azActual, via: aimTarget, mode, settled });
    return { mode, target: aimTarget, az, az_actual: azActual, beam_deg, settled };
  }

  // ── dispatch({ to, device, timeoutMs?, cooldownMs?, cooldownKey?, manual? }) ─
  // Returns a Promise that resolves with the result or rejects on timeout/error.
  // cooldownKey + cooldownMs: skip dispatch if key was dispatched within cooldownMs.
  // manual: a user-initiated request. Never gated by the master switch.
  dispatch({ to, device, timeoutMs, cooldownMs, cooldownKey, manual = false, aimCtx = null } = {}) {
    if (!to || !device) return Promise.reject(new Error('to and device are required'));

    // Master switch (task `traceroute-manual-enable`). Before this existed there
    // was no mode in which traceroute was off: PASV traced every heard packet,
    // ACTV traced each rotator point_target, SCAN traced each contact. Gated
    // HERE because dispatch() is the one chokepoint all callers pass through, so
    // a future caller cannot accidentally bypass it — the failure that let
    // imap-receiver and op-manager post around mesh-send's "single send path".
    //
    // Checked BEFORE the cooldown guard: a disabled dispatch must not consume
    // the cooldown slot, or re-enabling would silently skip the next attempt.
    // Cooldown guard — caller's responsibility to pass the right key/window
    if (cooldownMs != null && cooldownKey != null) {
      const last = this._cooldowns.get(cooldownKey) ?? 0;
      if (Date.now() - last < cooldownMs) {
        return Promise.reject(new Error(`cooldown: ${cooldownKey}`));
      }
      this._cooldowns.set(cooldownKey, Date.now());
    }

    // NO SECOND COPY OF THE NUMBER. This was `cfg.timeout_sec ?? 60`, restating
    // a default that config-api already declares in PASV_DEFAULTS — two places
    // to change, one of which would drift. pasvConfig() resolves defaults over
    // the stored override, so the value is declared exactly once.
    const effectiveMs    = timeoutMs ?? (Number(pasvConfig().timeout_sec) * 1000);

    return new Promise((resolve, reject) => {
      const existing = this._pending.get(to);

      if (existing) {
        // Another dispatch already in flight for this node — join it
        existing.callbacks.push({ resolve, reject });
        log.info(`joined pending dispatch for !${to.toString(16)}`);
        return;
      }

      // startedAt is what makes a miss diagnosable: without it a timeout row
      // cannot say whether we waited 5 s or 90 s. Task `timeout-diagnosis`.
      const entry = { callbacks: [{ resolve, reject }], timer: null, device, startedAt: Date.now(),
                      // AIM CONTEXT rides the pending entry so a timeout row can
                      // say what it was pointed at. Set by run(); a bare
                      // dispatch() leaves it null, which is honest — unknown, not
                      // 'none'. Task `traceroute-rework`.
                      aim: aimCtx ?? null };

      entry.timer = setTimeout(() => {
        if (this._pending.get(to) === entry) {
          this._pending.delete(to);
          const err = new Error(`timeout !${to.toString(16)}`);
          log.warn(err.message);
          for (const cb of entry.callbacks) cb.reject(err);
          this._recordFailure(to, device, 'timeout', entry.startedAt, entry.aim);
        }
      }, effectiveMs);

      this._pending.set(to, entry);
      this.emit('start', { to, device });
      log.info(`dispatch to !${to.toString(16)} via ${device}`);

      // gw device paths are addressed by BLE MAC — always valid, whereas a
      // node_id 404s before first sync (IDENTITY.md §2). `device` itself
      // stays node-id vocabulary: it is the tx_device attribution key.
      const pathKey = getLiveMacByNodeId(device) ?? device;
      bridge.post(`/${pathKey}/traceroute`, { to }).catch(err => {
        if (this._pending.get(to) === entry) {
          clearTimeout(entry.timer);
          this._pending.delete(to);
          log.warn(`send failed !${to.toString(16)}: ${err.message}`);
          for (const cb of entry.callbacks) cb.reject(err);
          this._recordFailure(to, device, 'send_failed', entry.startedAt, entry.aim);
        }
      });
    });
  }

  // ── _recordFailure(to, device, reason) ─────────────────────────────────────
  // Failed attempts get a traceroute_history row (status='timeout'|'send_failed',
  // payload columns NULL) — without them every stat is survivorship-biased.
  // One pending entry = one row, regardless of joined callers.
  _recordFailure(to, device, reason, startedAt = null, aim = null) {
    const aimMode   = aim?.mode   ?? null;
    const aimTarget = aim?.target ?? null;
    const beamDeg   = aim?.beam_deg ?? null;
    // THE AZIMUTH WE TRANSMITTED AT, not the one we happen to be at now.
    //
    // This sampled rotator.status.az at RECORD time — up to a full timeout AFTER
    // the beam was aimed — so a row could say az=79 for a trace aimed at 219,
    // because the antenna had moved on (the shared neighbour, or the next
    // mission) while we waited. Observed exactly that on 2026-08-04.
    //
    // The aim context carries what the rotator REPORTED on arrival. Only fall
    // back to a live sample when there is no aim context at all — a bare
    // dispatch() — and even then it is the honest best available.
    let rotatorAz = aim?.az_actual ?? aim?.az ?? null;
    const rotMac = getRotatorAddress();
    // Compare in MAC space (IDENTITY.md): a node_id-side compare can never
    // match a MAC-vocabulary device, which silently skipped the az stamp.
    const devMac = String(device).includes(':') ? device : getLiveMacByNodeId(device);
    if (rotatorAz == null && rotMac && devMac === rotMac && rotator.status?.az != null) {
      rotatorAz = Number(rotator.status.az);
    }
    // from_num derives only from a !hex id — never parseInt a MAC (=233).
    const devId = String(device).includes(':') ? getLiveNodeIdByMac(device) : device;
    const row = {
      ts:         Math.floor(Date.now() / 1000),
      from_num:   devId ? (parseInt(String(devId).replace('!', ''), 16) >>> 0) : 0,
      to_num:     to,
      tx_device:  devMac ?? device,   // Phase B: MAC vocabulary
      rotator_az: rotatorAz,
      status:     reason,
      // How long we actually waited, and what the TRANSMITTING radio last said
      // about its own airtime. Together these separate "never went out" from
      // "went out, nobody answered" — which 639 timeouts against 1 send_failed
      // could not. Task `timeout-diagnosis`.
      rtt_ms:     startedAt ? Date.now() - startedAt : null,
      // AIM PROVENANCE — what we pointed at, and how wide the beam was. Without
      // these a failure cannot be attributed to the aim, which is the whole
      // reason aiming could not be evaluated. Task `traceroute-rework`.
      aim_mode:   aimMode ?? null,
      aim_target: aimTarget ?? null,
      beam_deg:   beamDeg ?? null,
      // WHERE WE AIMED, beside rotator_az (where it said it arrived). Without
      // both, "aimed badly" and "aimed right, then the shared neighbour moved
      // it" are the same row — and six door aims at one door recorded arrivals
      // 111-139 degrees apart. Never derived from rotator_az.
      aim_az_req: aim?.az ?? null,
      ...(() => {
        const n = devId ? (parseInt(String(devId).replace('!', ''), 16) >>> 0) : 0;
        return radioAirtime(n);
      })(),
    };
    try {
      row.id = stmts.insertTracerouteFailure.run(row).lastInsertRowid;
    } catch (err) {
      log.warn(`failure record failed !${to.toString(16)}: ${err.message}`);
    }
    // row rides the event so ws-relay can push it to the browser (C1)
    this.emit('cancel', { to, device, reason, row });
  }

  // ── handlePacket(pkt, rxDevice) ───────────────────────────────────────────
  // Called by the central bridge packet handler for every incoming packet.
  // Ignores non-TRACEROUTE_APP packets immediately.
  handlePacket(pkt, rxDevice) {
    if (pkt?.decoded?.portnum !== 'TRACEROUTE_APP') return;
    if (!pkt?.decoded?.route_discovery || !pkt?.from)  return;

    const rd             = pkt.decoded.route_discovery;
    const relay_positions = extractRelayPositions(rd.route);

    // Attribution: marginTx/snrRx measure the DISPATCHING radio's TX/RX
    // chain — stamp it from the pending dispatch. Overheard results (no
    // pending entry) stay unattributed. Rotator dispatches also carry the
    // live azimuth so directional samples are azimuth-qualified.
    const pendingEntry = this._pending.get(pkt.from);
    const pendingDev = pendingEntry?.device ?? null;
    // Phase B: tx_device attribution is the dispatching radio's BLE MAC —
    // resolved once here, then storage, route_discovered and REST all carry
    // it. Unresolvable ids are stored as given, never guessed.
    const txDevice = pendingDev
      ? (String(pendingDev).includes(':') ? pendingDev : (getLiveMacByNodeId(pendingDev) ?? pendingDev))
      : null;
    // AIM PROVENANCE ON SUCCESSES TOO. Task `aim-provenance-requested-az`.
    //
    // node-list.setTraceroute has always MAPPED aim_mode/aim_target/beam_deg —
    // and nothing here ever populated them, so every ok row carried NULL. Aiming
    // therefore could not be evaluated at all: the only outcomes that matter, the
    // replies, recorded nothing about the aim that produced them.
    //
    // rotator_az comes from the aim context for the same reason it does in
    // _recordFailure: re-sampling rotator.status.az HERE reads the azimuth at
    // REPLY time, which can be a full timeout after the beam was pointed, and the
    // rotator is shared. az_actual is what it reported on arrival.
    const aim = pendingEntry?.aim ?? null;
    let rotatorAz = aim ? (aim.az_actual ?? aim.az ?? null) : null;
    if (rotatorAz == null && txDevice) {
      const rotMac = getRotatorAddress();
      if (rotMac && txDevice === rotMac && rotator.status?.az != null) {
        rotatorAz = Number(rotator.status.az);
      }
    }

    const result = {
      from:            pkt.from,
      route:           rd.route       ?? [],
      route_back:      rd.route_back  ?? [],
      snr_towards:     rd.snr_towards ?? [],
      snr_back:        rd.snr_back    ?? [],
      relay_positions,
      ts:              Date.now(),
      tx_device:       txDevice,
      rotator_az:      rotatorAz,
      // Same three as the failure path, so a success and a miss are directly
      // comparable. An OVERHEARD reply has no pending dispatch of ours: no start
      // time, no transmitting radio, all three stay null. Correct — we did not
      // send it, so there is nothing to diagnose.
      rtt_ms:          pendingEntry?.startedAt ? Date.now() - pendingEntry.startedAt : null,
      // Same four as the failure path. An OVERHEARD reply has no aim context of
      // ours — all four stay null, which is genuinely unknown, never 'none'.
      aim_mode:        aim?.mode   ?? null,
      aim_target:      aim?.target ?? null,
      beam_deg:        aim?.beam_deg ?? null,
      aim_az_req:      aim?.az     ?? null,
      ...(txDevice
        ? radioAirtime(parseInt(String(getLiveNodeIdByMac(txDevice) ?? '').replace('!', ''), 16) >>> 0)
        : { channel_util: null, air_util_tx: null }),
    };

    log.info(`result from !${pkt.from.toString(16)} route=${JSON.stringify(result.route)}`);

    // Persist — single call site for storage; the returned history row id
    // rides the result so WS consumers key live rows like replayed ones
    result.id = nodeList.setTraceroute(pkt.from, result, pkt.to ?? null, rxDevice ?? null);

    // Resolve any pending dispatch waiting for this node
    const entry = this._pending.get(pkt.from);
    if (entry) {
      clearTimeout(entry.timer);
      this._pending.delete(pkt.from);
      for (const cb of entry.callbacks) cb.resolve(result);
    }

    // Per-radio attribution, added AFTER persistence so stored rows are
    // unchanged. handlePacket() is called once per RECEIVING radio
    // (bridge-events.js:98), so subscribers that care which antenna heard this
    // reply — and how well — can now tell. Existing subscribers ignore the extra
    // fields, so behaviour is unchanged for them.
    //
    // This is the only place the per-radio view exists: signal_history has no
    // device column and its UNIQUE(num, packet_id) index discards the second
    // radio's copy of the same packet.
    result.rx_device = rxDevice ?? null;
    result.rx_snr    = (typeof pkt.rx_snr  === 'number') ? pkt.rx_snr  : null;
    result.rx_rssi   = (typeof pkt.rx_rssi === 'number') ? pkt.rx_rssi : null;

    // Notify all subscribers (ws-relay → route_discovered, passive-tracer → _busy release)
    this.emit('result', result);
  }
}

export const traceroute = new TracerouteManager();
