// active-tracker.js — ACTV mode (dashMode=1) self-contained tracking module
//
// State machine:
//   IDLE  → first qualifying packet arrives → select it, move rotator, start dwell → DWELLING
//   DWELLING → packets accumulate in candidate pool (best SNR per node)
//            → dwell timer fires → select best candidate → move if changed → clear pool → IDLE
//
// Only this module calls rotator.move() in ACTV mode.
// Emits rotator 'point_target' { point_target: nodeNum, az } → ws-relay → browser.

import { rotator }          from './rotator.js';
import { dashMode }         from './dash-mode.js';
import { stmts, getConfig } from './db.js';
import { getRotatorDeviceId, getPrimaryDeviceId } from './device-config.js';
import { bearingTo }        from './rotator-logic.js';
import { log }              from './log.js';

const TAG = 'active';
const DEFAULT_DWELL_MS = 5000;

class ActiveTracker {
  constructor() {
    this._candidates = new Map(); // nodeNum → { az, snr, rssi, ts }
    this._target     = null;      // { nodeNum, az } currently commanded
    this._dwellTimer = null;
  }

  get target() { return this._target; }

  // Called from index.js for every bridge 'packet' event
  handlePacket(event) {
    if (dashMode.value !== 1) {
      log.debug(TAG, `skip — dashMode=${dashMode.value} (not ACTV)`);
      return;
    }
    if (!rotator.connected) {
      log.warn(TAG, 'skip — rotator not connected');
      return;
    }

    const rotatorId = getRotatorDeviceId();
    const primaryId = getPrimaryDeviceId();

    if (rotatorId && event.device !== rotatorId) {
      log.debug(TAG, `skip — device=${event.device} (want ${rotatorId})`);
      return;
    }

    const packet = event.data?.packet;
    if (!packet?.from) {
      log.debug(TAG, 'skip — no packet.from');
      return;
    }

    // Exclude rotator radio's own transmissions
    if (rotatorId && packet.from === parseInt(rotatorId.slice(1), 16)) {
      log.debug(TAG, `skip — self-tx from=${packet.from}`);
      return;
    }

    // Exclude home/primary node — bearing from home to itself is 0° (meaningless)
    if (primaryId && packet.from === parseInt(primaryId.slice(1), 16)) {
      log.debug(TAG, `skip — home node from=${packet.from}`);
      return;
    }

    const portnum = packet.decoded?.portnum;
    let lat = null, lon = null;

    if (portnum === 'POSITION_APP') {
      const pos = packet.decoded?.position;
      if (pos?.latitude_i != null) {
        lat = pos.latitude_i / 1e7;
        lon = pos.longitude_i / 1e7;
        log.debug(TAG, `POSITION_APP from=!${packet.from.toString(16)} lat=${lat.toFixed(5)} lon=${lon.toFixed(5)}`);
      } else {
        log.debug(TAG, `skip — POSITION_APP from=!${packet.from.toString(16)} has no coords`);
        return;
      }
    } else if (portnum === 'NODEINFO_APP' || portnum === 'TELEMETRY_APP' || portnum === 'TEXT_MESSAGE_APP') {
      const row = stmts.getNodePos?.get(packet.from, packet.from);
      if (row) {
        lat = row.lat; lon = row.lon;
        log.debug(TAG, `${portnum} from=!${packet.from.toString(16)} pos from db lat=${lat.toFixed(5)} lon=${lon.toFixed(5)}`);
      } else {
        log.debug(TAG, `skip — ${portnum} from=!${packet.from.toString(16)} no position in db`);
        return;
      }
    } else {
      log.debug(TAG, `skip — portnum=${portnum} not tracked`);
      return;
    }

    const az = bearingTo(lat, lon);
    if (az == null) {
      log.warn(TAG, `skip — bearingTo returned null (HOME_LAT/LON set? lat=${lat} lon=${lon})`);
      return;
    }

    const snr  = packet.rx_snr  ?? null;
    const rssi = packet.rx_rssi ?? null;

    // Add or update candidate — keep entry with best SNR for this node
    const existing = this._candidates.get(packet.from);
    const isBetter = !existing
      || snr == null ? false
      : existing.snr == null || snr > existing.snr;

    if (!existing || isBetter) {
      this._candidates.set(packet.from, { az, snr, rssi, ts: Date.now() });
      log.debug(TAG, `candidate !${packet.from.toString(16)} az=${az.toFixed(1)}° snr=${snr ?? '—'} rssi=${rssi ?? '—'} pool=${this._candidates.size}`);
    } else {
      log.debug(TAG, `candidate !${packet.from.toString(16)} already in pool with better snr=${existing.snr} (heard snr=${snr})`);
    }

    // If no dwell running: select immediately and start dwell window
    if (!this._dwellTimer) {
      log.info(TAG, `dwell start — pool=${this._candidates.size} node=!${packet.from.toString(16)} az=${az.toFixed(1)}°`);
      this._selectAndMove('immediate');
      this._startDwell();
    }
  }

  stop() {
    log.info(TAG, 'stop — clearing state');
    if (this._dwellTimer) { clearTimeout(this._dwellTimer); this._dwellTimer = null; }
    this._candidates.clear();
    this._target = null;
  }

  _startDwell() {
    const ms = getConfig('actv_dwell_ms', null) ?? DEFAULT_DWELL_MS;
    log.debug(TAG, `dwell timer set — ${ms}ms`);
    this._dwellTimer = setTimeout(() => {
      this._dwellTimer = null;
      log.info(TAG, `dwell end — pool=${this._candidates.size} node${this._candidates.size !== 1 ? 's' : ''} heard`);
      this._selectAndMove('dwell-end');
      this._candidates.clear();
      // Timer stays null — restarts on next incoming packet
    }, ms);
  }

  _selectAndMove(reason) {
    if (this._candidates.size === 0) {
      log.info(TAG, `${reason} — pool empty, holding position`);
      return;
    }

    // Best = highest SNR; tie-break on most recently heard
    let best = null;
    for (const [nodeNum, c] of this._candidates) {
      if (!best
        || (c.snr != null && (best.snr == null || c.snr > best.snr))
        || (c.snr == null && best.snr == null && c.ts > best.ts)) {
        best = { nodeNum, ...c };
      }
    }

    if (!best) {
      log.warn(TAG, `${reason} — candidate selection returned nothing (pool=${this._candidates.size})`);
      return;
    }

    const sameNode = this._target?.nodeNum === best.nodeNum;
    const azDelta  = sameNode ? Math.abs((this._target.az - best.az + 360) % 360) : 360;

    if (sameNode && azDelta < 1) {
      log.debug(TAG, `${reason} — same target !${best.nodeNum.toString(16)} az=${best.az.toFixed(1)}° delta=${azDelta.toFixed(1)}° — no move`);
      return;
    }

    const prev = this._target
      ? `!${this._target.nodeNum.toString(16)} az=${this._target.az.toFixed(1)}°`
      : 'none';
    this._target = { nodeNum: best.nodeNum, az: best.az };

    log.info(TAG, `${reason} — move !${best.nodeNum.toString(16)} az=${best.az.toFixed(1)}° snr=${best.snr ?? '—'} rssi=${best.rssi ?? '—'} (was ${prev}) pool=${this._candidates.size}`);
    rotator.move(best.az);
    rotator.emit('point_target', { point_target: best.nodeNum, az: best.az });
  }
}

export const activeTracker = new ActiveTracker();
