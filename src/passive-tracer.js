import { EventEmitter } from 'events';
import { bridge } from './bridge.js';
import { nodeList } from './node-list.js';
import { dashMode, transmitterForMode, isListenerForMode, passiveTracingAllowed,
         modeName, modesAllowingPassive } from './dash-mode.js';
import { defineHook } from './hooks.js';

import db, { stmts, getConfig } from './db.js';
import { ownDeviceNums } from './node-filter.js';
import { FF } from './feature-flags.js';
import { traceroute, tracerouteEnabled } from './traceroute.js';
import { missionRunner } from './mission-runner.js';

// A PER-MODE HOOK DECLARES ITS MODES. Task `hooks-per-mode-scope`.
//
// This module is the reason the scope exists. Its rule was a bare
// `dashMode.value !== 0` buried here in the consumer, and selecting DISC
// switched passive tracing off wholesale for 9.5 hours with no log line, no
// counter and no consequence anywhere on screen.
//
// The list comes from `modesAllowingPassive()` rather than being written out
// again here — two lists that can disagree is the same bug one level up.
const PASSIVE = defineHook({
  name: 'passive-trace',
  scope: 'per-mode',
  modes: () => modesAllowingPassive(),   // lazy: see defineHook
  purpose: 'traces a node on hearing it, in the modes that permit passive tracing',
});
let _lastModeSaid = null;

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
    // A target with zero lifetime successes gets the slow lane after this many
    // attempts. Not a cap — see needsTrace().
    dead_after:    cfg.dead_after_attempts ?? 10,
    dead_retry_ms: (cfg.dead_retry_hours   ?? 12) * 3600 * 1000,
  };
}

// _attempted: num → ts of last SUCCESSFUL trace (stale_ms window)
// _failed:    num → ts of last FAILED/timeout trace (stale_fail_ms window)
const _attempted = new Map();
const _failed    = new Map();

/** Lifetime attempts and successes for a target, FROM THE STORE.
 *
 *  Not from _attempted/_failed: those are in-memory and reset on every restart,
 *  so a redeploy silently returned every dead target to the ten-minute cadence.
 *  That is the same defect that made the airtime budget meaningless (B75), and
 *  it was compounding here unseen — node-dash was restarted eight times in one
 *  evening. */
function lifetime(from_num) {
  try {
    // last_ts TOO, not just the counts. The first version took the count from
    // the store but still read "when did we last try" from the in-memory maps —
    // which are empty after a restart, so lastAny was 0, the fallback `!ts`
    // returned true, and every slow-lane node was retried immediately on boot.
    // Half-fixing restart-reset state is worse than not fixing it, because the
    // measurement then says the backoff works.
    return db.prepare(`SELECT COUNT(*) n, SUM(status='ok') ok, MAX(ts) last_ts
                         FROM traceroute_history WHERE to_num = ?`).get(from_num)
        || { n: 0, ok: 0, last_ts: 0 };
  } catch (e) {
    // LOUD, not silent. Returning zeros here means "never backed off", so a
    // swallowed error would quietly restore the exact waste this fixes — the
    // failed-permissive pattern that already cost us B74 and B75.
    console.error(`[passive-tracer] lifetime(${from_num}) failed: ${e.message}`);
    return { n: 0, ok: 0 };
  }
}

