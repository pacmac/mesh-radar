import { EventEmitter } from 'events';
import { bridge } from './bridge.js';
import { nodeList } from './node-list.js';
import { dashMode } from './dash-mode.js';
import { stmts, getConfig } from './db.js';
import { ownDeviceNums } from './node-filter.js';
import { getRotatorDeviceId } from './device-config.js';
import { FF } from './feature-flags.js';
import { traceroute } from './traceroute.js';

const log = {
  info: (...a) => console.log('[passive-tracer]', ...a),
  warn: (...a) => console.log('[passive-tracer] warn:', ...a),
};

function getPasvConfig() {
  const cfg = getConfig('pasv_config', {});
  return {
    stale_ms:      (cfg.stale_sec      ?? 1800) * 1000,
    stale_fail_ms: (cfg.stale_fail_sec ??  600) * 1000,
    timeout_ms:    (cfg.timeout_sec    ??   60) * 1000,
  };
}

// _attempted: num → ts of last SUCCESSFUL trace (stale_ms window)
// _failed:    num → ts of last FAILED/timeout trace (stale_fail_ms window)
const _attempted = new Map();
const _failed    = new Map();

function needsTrace(from_num) {
  const { stale_ms, stale_fail_ms } = getPasvConfig();
  const now = Date.now();
  const lastFail    = _failed.get(from_num)    ?? 0;
  const lastSuccess = _attempted.get(from_num) ?? 0;
  if (lastFail    && (now - lastFail)    <= stale_fail_ms) return false;
  if (lastSuccess && (now - lastSuccess) <= stale_ms)      return false;
  const node = nodeList._cache.get(from_num);
  const ts   = node?.last_traceroute?.ts ?? 0;
  return !ts || (now - ts) > stale_ms;
}

class PassiveTracer extends EventEmitter {
  constructor() {
    super();
    this._busy        = false;
    this._pendingFrom = null;
    this._timeout     = null;
  }

  init() {
    bridge.on('event', ev => this._onEvent(ev));
  }

  _onEvent(ev) {
    if (ev.type !== 'packet') return;
    const pkt = ev.data?.packet;

    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
    if (!FF.SSOT_TRACEROUTE) {
      // Check if this is the traceroute response we're waiting for
      if (this._busy && this._pendingFrom != null &&
          pkt?.decoded?.portnum === 'TRACEROUTE_APP' &&
          pkt?.from === this._pendingFrom) {
        const rd = pkt.decoded.route_discovery ?? {};
        const relay_positions = {};
        for (const num of rd.route ?? []) {
          const info = stmts.getNodeinfoByNum.get(num);
          if (info?.lat != null && info?.lon != null) {
            relay_positions[num] = {
              latitude_i:  Math.round(info.lat * 1e7),
              longitude_i: Math.round(info.lon * 1e7),
            };
          }
        }
        log.info(`trace complete !${pkt.from.toString(16)} route=${JSON.stringify(rd.route ?? [])}`);
        _attempted.set(pkt.from, Date.now());
        this.emit('traced', {
          from:            pkt.from,
          route:           rd.route       ?? [],
          route_back:      rd.route_back  ?? [],
          snr_towards:     rd.snr_towards ?? [],
          snr_back:        rd.snr_back    ?? [],
          relay_positions,
          ts:              Date.now(),
        });
        this._release();
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Only trigger new traces in PASV mode (0)
    if (dashMode.value !== 0) return;
    if (this._busy) return;
    const rxDevice = ev.addr ?? ev.device ?? null;
    if (!pkt?.from || !rxDevice) return;
    if (pkt.decoded?.portnum === 'TRACEROUTE_APP') return;
    // Never traceroute own bridge radios, and don't transmit via the rotator
    if (ownDeviceNums().has(pkt.from)) return;
    if (rxDevice === getRotatorDeviceId()) return;
    if (!needsTrace(pkt.from)) return;

    this._trace(pkt.from, rxDevice);
  }

  _trace(from_num, device) {
    this._busy        = true;
    this._pendingFrom = from_num;
    log.info(`tracing !${from_num.toString(16)} via ${device}`);
    this.emit('tracing', { from: from_num });

    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
    if (!FF.SSOT_TRACEROUTE) {
      bridge.post(`/${device}/traceroute`, { to: from_num }).catch(err => {
        log.warn(`send failed for !${from_num.toString(16)}: ${err.message}`);
        _failed.set(from_num, Date.now());
        this.emit('traced', { from: from_num, route: [], route_back: [], snr_towards: [], snr_back: [], relay_positions: {}, ts: Date.now() });
        this._release();
      });
      const { timeout_ms } = getPasvConfig();
      this._timeout = setTimeout(() => {
        const num = this._pendingFrom;
        log.warn(`timeout for !${num?.toString(16)}`);
        _failed.set(num, Date.now());
        this.emit('traced', { from: num, route: [], route_back: [], snr_towards: [], snr_back: [], relay_positions: {}, ts: Date.now() });
        this._release();
      }, timeout_ms);
    // ── [V2] SSOT — traceroute.js owns dispatch, timeout, decode ─────────────
    } else {
      traceroute.dispatch({ to: from_num, device })
        .then(result => {
          _attempted.set(from_num, Date.now());
          this.emit('traced', result);
        })
        .catch(err => {
          log.warn(`trace failed !${from_num.toString(16)}: ${err.message}`);
          _failed.set(from_num, Date.now());
          this.emit('traced', { from: from_num, route: [], route_back: [], snr_towards: [], snr_back: [], relay_positions: {}, ts: Date.now() });
        })
        .finally(() => {
          this._busy        = false;
          this._pendingFrom = null;
        });
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  // Used by V1 path only — V2 uses .finally() on the dispatch promise
  _release() {
    clearTimeout(this._timeout);
    this._timeout     = null;
    this._busy        = false;
    this._pendingFrom = null;
  }
}

export const passiveTracer = new PassiveTracer();
