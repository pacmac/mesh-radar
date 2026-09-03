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
import { pasvConfig } from './config-api.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
// dash-mode is NO LONGER IMPORTED HERE, and that is the point rather than tidying.
//
// `modeAim(modeKey)` used to supply the aim policy when a caller did not, and
// `transmitterForMode()` used to supply the radio. Both are now the CALLER's
// arguments: run(radio, node, timeout). Peter, 2026-08-06: the mode SSOT "does
// NOT own the pointer — modes use it, they must not control or gate it." This
// closes the standing `mode-must-not-control-aim` item at the source: there is
// no path left by which a mode can decide where the beam goes.
// THE TWO MODULES THIS ONE CALLS INSTEAD OF RE-IMPLEMENTING. Peter, 2026-08-17:
// "traceroute should call and not duplicate what the other functions provide."
import { resolveRadio } from './resolve.js';
// bearingToNode comes from aim.js rather than being recomputed here — it is the
// same function the aiming uses, so a status feed and a beam cannot disagree
// about where a node is.
import { aimForNode, bearingToNode, parseVia, lastKnownRoute } from './aim.js';
import { resolveNodeLabel } from './node-label.js';
import { haversine } from './utils.js';
// provenDoors, getDeviceCfg, doorAim, discoveryConfig, DISCOVERY_LIMITS and
// transmitterForMode are no longer imported here — every one of them was a
// dependency of the aiming or the radio-resolution this file used to do itself.
// They are imports of src/aim.js and src/resolve.js now.

// toMac(), beamwidthFor() and bearingToNode() MOVED 2026-08-17 — the first two
// into src/resolve.js (which returns `mac` and `beam_deg` on the resolved
// bundle), the third into src/aim.js. Task `traceroute-calls-resolve-and-aim`.
//
// THE SCAR THEY CARRIED, kept here because it is about IDENTITY and identity
// bugs recur. Task `aim-provenance-requested-az`:
//
//   `transmitterForMode()` returns a NODE_ID (it ends in `macToNodeId(mac)`).
//   `getRotatorAddress()` returns a MAC. `getDeviceCfg()` keys on uppercase MAC.
//   Handing a node_id to either the config lookup or the rotator identity
//   compare silently fails — and both were being handed one:
//
//     getDeviceCfg('!39f7b6')             -> {...DEFAULT}, beam_deg 360
//     '!39F7B6' !== 'F4:12:FA:39:F7:B6'   -> "radio is not on the rotator"
//
//   ...said about the rotator's own radio, so every `radio: 'auto'` dispatch
//   went out unaimed, in every mode. The recorded beam_deg of 360 on a device
//   configured 35 was the fingerprint.
//
// resolve.js now hands back BOTH forms (`mac` and `node_id`) on one object, so
// there is nothing left to convert at a call site and nothing left to get wrong.

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

/** Km from home to a node, for the status feed. Reads the same `nodes` table
 *  bearingToNode does, so the bearing and the distance describe one position. */
function distanceKmToNode(num) {
  const n = stmts.getNodeByNum.get(num) ?? null;
  if (!n?.lat || !n?.lon) return null;
  const hLat = getConfig('home.lat'), hLon = getConfig('home.lon');
  if (hLat == null || hLon == null) return null;
  return +haversine(hLat, hLon, n.lat, n.lon).toFixed(1);
}

// THERE IS NO ENABLED SWITCH, AND THERE IS NO STATE TO BE IN.
//
// Peter, 2026-08-18: "traceroute.enabled is not a config setting, that's the
// problem with the old design. traceroute is only ever called, it is not a
// permanent state."
//
// The config key `traceroute.enabled` is deleted with this comment. It gated
// every non-manual dispatch on one boolean, and it was a SECOND OWNER of
// behaviour: with it off, DISC ran and attempted nothing, and the only clue was
// a line in the mission runner's idle reason — the same shape of hole that hid
// passive tracing for 9.5 hours.
//
// The switch made sense only while something dispatched on its own. Nothing
// does: every automatic caller was removed 2026-08-17 and the sole entry point
// is an explicit POST. A traceroute happens because somebody asked for one, so
// "is traceroute on?" is not a question with a meaning any more.
//
// Peter, 2026-08-04, saying the same thing about the browser's version of it:
// "the traceroute button that exists should not be there. traceroute is a node
// function and NOT a global switch."

