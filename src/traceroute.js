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
import { stmts, getConfig } from './db.js';
import { getRotatorAddress } from './device-config.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { rotator } from './rotator.js';

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
// `traceroute.enabled`, declared in config-api DEFAULTS so it survives restarts
// and reaches the browser on the settings WS). Exported so a caller can skip
// before dispatching rather than treat a gated dispatch as a failed one —
// passive-tracer needs that, since its catch path records a failure.
export function tracerouteEnabled() {
  return getConfig('traceroute.enabled', true) !== false;
}

class TracerouteManager extends EventEmitter {
  constructor() {
    super();
    // _pending: to_num → { callbacks: [{resolve, reject}], timer }
    // Multiple callers waiting on the same node share one pending entry.
    this._pending   = new Map();
    // _cooldowns: cooldownKey → timestamp of last dispatch
    this._cooldowns = new Map();
  }

  // ── dispatch({ to, device, timeoutMs?, cooldownMs?, cooldownKey?, manual? }) ─
  // Returns a Promise that resolves with the result or rejects on timeout/error.
  // cooldownKey + cooldownMs: skip dispatch if key was dispatched within cooldownMs.
  // manual: a user-initiated request. Never gated by the master switch.
  dispatch({ to, device, timeoutMs, cooldownMs, cooldownKey, manual = false } = {}) {
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
    if (!manual && !tracerouteEnabled()) {
      return Promise.reject(new Error('traceroute disabled'));
    }

    // Cooldown guard — caller's responsibility to pass the right key/window
    if (cooldownMs != null && cooldownKey != null) {
      const last = this._cooldowns.get(cooldownKey) ?? 0;
      if (Date.now() - last < cooldownMs) {
        return Promise.reject(new Error(`cooldown: ${cooldownKey}`));
      }
      this._cooldowns.set(cooldownKey, Date.now());
    }

    const cfg            = getConfig('pasv_config', {});
    const effectiveMs    = timeoutMs ?? ((cfg.timeout_sec ?? 60) * 1000);

    return new Promise((resolve, reject) => {
      const existing = this._pending.get(to);

      if (existing) {
        // Another dispatch already in flight for this node — join it
        existing.callbacks.push({ resolve, reject });
        log.info(`joined pending dispatch for !${to.toString(16)}`);
        return;
      }

      const entry = { callbacks: [{ resolve, reject }], timer: null, device };

      entry.timer = setTimeout(() => {
        if (this._pending.get(to) === entry) {
          this._pending.delete(to);
          const err = new Error(`timeout !${to.toString(16)}`);
          log.warn(err.message);
          for (const cb of entry.callbacks) cb.reject(err);
          this._recordFailure(to, device, 'timeout');
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
          this._recordFailure(to, device, 'send_failed');
        }
      });
    });
  }

  // ── _recordFailure(to, device, reason) ─────────────────────────────────────
  // Failed attempts get a traceroute_history row (status='timeout'|'send_failed',
  // payload columns NULL) — without them every stat is survivorship-biased.
  // One pending entry = one row, regardless of joined callers.
  _recordFailure(to, device, reason) {
    let rotatorAz = null;
    const rotMac = getRotatorAddress();
    // Compare in MAC space (IDENTITY.md): a node_id-side compare can never
    // match a MAC-vocabulary device, which silently skipped the az stamp.
    const devMac = String(device).includes(':') ? device : getLiveMacByNodeId(device);
    if (rotMac && devMac === rotMac && rotator.status?.az != null) {
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
    let rotatorAz = null;
    if (txDevice) {
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
