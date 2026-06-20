import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { getRotatorDeviceId, getDeviceCfg } from './device-config.js';
import { stmts, insertRangeTestEntry } from './db.js';
import { nodeList } from './node-list.js';

const YAGI_DEVICE_ID = '!fa39f7b4';
const DWELL_MS       = 5000;
const STALE_MS       = 3 * 60 * 1000;

const posCache = new Map();

let _dwellTimer  = null;
let _staleTimer  = null;
let _candidate   = null; // { num, lat, lon }
let _firedNum    = null; // num of the node the rotator is currently pointing at
let _lastRssi    = null;
let _lastSnr     = null;

const log = {
  info:  (...a) => console.log( '[active]',  ...a),
  debug: (...a) => console.log( '[active:d]', ...a),
  warn:  (...a) => console.warn('[active:w]', ...a),
  error: (...a) => console.error('[active:e]', ...a),
};

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
  if (posCache.has(num)) {
    log.debug(`pos cache hit for ${num}`);
    return posCache.get(num);
  }
  try {
    const row = stmts.getNodePos.get(num, num);
    if (row) {
      log.debug(`pos DB hit for ${num} lat=${row.lat} lon=${row.lon}`);
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
      log.warn(`no YAGI packets for 3min — clearing candidate ${_candidate.num}`);
      _candidate = null;
      _firedNum  = null;
      _lastRssi  = null;
      _lastSnr   = null;
    }
  }, STALE_MS);
}

function fireDwell() {
  if (!_candidate) return;
  const radarNode = nodeList.nodes.find(n => n.num === _candidate.num);
  if (!radarNode?._az) {
    log.warn(`dwell fired for node ${_candidate.num} but not visible in radar (no _az) — skipping point_target`);
    return;
  }
  const home = getHomePos();
  if (!home) {
    log.warn('dwell fired but no rotator home pos configured — rotator will not move');
    return;
  }
  const az = bearing(home, _candidate);
  _firedNum = _candidate.num;
  log.info(`dwell fired → node ${_candidate.num} lat=${_candidate.lat.toFixed(5)} lon=${_candidate.lon.toFixed(5)} az=${az.toFixed(1)}°`);
  try {
    rotator.move(az);
    rotator.emit('point_target', { point_target: _candidate.num, az, _mode: dashMode.value });
    rotator.emit('signal_update', { signal_num: _firedNum, rssi: _lastRssi, snr: _lastSnr });
    log.info(`rotator.move(${az.toFixed(1)}) + point_target emitted`);
  } catch (err) {
    log.error('failed to command rotator:', err.message);
  }
}

function resetDwell(num, pos, rssi = null, snr = null) {
  const isNew = !_candidate || _candidate.num !== num;
  _candidate = { num, ...pos };
  if (rssi != null) _lastRssi = rssi;
  if (snr  != null) _lastSnr  = snr;
  // If we're already pointed at this node, emit live signal update + log it
  if (_firedNum === num && (rssi != null || snr != null)) {
    rotator.emit('signal_update', { signal_num: num, rssi, snr });
    try {
      insertRangeTestEntry({ ts: Math.floor(Date.now() / 1000), from_num: num, rssi: rssi ?? null, snr: snr ?? null, hops: null, seq: null, rx_device: YAGI_DEVICE_ID });
    } catch (err) { log.error('range_test insert failed:', err.message); }
  }
  if (_dwellTimer) clearTimeout(_dwellTimer);
  _dwellTimer = setTimeout(fireDwell, DWELL_MS);
  if (isNew) log.debug(`dwell started for node ${num} (${DWELL_MS}ms)`);
  else        log.debug(`dwell reset for node ${num}`);
  resetStale();
}

export const activeTracker = {
  handlePacket(ev) {
    if (dashMode.value !== 1) {
      log.debug(`skip — mode=${dashMode.value} (not ACTV)`);
      return;
    }
    if (ev.device !== YAGI_DEVICE_ID) {
      log.debug(`skip — device=${ev.device} (not YAGI)`);
      return;
    }

    if (ev.type === 'node_update') {
      const d   = ev.data;
      const pos = d?.position;
      if (d?.num == null || pos?.latitude_i == null || pos?.longitude_i == null) {
        log.debug(`node_update num=${d?.num} — no position, skipping`);
        return;
      }
      if (d.num === parseInt(YAGI_DEVICE_ID.slice(1), 16)) {
        log.debug(`node_update is YAGI self — skipping`);
        return;
      }
      const lat = pos.latitude_i / 1e7;
      const lon = pos.longitude_i / 1e7;
      posCache.set(d.num, { lat, lon });
      log.debug(`node_update num=${d.num} pos cached lat=${lat.toFixed(5)} lon=${lon.toFixed(5)}`);
      resetDwell(d.num, { lat, lon });
      return;
    }

    if (ev.type === 'packet') {
      const pkt = ev.data?.packet;
      if (!pkt?.from) {
        log.debug('packet has no from field — skipping');
        return;
      }
      const pos = lookupPos(pkt.from);
      if (!pos) {
        log.warn(`no pos for node ${pkt.from} portnum=${pkt.decoded?.portnum ?? 'none'} — skipping`);
        return;
      }
      log.debug(`packet from=${pkt.from} portnum=${pkt.decoded?.portnum ?? 'none'} rssi=${pkt.rx_rssi ?? 'n/a'} snr=${pkt.rx_snr ?? 'n/a'}`);
      resetDwell(pkt.from, pos, pkt.rx_rssi ?? null, pkt.rx_snr ?? null);
    }
  },

  stop() {
    log.info('stopping');
    if (_dwellTimer) { clearTimeout(_dwellTimer); _dwellTimer = null; }
    if (_staleTimer) { clearTimeout(_staleTimer); _staleTimer = null; }
    _candidate = null;
    _firedNum  = null;
    _lastRssi  = null;
    _lastSnr   = null;
    posCache.clear();
  },
};