class TracerouteManager extends EventEmitter {
  constructor() {
    super();
    // _pending: to_num → { callbacks: [{resolve, reject}], timer }
    // Multiple callers waiting on the same node share one pending entry.
    this._pending   = new Map();
    // _cooldowns: cooldownKey → timestamp of last dispatch
    this._cooldowns = new Map();
    // _runs: id → the context every status emission is built from. One entry per
    // run(), removed when the run reaches a terminal phase.
    this._runs      = new Map();
    this._nextRunId = 1;
  }

  // ── THE STATUS FEED ────────────────────────────────────────────────────────
  //
  // Peter, 2026-08-18: "we know everything about what its doing, what radio it
  // is using etc etc. whether or not all of it will be consumed is irrelevant"
  // and "we have a lot of known data no point in keeping it a secret!"
  //
  // So this emits EVERYTHING KNOWN at each transition, not what a consumer
  // currently reads. A field withheld because nothing uses it yet is the reason
  // a defect later takes a database query to diagnose.
  //
  // Spec: docs/modules/traceroute-status-feed.md. Relayed to the browser by
  // ws-relay as `traceroute_status`; this module does not know a browser exists.
  _emitStatus(runId, phase, extra = {}) {
    const ctx = this._runs.get(runId);
    if (!ctx) return;
    // Kept current so inFlight()'s replay reports where a run actually IS,
    // not where it started.
    ctx.phase = phase;
    this.emit('status', {
      id: runId,
      phase,
      ts: Math.floor(Date.now() / 1000),
      target: ctx.target,
      radio:  ctx.radio,
      aim:    ctx.aim,
      known_route: ctx.known_route,
      timing: ctx.timing,
      // The live `rotator: {az, busy, held}` snapshot that used to ride on
      // every phase is GONE (2026-09-03, task rotator-command-via-meshgw-aim)
      // — node-dash no longer holds a live rotator status cache to sample from
      // (mesh-gw's aim plugin has no push feed, and polling for one was
      // explicitly rejected — "stop diagnosing the rotator... busy or done is
      // the whole contract"). `ctx.aim` already carries what THIS run's own
      // aim attempt reported on arrival; that is the provenance that matters.
      ...extra,
    });
    // Terminal phases end the run. Keeping the context would leak one object per
    // traceroute forever, and a replayed "in flight" that finished hours ago is
    // worse than no replay at all.
    if (['answered', 'timeout', 'send_failed', 'aim_failed'].includes(phase)) {
      this._runs.delete(runId);
    }
  }

