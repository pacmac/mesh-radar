// active-tracker.js — ACTV mode (dashMode=1) self-contained tracking module
//
// State machine:
//   IDLE  → first qualifying packet arrives → select it, move rotator, start dwell timer → DWELLING
//   DWELLING → packets accumulate in candidate pool (best SNR per node)
//            → dwell timer fires → select best candidate → move if changed → clear pool → IDLE
//
// Only this module calls rotator.move() in ACTV mode.
// Emits rotator 'point_target' { point_target: nodeNum, az } for ws-relay → browser.

import { rotator }            from './rotator.js';
import { dashMode }           from './dash-mode.js';
import { stmts, getConfig }   from './db.js';
import { getRotatorDeviceId, getPrimaryDeviceId } from './device-config.js';
import { bearingTo }          from './rotator-logic.js';

const DEFAULT_DWELL_MS = 5000;

class ActiveTracker {
  constructor() {
    this._candidates  = new Map(); // nodeNum → { az, snr, rssi, ts }
    this._target      = null;      // { nodeNum, az } — currently commanded target
    this._dwellTimer  = null;
  }

  get target() { return this._target; }

  // Called from index.js for every bridge 'packet' event
  handlePacket(event) {
    if (dashMode.value !== 1) return;
    if (!rotator.connected)  return;

    const rotatorId  = getRotatorDeviceId();
    const primaryId  = getPrimaryDeviceId();

    // Only packets heard by the designated rotator radio
    if (rotatorId && event.device !== rotatorId) return;

    const packet = event.data?.packet;
    if (!packet?.from) return;

    // Skip rotator radio's own transmissions
    if (rotatorId && packet.from === parseInt(rotatorId.slice(1), 16)) return;

    // Skip home/primary node — bearing from home to itself is meaningless
    if (primaryId && packet.from === parseInt(primaryId.slice(1), 16)) return;

    const portnum = packet.decoded?.portnum;
    let lat = null, lon = null;

    if (portnum === 'POSITION_APP') {
      const pos = packet.decoded?.position;
      if (pos?.latitude_i != null) {
        lat = pos.latitude_i / 1e7;
        lon = pos.longitude_i / 1e7;
      }
    } else if (portnum === 'NODEINFO_APP' || portnum === 'TELEMETRY_APP' || portnum === 'TEXT_MESSAGE_APP') {
      const row = stmts.getNodePos?.get(packet.from, packet.from);
      if (row) { lat = row.lat; lon = row.lon; }
    }

    if (lat == null || lon == null) return;

    const az = bearingTo(lat, lon);
    if (az == null) return;

    const snr  = packet.rx_snr  ?? null;
    const rssi = packet.rx_rssi ?? null;

    // Add or update candidate — keep entry with best SNR for this node
    const existing = this._candidates.get(packet.from);
    if (!existing || snr == null || existing.snr == null || snr > existing.snr) {
      this._candidates.set(packet.from, { az, snr, rssi, ts: Date.now() });
    }

    // If no dwell is running, select immediately and start one
    if (!this._dwellTimer) {
      this._selectAndMove();
      this._startDwell();
    }
  }

  stop() {
    if (this._dwellTimer) { clearTimeout(this._dwellTimer); this._dwellTimer = null; }
    this._candidates.clear();
    this._target = null;
  }

  _startDwell() {
    const ms = getConfig('actv_dwell_ms', DEFAULT_DWELL_MS);
    this._dwellTimer = setTimeout(() => {
      this._dwellTimer = null;
      this._selectAndMove(); // pick best from accumulated candidates
      this._candidates.clear();
      // Timer stays null — restarts on next incoming packet
    }, ms);
  }

  _selectAndMove() {
    if (this._candidates.size === 0) return;

    // Best candidate = highest SNR; tie-break on most recently heard
    let best = null;
    for (const [nodeNum, c] of this._candidates) {
      if (!best
        || (c.snr != null && (best.snr == null || c.snr > best.snr))
        || (c.snr == null && best.snr == null && c.ts > best.ts)) {
        best = { nodeNum, ...c };
      }
    }
    if (!best) return;

    const sameNode = this._target?.nodeNum === best.nodeNum;
    const azDelta  = sameNode ? Math.abs((this._target.az - best.az + 360) % 360) : 360;
    if (sameNode && azDelta < 1) return; // no meaningful change

    this._target = { nodeNum: best.nodeNum, az: best.az };
    console.log(`[active] → ${best.nodeNum} az=${best.az.toFixed(1)}° snr=${best.snr ?? '—'}`);
    rotator.move(best.az);
    rotator.emit('point_target', { point_target: best.nodeNum, az: best.az });
  }
}

export const activeTracker = new ActiveTracker();
