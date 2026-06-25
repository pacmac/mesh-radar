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

class TracerouteManager extends EventEmitter {
  constructor() {
    super();
    // _pending: to_num → { callbacks: [{resolve, reject}], timer }
    // Multiple callers waiting on the same node share one pending entry.
    this._pending   = new Map();
    // _cooldowns: cooldownKey → timestamp of last dispatch
    this._cooldowns = new Map();
  }

  // ── dispatch({ to, device, timeoutMs?, cooldownMs?, cooldownKey? }) ────────
  // Returns a Promise that resolves with the result or rejects on timeout/error.
  // cooldownKey + cooldownMs: skip dispatch if key was dispatched within cooldownMs.
  dispatch({ to, device, timeoutMs, cooldownMs, cooldownKey } = {}) {
    if (!to || !device) return Promise.reject(new Error('to and device are required'));

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

      const entry = { callbacks: [{ resolve, reject }], timer: null };

      entry.timer = setTimeout(() => {
        if (this._pending.get(to) === entry) {
          this._pending.delete(to);
          const err = new Error(`timeout !${to.toString(16)}`);
          log.warn(err.message);
          for (const cb of entry.callbacks) cb.reject(err);
          this.emit('cancel', { to });
        }
      }, effectiveMs);

      this._pending.set(to, entry);
      this.emit('start', { to, device });
      log.info(`dispatch to !${to.toString(16)} via ${device}`);

      bridge.post(`/${device}/traceroute`, { to }).catch(err => {
        if (this._pending.get(to) === entry) {
          clearTimeout(entry.timer);
          this._pending.delete(to);
          log.warn(`send failed !${to.toString(16)}: ${err.message}`);
          for (const cb of entry.callbacks) cb.reject(err);
          this.emit('cancel', { to });
        }
      });
    });
  }

  // ── handlePacket(pkt, rxDevice) ───────────────────────────────────────────
  // Called by the central bridge packet handler for every incoming packet.
  // Ignores non-TRACEROUTE_APP packets immediately.
  handlePacket(pkt, rxDevice) {
    if (pkt?.decoded?.portnum !== 'TRACEROUTE_APP') return;
    if (!pkt?.decoded?.route_discovery || !pkt?.from)  return;

    const rd             = pkt.decoded.route_discovery;
    const relay_positions = extractRelayPositions(rd.route);

    const result = {
      from:            pkt.from,
      route:           rd.route       ?? [],
      route_back:      rd.route_back  ?? [],
      snr_towards:     rd.snr_towards ?? [],
      snr_back:        rd.snr_back    ?? [],
      relay_positions,
      ts:              Date.now(),
    };

    log.info(`result from !${pkt.from.toString(16)} route=${JSON.stringify(result.route)}`);

    // Persist — single call site for storage
    nodeList.setTraceroute(pkt.from, result, pkt.to ?? null, rxDevice ?? null);

    // Resolve any pending dispatch waiting for this node
    const entry = this._pending.get(pkt.from);
    if (entry) {
      clearTimeout(entry.timer);
      this._pending.delete(pkt.from);
      for (const cb of entry.callbacks) cb.resolve(result);
    }

    // Notify all subscribers (ws-relay → route_discovered, passive-tracer → _busy release)
    this.emit('result', result);
  }
}

export const traceroute = new TracerouteManager();
