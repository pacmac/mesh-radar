import { getConfig, stmts } from './db.js';
import { getRotatorAddress, getAllDeviceCfgs } from './device-config.js';
import { nodeIdToNum } from './utils.js';

let _macToNum = null;
export function registerMacToNumResolver(fn) { _macToNum = fn; }

// Returns the set of node nums for all configured BLE devices.
// Requires the live resolver registered by index.js at startup; returns an
// empty set before registration (safe — no bridge events arrive before then).
// No identity is ever inferred from MAC-suffix arithmetic.
// Cached alongside the filter, for the same reason the door set is: passesFilter
// runs per node per emission and this is a table scan.
let _rf = null, _rfAt = 0;
export function rfHeardNums({ force = false } = {}) {
  const now = Date.now();
  if (!force && _rf && (now - _rfAt) < 60_000) return _rf;
  const s = new Set();
  try { for (const r of stmts.rfHeardNums.all()) s.add(Number(r.num)); }
  catch { if (_rf) return _rf; }
  _rf = s; _rfAt = now;
  return s;
}

export function ownDeviceNums() {
  if (!_macToNum) return new Set();
  return new Set(
    Object.keys(getAllDeviceCfgs())
      .map(mac => _macToNum(mac))
      .filter(n => n != null && !isNaN(n))
  );
}

// Returns true if node passes all current user-configured filters.
// Options:
//   scanActive  – when true, applies scan-contact check and forces the filter
//                 onto whichever LIVE device is sweeping (getRotatorAddress()),
//                 never a hardcoded role name — a deployment with no rotator
//                 configured simply gets no device filtering during a scan
//   ownNums     – pre-computed Set to avoid re-reading config on every call
export function passesFilter(node, { scanActive = false, ownNums = null, rfHeard = null } = {}) {
  const nums = ownNums ?? ownDeviceNums();
  if (nums.has(node.num)) return false;

  // Favourites bypass EVERY filter — max_age, hops, named_only, has_pos,
  // hide_mqtt, has_signal, has_telem, msg_only, roles, node_source.
  // Placed AFTER the own-gateway guard: a gateway is excluded structurally
  // (it belongs on the Devices page), not by a filter, so favouriting one must
  // not inject it into the node list.
  if (node.favourite) return true;

  const now       = Math.floor(Date.now() / 1000);
  const maxAge    = getConfig('node_filters.max_age',    0);
  const maxHops   = getConfig('node_filters.max_hops',   99);
  const namedOnly = getConfig('node_filters.named_only', false);
  const hasPos    = getConfig('node_filters.has_pos',    false);
  const hideMqtt  = getConfig('node_filters.hide_mqtt',  false);
  // MQTT-ONLY NODES, HIDDEN BY DEFAULT. Peter, 2026-08-05: "we are not really
  // interested in that because that is cheating and does not use radio for the
  // whole path, so that should be a node-filter with default to off."
  //
  // A BACKEND filter, so it governs every page at once — distinct from the radar
  // layer toggles, which are per-viewer view preferences and change nothing about
  // what a page is allowed to see.
  //
  // `hide_mqtt` above tests a per-node via_mqtt flag that is never populated —
  // the `nodes` table has no such column — so it has always been dead. This one
  // tests rf_last_heard, which is stamped on RF packets and was backfilled from
  // local signal evidence.
  const hideMqttOnly = getConfig('node_filters.hide_mqtt_only', true);
  const hasSignal = getConfig('node_filters.has_signal', false);
  const hasTelem  = getConfig('node_filters.has_telem',  false);
  const msgOnly   = getConfig('node_filters.msg_only',   false);
  const roles     = getConfig('node_filters.roles',      []);
  // 'all' means no device filtering. Any other value is a device MAC, taken
  // literally — never a role name like 'yagi'/'omni'. Peter, 2026-10-11:
  // "nobody ever said there would be 1,2,3 or any number of radios or that
  // any of them would be directional with a rotator." idiot entry
  // node-source-filter-hardcodes-omni-yagi.
  const source    = scanActive ? getRotatorAddress() : getConfig('node_filters.node_source', 'all');

  if (maxAge > 0 && node.last_heard && (now - node.last_heard) > maxAge) return false;

  const hops = node.hops_away ?? node.hops ?? 0;
  if (hops > maxHops) return false;

  if (namedOnly && !node.user?.long_name) return false;
  if (hasPos    && !node.position?.latitude_i) return false;
  if (hideMqtt  && node.via_mqtt) return false;
  // Never heard by radio => reached only over the internet. `rf_heard` is
  // resolved by the caller (nodeRfHeard set) because the live cache row does not
  // carry it; absent set means "cannot tell", and we do not hide on a guess.
  if (hideMqttOnly && rfHeard && !rfHeard.has(node.num)) return false;
  if (hasSignal && node.snr == null && node.rssi == null) return false;
  if (hasTelem  && !node.device_metrics) return false;
  if (msgOnly   && node.user?.is_unmessagable) return false;

  // Protobuf omits default enum values on the wire: a missing role IS 'CLIENT'
  const role = node.user?.role ?? node.role ?? 'CLIENT';
  if (roles.length > 0 && !roles.includes(role)) return false;

  if (source && source !== 'all') {
    const devs = node._devices ?? (node._device ? [node._device] : []);
    if (!devs.includes(source)) return false;
  }

  if (scanActive && node._scanAz == null && node._scanSnr == null) return false;

  return true;
}
