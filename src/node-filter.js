import { getConfig } from './db.js';
import { getRotatorDeviceId, getAllDeviceCfgs } from './device-config.js';

// Returns the set of nums for all configured BLE devices.
export function ownDeviceNums() {
  return new Set(
    Object.keys(getAllDeviceCfgs())
      .filter(id => id.startsWith('!'))
      .map(id => parseInt(id.slice(1), 16))
  );
}

// Returns true if node passes all current user-configured filters.
// Options:
//   scanActive  – when true, applies scan-contact check and forces yagi source
//   ownNums     – pre-computed Set to avoid re-reading config on every call
export function passesFilter(node, { scanActive = false, ownNums = null } = {}) {
  const nums = ownNums ?? ownDeviceNums();
  if (nums.has(node.num)) return false;

  const now       = Math.floor(Date.now() / 1000);
  const maxAge    = getConfig('node_filters.max_age',    0);
  const maxHops   = getConfig('node_filters.max_hops',   99);
  const namedOnly = getConfig('node_filters.named_only', false);
  const hasPos    = getConfig('node_filters.has_pos',    false);
  const hideMqtt  = getConfig('node_filters.hide_mqtt',  false);
  const hasSignal = getConfig('node_filters.has_signal', false);
  const hasTelem  = getConfig('node_filters.has_telem',  false);
  const msgOnly   = getConfig('node_filters.msg_only',   false);
  const roles     = getConfig('node_filters.roles',      []);
  const source    = scanActive ? 'yagi' : getConfig('node_filters.node_source', 'both');
  const rotatorId = getRotatorDeviceId();

  if (maxAge > 0 && node.last_heard && (now - node.last_heard) > maxAge) return false;

  const hops = node.hops_away ?? node.hops ?? 0;
  if (hops > maxHops) return false;

  if (namedOnly && !node.user?.long_name) return false;
  if (hasPos    && !node.position?.latitude_i) return false;
  if (hideMqtt  && node.via_mqtt) return false;
  if (hasSignal && node.snr == null && node.rssi == null) return false;
  if (hasTelem  && !node.device_metrics) return false;
  if (msgOnly   && node.user?.is_unmessagable) return false;

  if (roles.length > 0 && node.role != null && !roles.includes(node.role)) return false;

  if (rotatorId && source !== 'both') {
    const devs = node._devices ?? (node._device ? [node._device] : []);
    if (source === 'yagi' && !devs.includes(rotatorId)) return false;
    if (source === 'omni' && devs.length > 0 && devs.every(d => d === rotatorId)) return false;
  }

  if (scanActive && node._scanAz == null && node._scanSnr == null) return false;

  return true;
}
