import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { getRotatorDeviceId, getDeviceCfg, getAllDeviceCfgs } from './device-config.js';
import { stmts, insertRangeTestEntry } from './db.js';

const YAGI_DEVICE_ID = '!fa39f7b4';
const DWELL_MS       = 10_000;        // node must be consistently heard for 10s before pointing
const HOLD_MS        = 90_000;        // stay pointed at a target for 90s before accepting a new one
const STALE_MS       = 3 * 60 * 1000; // no YAGI packets at all for 3min → clear state

const posCache = new Map();

let _dwellTimer  = null;
let _staleTimer  = null;
let _candidate   = null; // { num, lat, lon }
let _firedNum    = null; // num the rotator is currently pointing at
let _firedAt     = null; // Date.now() when we last fired
let _lastRssi    = null;
let _lastSnr     = null;

const log = {
  info:  (...a) => console.log( '[active]',  ...a),
  debug: (...a) => console.log( '[active:d]', ...a),
  warn:  (...a) => console.warn('[active:w]', ...a),
  error: (...a) => console.error('[active:e]', ...a),
};

function ownNums() {
  return new Set(
    Object.keys(getAllDeviceCfgs())
      .filter(id => id.startsWith('!'))
      .map(id => parseInt(id.slice(1), 16))
  );
}

function getHomePos() {
  const rotatorId = getRotatorDeviceId();
  if (!rotatorId) return null;
  const cfg = getDeviceCfg(rotatorId);
  if (cfg.fixed_lat == null || cfg.fixed_lon == null) return null;
  return { lat: cfg.fixed_lat, lon: cfg.fixed_lon };
}

function bearing(from, to) {
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat  * Math.PI / 180;
  const dlon  = (to.lon - from.lon) * Math.PI / 180;
  const y = Math.sin(dlon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function lookupPos(num) {
  if (posCache.has(num)) return posCache.get(num);
  try {
    const row = stmts.getNodePos.get(num, num);
    if (row) {
      posCache.set(num, { lat: row.lat, lon: row.lon });
      return { lat: row.lat, lon: row.lon };
    }
  } catch (err) {
    log.error(`DB lookup failed for ${num}:`, err.message);
  }
  return null;
}

function resetStale() {
  if (_staleTimer) clearTimeout(_staleTimer);
  _staleTimer = setTimeout(() => {
    if (_candidate) {
      log.warn(`no YAGI packets for 3min — clearing state`);
      _candidate = _firedNum = _firedAt = _lastRssi = _lastSnr = null;
    }
  }, STALE_MS);
}

function fireDwell() {
  if (!_candidate) return;
  if (ownNums().has(_candidate.num)) {
    log.warn(`dwell fired for own device ${_candidate.num} — skipping`);
    return;
  }
  const home = getHomePos();
  if (!home) {
    log.warn('dwell fired but no rotator home pos configured');
    return;
  }
  const az = bearing(home, _candidate);
  _firedNum = _candidate.num;
  _firedAt  = Date.now();
  log.info(`dwell fired → node ${_candidate.num} az=${az.toFixed(1)}° rssi=${_lastRssi ?? '?'} snr=${_lastSnr ?? '?'}`);
  try {
    rotator.move(az);
    rotator.emit('point_target', { point_target: _candidate.num, az, _mode: dashMode.value });
    rotator.emit('signal_update', { signal_num: _firedNum, rssi: _lastRssi, snr: _lastSnr, ts: Date.now() });
  } catch (err) {
    log.error('failed to command rotator:', err.message);
  }
}

function resetDwell(num, pos, rssi = null, snr = null) {
  if (rssi != null) _lastRssi = rssi;
  if (snr  != null) _lastSnr  = snr;

  // While holding on current target: accept signal updates from it, but ignore other nodes
  const inHold = _firedAt && (Date.now() - _firedAt) < HOLD_MS;
  if (inHold && num !== _firedNum) {
    const remaining = Math.round((HOLD_MS - (Date.now() - _firedAt)) / 1000);
    log.debug(`hold active for ${remaining}s — ignoring node ${num}`);
    return;
  }

  // Emit signal update + log for current target
  if (_firedNum === num && (rssi != null || snr != null)) {
    rotator.emit('signal_update', { signal_num: num, rssi, snr, ts: Date.now() });
    try {
      insertRangeTestEntry({ ts: Math.floor(Date.now() / 1000), from_num: num, rssi: rssi ?? null, snr: snr ?? null, hops: null, seq: null, rx_device: YAGI_DEVICE_ID });
    } catch (err) { log.error('range_test insert failed:', err.message); }
  }

  const isNew = !_candidate || _candidate.num !== num;
  _candidate = { num, ...pos };
  if (_dwellTimer) clearTimeout(_dwellTimer);
  _dwellTimer = setTimeout(fireDwell, DWELL_MS);
  if (isNew) log.debug(`dwell started for node ${num} (${DWELL_MS}ms)`);
  else       log.debug(`dwell reset for node ${num}`);
  resetStale();
}

export const activeTracker = {
  handlePacket(ev) {
    if (dashMode.value !== 1) return;
    if (ev.device !== YAGI_DEVICE_ID) return;

    if (ev.type === 'node_update') {
      const d   = ev.data;
      const pos = d?.position;
      if (d?.num == null || pos?.latitude_i == null || pos?.longitude_i == null) return;
      if (ownNums().has(d.num)) {
        log.debug(`node_update num=${d.num} is own device — skipping`);
        return;
      }
      const lat = pos.latitude_i / 1e7;
      const lon = pos.longitude_i / 1e7;
      posCache.set(d.num, { lat, lon });
      log.debug(`node_update num=${d.num} lat=${lat.toFixed(5)} lon=${lon.toFixed(5)}`);
      resetDwell(d.num, { lat, lon });
      return;
    }

    if (ev.type === 'packet') {
      const pkt = ev.data?.packet;
      if (!pkt?.from) return;
      if (ownNums().has(pkt.from)) {
        log.debug(`packet from own device ${pkt.from} — skipping`);
        return;
      }
      const pos = lookupPos(pkt.from);
      if (!pos) {
        log.warn(`no pos for node ${pkt.from} portnum=${pkt.decoded?.portnum ?? 'none'}`);
        return;
      }
      log.debug(`packet from=${pkt.from} rssi=${pkt.rx_rssi ?? 'n/a'} snr=${pkt.rx_snr ?? 'n/a'}`);
      resetDwell(pkt.from, pos, pkt.rx_rssi ?? null, pkt.rx_snr ?? null);
    }
  },

  stop() {
    log.info('stopping');
    if (_dwellTimer) { clearTimeout(_dwellTimer); _dwellTimer = null; }
    if (_staleTimer) { clearTimeout(_staleTimer); _staleTimer = null; }
    _candidate = _firedNum = _firedAt = _lastRssi = _lastSnr = null;
    posCache.clear();
  },
};