  /** Status of every run currently in flight — for replay to a client that
   *  connects mid-trace. Without it a browser opening during a 60 s trace sees
   *  nothing until the next transition, which may be the end of it. */
  inFlight() {
    return [...this._runs.entries()].map(([id, ctx]) => ({
      id, phase: ctx.phase, ts: Math.floor(Date.now() / 1000),
      target: ctx.target, radio: ctx.radio, aim: ctx.aim,
      known_route: ctx.known_route, timing: ctx.timing,
    }));
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
  async run(radio, node, timeoutMs, opts = {}) {
    const to = Number(node);
    if (!to) throw new Error('node required');

    // TIMEOUT IS OPTIONAL, AND ITS DEFAULT IS CONFIG. Peter, 2026-08-18: "when I
    // said 3 args min, I did not mean those 3 should always be provided, I mean
    // that it need at least 3. if timeout is not set, then it should have a
    // default. that should be a config and not hard coded."
    //
    // An earlier reading of "min 3 args" made this mandatory and threw without
    // it. "At least three" describes what the function needs to KNOW, not what a
    // caller must type. `node` stays required because no default could be right.
    //
    // The key is read here AND in dispatch(), so a caller that supplies nothing
    // and a caller that reaches dispatch() directly get the same answer.
    const timeout = Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : Number(getConfig('traceroute.timeout_sec', 60)) * 1000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('traceroute.timeout_sec is not a positive number');

    // 1. RESOLVE THE RADIO. Peter: "it then resolves the radio."
    //
    // resolve.js is the SSOT — this function does not decide which radio, it
    // asks. What used to be here was traceroute's own resolver, with an
    // auto|yagi|omni vocabulary of its own and an 'omni' branch that returned
    // the mode's transmitter from BOTH arms of a ternary, so asking for the omni
    // could hand you the YAGI.
    const resolved = resolveRadio(radio, { rxDevice: opts.rxDevice });
    if (!resolved) throw new Error(`no radio resolves for '${radio ?? 'auto'}'`);
    const device = resolved.node_id;

    // THE RUN CONTEXT. Built once, here, because this is the only place that
    // knows all of it at the same time — the resolved radio, the target, the
    // budget. Every status emission is assembled from it, so the phases of one
    // run cannot disagree with each other about what they are describing.
    const runId = this._nextRunId++;
    const startedTs = Math.floor(Date.now() / 1000);
    this._runs.set(runId, {
      phase: 'resolved',
      target: {
        num: to,
        label: resolveNodeLabel(to),
        // What the TARGET's own bearing is, which is not necessarily where the
        // beam went — a relay or a `via` sends it somewhere else. Both are
        // served so a consumer can draw the node AND the beam without inferring
        // either.
        bearing_deg: bearingToNode(to),
        km: distanceKmToNode(to),
      },
      radio: {
        label: resolved.label, node_id: resolved.node_id, mac: resolved.mac,
        beam_deg: resolved.beam_deg, directional: resolved.directional,
        steerable: resolved.steerable, rotator_id: resolved.rotatorId,
      },
      aim: null,
      // THE PATH WE ALREADY BELIEVE, served so a consumer never has to ask.
      // Peter, 2026-08-18: "radar can then plot it without having to do it's own
      // enquiries." It is the SAME lookup decideAim uses to choose node-vs-relay,
      // so what the beam is aimed at and what a consumer draws cannot disagree.
      //
      // Read here rather than inside the aim branch, because it is true of the
      // run whether or not we aim — an omni has a known route too, and a `via`
      // overrides where we point without changing what we know.
      known_route: (() => {
        const k = lastKnownRoute(to);
        if (!k) return null;
        // POSITIONS FOR THE RELAYS, so a consumer can place every hop without a
        // lookup of its own. Measured 2026-08-18: only 80 of 109 relays seen in
        // stored routes have a position in `nodes`, so a consumer working from
        // the node list alone cannot plot 27% of hops. `extractRelayPositions`
        // reads nodeinfo — the same source the stored rows used — and is the
        // reason the old radar overlay carried relay_positions at all.
        return { ...k, relay_positions: extractRelayPositions(k.route) };
      })(),
      timing: { started_ts: startedTs, timeout_ms: timeout,
                deadline_ts: startedTs + Math.round(timeout / 1000) },
    });
    this._emitStatus(runId, 'resolved');

    // 2. OMNI SKIPS EVERYTHING TO DO WITH POINTING. Peter: "of course some of
    //    this is skipped if the radio is an omni directional", the test being
    //    "beam width 360 degrees".
    //
    // 3+4. DIRECTIONAL: look up what we last knew about this node, aim at the
    //      node or at its relay, and WAIT FOR CONFIRMATION.
    //
    // A caller that has already pointed the beam passes opts.aimCtx and we do
    // not point again — two commands to a SHARED rotator is not free even when
    // the second is a no-op, because it widens the window for the neighbouring
    // app to take the beam between our aim and our transmit. beam_deg is always
    // OURS even on a supplied context: it describes the TRANSMITTING antenna,
    // and a context built around the rotator would otherwise stamp 35 on rows
    // the OMNI sent.
    let aim = { mode: 'none', target: null, az: null, beam_deg: resolved.beam_deg, settled: false };
    if (opts.aimCtx) {
      aim = { ...opts.aimCtx, beam_deg: resolved.beam_deg };
    } else if (resolved.directional) {
      // HOLD FOR THE WHOLE TIMEOUT. Peter, 2026-08-18: "aim accepts min 2 args
      // bearing and hold time (ms ???) which is the same as the timeout passed
      // to traceroute." rotator.js clamps to its own shared-rotator ceiling, so
      // this cannot become a lockout however large a timeout is passed.
      // `via`, when the caller supplied one, overrides the node/relay choice —
      // it is an AIM target, not a route instruction. Peter, 2026-08-18: "if via
      // is set, the traceroute will go via that node, again this only applies to
      // directional antennas." That last clause is why it is read HERE, inside
      // the directional branch, and not before it.
      // `aiming` is emitted BEFORE the rotator is commanded, so a consumer sees
      // the beam start moving rather than learning about it once it arrived.
      // NORMALISE ONCE, HERE. opts.via arrives already parsed when the API
      // validated it, but a direct caller may pass the raw { via_node } /
      // { via_bearing } fields. Reading `.kind` off the raw form yields
      // undefined, which reported source 'derived' for what was actually an
      // operator override — the feed lying about who chose the bearing. Caught
      // by tests/test_traceroute_flow.mjs on the day this was written.
      const rawVia  = opts.via ?? null;
      const viaSpec = (rawVia && (rawVia.kind === 'node' || rawVia.kind === 'bearing'))
        ? rawVia
        : parseVia(rawVia ?? {});
      this._runs.get(runId).aim = {
        mode: null,
        // WHO chose the bearing, as distinct from what it aimed at. Collapsing
        // this into `mode` would lose the ability to tell an operator override
        // from the rule firing, which is the question asked when a run looks
        // wrong. It also answers Peter's "if it is via a bearing or node"
        // directly, without inspecting target_num.
        source: viaSpec?.kind === 'bearing' ? 'via_bearing'
              : viaSpec?.kind === 'node'    ? 'via_node'
              : 'derived',
        target_num: null, target_label: null,
        az_requested: null, az_arrived: null, settled: false, note: null,
      };
      this._emitStatus(runId, 'aiming');

      aim = await aimForNode(to, resolved, timeout, { via: viaSpec });

      const ctx = this._runs.get(runId);
      if (ctx) {
        ctx.aim = {
          ...ctx.aim,
          mode: aim.mode,
          target_num: aim.target ?? null,
          target_label: aim.target != null ? resolveNodeLabel(aim.target) : null,
          az_requested: aim.az ?? null,
          az_arrived: aim.az_actual ?? null,
          settled: !!aim.settled,
          note: aim.note ?? null,
        };
      }

      // 4b. CONFIRMATION IS A PRECONDITION, NOT A NICETY. Peter: "once the
      //     rotator has confirmed it is aimed it starts the traceroute."
      //
      // This REVERSES the older rule ("a rotator that will not move must not
      // stop a trace, it must be recorded as unaimed"). The reason for the
      // reversal is the measurement that killed the old behaviour: 303 YAGI
      // attempts at aim_mode='none' covered 246 DISTINCT azimuths spanning
      // 0.85-359.98 degrees, because the tracker and the scanner move the beam
      // for their own reasons. Transmitting a 35 degree beam at an azimuth
      // nobody chose is worse than not transmitting.
      //
      // The attempt is still RECORDED, so a rotator that is never free is
      // visible rather than silent.
      if (!aim.settled) {
        this._recordFailure(to, device, 'aim_failed', Date.now(), aim, opts);
        // TERMINAL, AND THE POINT OF THE FEED. Nothing was transmitted, and the
        // consumer is told why rather than seeing a run simply stop.
        this._emitStatus(runId, 'aim_failed', { error: { reason: aim.note ?? 'aim not confirmed' } });
        throw new Error(`aim not confirmed (${aim.note ?? aim.mode}) — not dispatching`);
      }
      this._emitStatus(runId, 'aimed');
    }

    // 5. DISPATCH, await the reply or the timeout, and save.
    return this.dispatch({
      to, device,
      timeoutMs:   timeout,
      cooldownMs:  opts.cooldownMs,
      cooldownKey: opts.cooldownKey,
      manual:      opts.manual ?? false,
      aimCtx:      aim,
      runId,
      // Which probe-plan step produced this attempt, carried onto the row.
      planClass:   opts.planClass ?? null,
      stepIndex:   opts.stepIndex ?? null,
    });
  }

  // _resolveRadio() REMOVED 2026-08-17 — src/resolve.js is the SSOT. It carried
  // a real defect: the 'omni' branch returned the mode's transmitter from BOTH
  // arms of its ternary, so `radio: 'omni'` could return the YAGI. Its comment
  // said it "cannot infer the other one here without device config" while
  // device-config was imported at the top of this file; resolve.js's
  // 'non-rotator' spec is that lookup done properly.

  // _decideAim() and _txIsRotator() MOVED to src/aim.js 2026-08-17 — decideAim()
  // there, with all four rules and their evidence intact. _txIsRotator became a
  // field read on the resolved bundle (`radio.steerable`), which also retires
  // the MAC-space comparison that once reported "not on the rotator" about the
  // rotator itself.

  // _resolveAim() MOVED to src/aim.js as resolveAim() — 2026-08-17. Everything
  // it did belongs to aiming, not to dispatching: the target policy, the
  // bearings, the discovery.* config reads, the rotator.point() call, the
  // half-beam retry loop, the aiming/aimed events, and the hold ceiling (which
  // went further still, into rotator.js, so it binds every caller).
  //
  // DELETED-BUT-NOT-LOST, in aim.js and worth reading before any rewrite:
  //   point() not move(), because move() fires and forgets and the first version
  //   could transmit mid-slew; the one re-issue on a miss (2/7 inside the beam
  //   first try, 6/7 after); the half-beam tolerance taken from device config
  //   rather than a literal; and recording the ARRIVED azimuth at the moment of
  //   arrival rather than sampling it later.

  // ── dispatch({ to, device, timeoutMs?, cooldownMs?, cooldownKey?, manual? }) ─
  // Returns a Promise that resolves with the result or rejects on timeout/error.
  // cooldownKey + cooldownMs: skip dispatch if key was dispatched within cooldownMs.
  // manual: a user-initiated request. Never gated by the master switch.
  dispatch({ to, device, timeoutMs, cooldownMs, cooldownKey, manual = false, aimCtx = null,
             planClass = null, stepIndex = null, runId = null } = {}) {
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
                      aim: aimCtx ?? null,
                      // The run this dispatch belongs to, so the terminal phases
                      // report against the same context the early ones did. Null
                      // for a bare dispatch() that did not come through run().
                      runId,
                      plan: { plan_class: planClass ?? null, step_index: stepIndex ?? null } };

      entry.timer = setTimeout(() => {
        if (this._pending.get(to) === entry) {
          this._pending.delete(to);
          const err = new Error(`timeout !${to.toString(16)}`);
          log.warn(err.message);
          for (const cb of entry.callbacks) cb.reject(err);
          this._recordFailure(to, device, 'timeout', entry.startedAt, entry.aim, entry.plan);
          this._emitStatus(entry.runId, 'timeout', { error: { reason: `no reply within ${effectiveMs} ms` } });
        }
      }, effectiveMs);

      this._pending.set(to, entry);
      this.emit('start', { to, device });
      this._emitStatus(runId, 'dispatched');
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
          this._recordFailure(to, device, 'send_failed', entry.startedAt, entry.aim, entry.plan);
          this._emitStatus(entry.runId, 'send_failed', { error: { reason: err.message } });
        }
      });
    });
  }

  // ── _recordFailure(to, device, reason) ─────────────────────────────────────
  // Failed attempts get a traceroute_history row (status='timeout'|'send_failed',
  // payload columns NULL) — without them every stat is survivorship-biased.
  // One pending entry = one row, regardless of joined callers.
  _recordFailure(to, device, reason, startedAt = null, aim = null, opts = null) {
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
    // The aim context carries what the rotator REPORTED on arrival. No live
    // fallback sample exists any more (2026-09-03, task
    // rotator-command-via-meshgw-aim — node-dash holds no live rotator status
    // cache) — a bare dispatch() with no aim context now honestly records
    // null rather than a live-at-record-time guess.
    const rotatorAz = aim?.az_actual ?? aim?.az ?? null;
    // Compare in MAC space (IDENTITY.md): a node_id-side compare can never
    // match a MAC-vocabulary device, which silently skipped the az stamp.
    const devMac = String(device).includes(':') ? device : getLiveMacByNodeId(device);
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
      // Which step of which plan fired. An escalating sequence is unattributable
      // without it — the same hole that made aiming unevaluable for months.
      plan_class: opts?.plan_class ?? null,
      step_index: opts?.step_index ?? null,
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
    // _recordFailure: re-sampling live status HERE would read the azimuth at
    // REPLY time, which can be a full timeout after the beam was pointed, and
    // the rotator is shared. az_actual is what it reported on arrival — and
    // it is the only source now (no live status cache, 2026-09-03).
    const aim = pendingEntry?.aim ?? null;
    const rotatorAz = aim ? (aim.az_actual ?? aim.az ?? null) : null;

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
      plan_class:      pendingEntry?.plan?.plan_class ?? null,
      step_index:      pendingEntry?.plan?.step_index ?? null,
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

    // Notify all subscribers.
    this.emit('result', result);

    // ANSWERED — the terminal success phase of the status feed. Emitted only for
    // a reply to a dispatch of OURS: an overheard traceroute has no pendingEntry
    // and therefore no run, and claiming it as one of our runs would be false.
    this._emitStatus(pendingEntry?.runId, 'answered', {
      result: {
        route:       result.route,
        route_back:  result.route_back,
        snr_towards: result.snr_towards,
        snr_back:    result.snr_back,
        hops:        Array.isArray(result.route) ? result.route.length : null,
        rtt_ms:      result.rtt_ms,
        rx_device:   result.rx_device ?? null,
        rx_snr:      result.rx_snr ?? null,
        rx_rssi:     result.rx_rssi ?? null,
      },
    });
  }
}

export const traceroute = new TracerouteManager();
