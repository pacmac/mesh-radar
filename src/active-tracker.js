import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { getRotatorDeviceId, getDeviceCfg } from './device-config.js';
import { stmts, insertRangeTestEntry, recordYagiTargeted, recordYagiContact } from './db.js';
import { nodeList } from './node-list.js';

const YAGI_DEVICE_ID = '!fa39f7b4';
const HOLD_MS        = 90_000;   // dwell time at each target
const RETRY_MS       = 30_000;   // retry delay when no eligible nodes available

let _holdTimer = null;
let _firedNum  = null;
let _firedAt   = null;
let _lastRssi  = null;
let _lastSnr   = null;

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

// Build prioritised visit queue from current filtered radar nodes.
// Sort: never targeted first, then least recently targeted.
function buildSchedule() {
  const home = getHomePos();
  if (!home) return [];

  return nodeList.nodes
    .filter(n => n.position?.latitude_i != null && n.position?.longitude_i != null)
    .map(n => {
      const lat  = n.position.latitude_i  / 1e7;
      const lon  = n.position.longitude_i / 1e7;
      const az   = bearing(home, { lat, lon });
      const info = stmts.getNodeinfoByNum.get(n.num) ?? {};
      return {
        num:                n.num,
        lat, lon, az,
        yagi_last_targeted: info.yagi_last_targeted ?? null,
        yagi_contact_count: info.yagi_contact_count ?? 0,
        label: n.user?.short_name ?? String(n.num),
      };
    })
    .sort((a, b) => {
      if (a.yagi_last_targeted === null && b.yagi_last_targeted !== null) return -1;
      if (b.yagi_last_targeted === null && a.yagi_last_targeted !== null) return  1;
      return (a.yagi_last_targeted ?? 0) - (b.yagi_last_targeted ?? 0);
    });
}

function pointAt(node) {
  _firedNum = node.num;
  _firedAt  = Date.now();
  _lastRssi = null;
  _lastSnr  = null;

  log.info(`→ ${node.label} (${node.num}) az=${node.az.toFixed(1)}°`);
  try {
    recordYagiTargeted(node.num);
    rotator.move(node.az);
    rotator.emit('point_target', { point_target: node.num, az: node.az, _mode: dashMode.value });
  } catch (err) {
    log.error('failed to command rotator:', err.message);
  }

  if (_holdTimer) clearTimeout(_holdTimer);
  _holdTimer = setTimeout(advance, HOLD_MS);
}

function advance() {
  const schedule = buildSchedule();
  if (schedule.length === 0) {
    log.warn('no eligible nodes in radar — retrying in 30s');
    _holdTimer = setTimeout(advance, RETRY_MS);
    return;
  }
  // Pick the top of the freshly sorted schedule (least recently targeted)
  pointAt(schedule[0]);
}

export const activeTracker = {
  start() {
    log.info('starting proactive scan');
    advance();
  },

  handlePacket(ev) {
    if (ev.device !== YAGI_DEVICE_ID) return;

    if (ev.type === 'packet') {
      const pkt = ev.data?.packet;
      if (!pkt?.from || pkt.from !== _firedNum) return;

      const rssi = pkt.rx_rssi ?? null;
      const snr  = pkt.rx_snr  ?? null;
      if (rssi != null) _lastRssi = rssi;
      if (snr  != null) _lastSnr  = snr;

      log.debug(`signal from ${_firedNum} rssi=${rssi ?? '?'} snr=${snr ?? '?'}`);
      rotator.emit('signal_update', { signal_num: _firedNum, rssi, snr, ts: Date.now() });
      try {
        recordYagiContact(_firedNum, rssi, snr);
        insertRangeTestEntry({ ts: Math.floor(Date.now() / 1000), from_num: _firedNum, rssi, snr, hops: null, seq: null, rx_device: YAGI_DEVICE_ID });
      } catch (err) { log.error('contact record failed:', err.message); }
    }
  },

  stop() {
    log.info('stopping');
    if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
    _firedNum = _firedAt = _lastRssi = _lastSnr = null;
  },
};
