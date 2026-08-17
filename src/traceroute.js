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
import { getRotatorAddress } from './device-config.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { rotator } from './rotator.js';
import { dashMode, modeName, modeAim } from './dash-mode.js';
// THE TWO MODULES THIS ONE CALLS INSTEAD OF RE-IMPLEMENTING. Peter, 2026-08-17:
// "traceroute should call and not duplicate what the other functions provide."
import { resolveRadio } from './resolve.js';
import { resolveAim } from './aim.js';
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

    // WHICH RADIO — RESOLVED, NOT DECIDED HERE. Peter, 2026-08-17: "traceroute
    // should call and not duplicate what the other functions provide."
    //
    // This was `this._resolveRadio(opts.radio, modeKey)`, traceroute's private
    // resolver with its own auto|yagi|omni vocabulary — a third naming scheme
    // for radios beside dash-mode's roles and raw MAC/node_id. Its 'omni' branch
    // returned the mode's transmitter from BOTH arms of a ternary, so asking for
    // the omni could hand you the YAGI. src/resolve.js is the SSOT now.
    const modeKey = modeName(dashMode.value);
    const radio   = resolveRadio(opts.radio, { rxDevice: opts.rxDevice });
    if (!radio) throw new Error('no radio for this mode');
    const device  = radio.node_id;

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
    // AIMING — CALLED, NOT PERFORMED HERE. src/aim.js owns the four-rule target
    // policy, the bearings, the rotator call and the retry loop; it is also the
    // only caller of rotator.point() in this path.
    const aim = opts.aimCtx
      ? { ...opts.aimCtx, beam_deg: radio.beam_deg }
      : await resolveAim(to, opts.aim ?? modeAim(modeKey) ?? 'none', radio, opts);

    return this.dispatch({
      to, device,
      timeoutMs:   opts.timeoutMs,
      cooldownMs:  opts.cooldownMs,
      cooldownKey: opts.cooldownKey,
      manual:      opts.manual ?? false,
      aimCtx:      aim,
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
             planClass = null, stepIndex = null } = {}) {
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
                      plan: { plan_class: planClass ?? null, step_index: stepIndex ?? null } };

      entry.timer = setTimeout(() => {
        if (this._pending.get(to) === entry) {
          this._pending.delete(to);
          const err = new Error(`timeout !${to.toString(16)}`);
          log.warn(err.message);
          for (const cb of entry.callbacks) cb.reject(err);
          this._recordFailure(to, device, 'timeout', entry.startedAt, entry.aim, entry.plan);
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
          this._recordFailure(to, device, 'send_failed', entry.startedAt, entry.aim, entry.plan);
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

    // Notify all subscribers (ws-relay → route_discovered, passive-tracer → _busy release)
    this.emit('result', result);
  }
}

export const traceroute = new TracerouteManager();