function needsTrace(from_num) {
  const { stale_ms, stale_fail_ms, dead_after, dead_retry_ms } = getPasvConfig();
  const now = Date.now();
  const lastFail    = _failed.get(from_num)    ?? 0;
  const lastSuccess = _attempted.get(from_num) ?? 0;

  // BACK OFF, NEVER ABANDON. 26.6% of all attempts over 30 days went to targets
  // that have never once answered — 3422 of them from this tracer alone, with no
  // cap of any kind. But a hard cap is the wrong fix: of the 113 nodes that have
  // ever answered, first contact came at attempt 16 for the 90th percentile, 70
  // for the 99th, and 94 at worst. Capping at 10 would have saved 3553 attempts
  // and thrown away first contact with 16 of those 113 nodes.
  //
  // So a target with zero lifetime successes moves to the slow lane after
  // `dead_after` attempts. It still gets tried — every `dead_retry_ms` instead of
  // every ten minutes — and one success returns it to the fast cadence forever.
  const life = lifetime(from_num);
  if ((life.ok || 0) === 0 && (life.n || 0) >= dead_after) {
    // Every input from the STORE. traceroute_history.ts is in seconds.
    const lastAny = Math.max(lastFail, lastSuccess, (life.last_ts || 0) * 1000);
    return !lastAny || (now - lastAny) > dead_retry_ms;
  }

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

    // Which modes run the passive tracer is dash-mode's decision, not ours. This
    // was `dashMode.value !== 0`, which switched passive tracing off wholesale
    // whenever DISC was selected — 17.0 traces/h at 3.8% became 1 trace in 9.5 h
    // on 2026-08-02, with no log line, because this return is silent and sits
    // upstream of every counter in this function.
    // SPEAKS WHEN IT SKIPS. Latched on the mode so a quiet mode reports once,
    // not once per packet (~20/min) — the same rule the discovery loop uses.
    const modeNow = modeName(dashMode.value);
    if (!passiveTracingAllowed(dashMode.value)) {
      if (_lastModeSaid !== modeNow) {
        PASSIVE.emit({
          severity: 'notice',
          summary: `not tracing — ${modeNow.toUpperCase()} does not permit passive tracing (permitted: ${modesAllowingPassive().join(', ')})`,
          detail: { mode: modeNow, permitted: modesAllowingPassive() },
        });
        _lastModeSaid = modeNow;
      }
      return;
    }
    if (_lastModeSaid !== null && _lastModeSaid !== modeNow) {
      PASSIVE.emit({ summary: `tracing in ${modeNow.toUpperCase()}`, detail: { mode: modeNow } });
    }
    _lastModeSaid = modeNow;
    // Master switch. Checked HERE as well as inside dispatch() — not redundant:
    // the .catch below records _failed and emits an empty `traced` result, so a
    // gated dispatch arriving as a rejection would mark every skipped node as
    // FAILED and push bogus empty routes to the browser (task
    // `traceroute-manual-enable`).

    if (!tracerouteEnabled()) return;
    if (this._busy) return;
    const rxDevice = ev.__ble_addr ?? ev.addr ?? ev.device ?? null;
    if (!pkt?.from) return;
    if (!rxDevice) return;
    if (pkt.decoded?.portnum === 'TRACEROUTE_APP') return;
    // Never traceroute own bridge radios; only act on packets heard by a radio
    // that is a listener for PASV mode (default: any non-rotator radio).
    if (ownDeviceNums().has(pkt.from)) return;
    // Pinned to 'pasv' DELIBERATELY, in every mode — these are this prober's own
    // radio contract, not the active mode's. Resolving them from the live mode
    // would give passive tx:'rotator' in DISC and fire an unaimed trace down the
    // beam, wrong for the trace and destructive to the mission holding it.
    if (!isListenerForMode('pasv', rxDevice)) return;
    // Skip MQTT-relayed nodes (firmware returns NO_ROUTE immediately)
    if (pkt.via_mqtt) return;
    // DISCOVERY OWNS THE INSTRUMENT WHILE ITS PACKET IS IN THE AIR — and only
    // then. Peter, 2026-08-02: "the traceroute should be used by us, when a
    // discovery is in progress."
    //
    // This yielded on `missionRunner.busy`, which covers the entire mission
    // cycle: aim, hold, dispatch, timeout, and the ~18 minutes a target is held
    // across six attempts. The effect was a 99% cut — 17 passive traces an hour
    // became 0.1 — and passive was the half that was ANSWERING: 3.8% over 5,557
    // traces, against 0.0% for 132 aimed missions in the same window.
    //
    // `dispatching` is true only between the packet going out and its reply or
    // timeout, which is what "in progress" actually means.
    if (missionRunner.dispatching) return;
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
      // device arrived as ev.addr (MAC); dispatch takes the node_id so
      // tx_device attribution stays single-vocabulary (perf page queries
      // by !hex). URL addressing resolves back to MAC inside dispatch.
      traceroute.dispatch({ to: from_num, device: transmitterForMode('pasv', { rxDevice: device }) })
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
