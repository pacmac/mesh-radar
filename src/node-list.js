import { EventEmitter } from 'events';
import { getConfig } from './db.js';
import { getRotatorDeviceId, getAllDeviceCfgs } from './device-config.js';

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

class NodeList extends EventEmitter {
  constructor() {
    super();
    this._cache      = new Map(); // num (int) → nodeData
    this._scanActive = false;
    this._emitTimer  = null;
  }

  // Called for each bridge node_update (and node_info) event
  handleNodeUpdate(ev) {
    const node = ev.data;
    if (!node?.num) return;
    const existing = this._cache.get(node.num) ?? {};
    const newDev = ev.device ?? null;
    const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
    const devices = newDev && !prevDevs.includes(newDev) ? [...prevDevs, newDev] : prevDevs;
    this._cache.set(node.num, {
      ...existing,
      ...node,
      _device:  newDev ?? existing._device ?? null,
      _devices: devices,
    });
    this._scheduleEmit();
  }

  setScanActive(active) {
    if (this._scanActive === active) return;
    this._scanActive = active;
    if (active) this._cache.clear();
    this._scheduleEmit();
  }

  // Bulk seed from bridge REST (call on bridge connect)
  seed(nodes, device) {
    for (const n of nodes) {
      if (n.num == null) continue;
      const existing = this._cache.get(n.num) ?? {};
      const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
      const devices = device && !prevDevs.includes(device) ? [...prevDevs, device] : prevDevs;
      this._cache.set(n.num, {
        ...existing,
        ...n,
        _device:  existing._device ?? device ?? null,
        _devices: devices,
      });
    }
    this._scheduleEmit();
  }

  // Trigger refilter after a config change (no new data)
  refilter() {
    this._scheduleEmit();
  }

  get homePos() {
    const all = getAllDeviceCfgs();
    for (const cfg of Object.values(all)) {
      if (cfg?.is_primary && cfg.fixed_lat != null && cfg.fixed_lon != null) {
        return { lat: cfg.fixed_lat, lon: cfg.fixed_lon };
      }
    }
    return null;
  }

  get nodes() {
    return this._filter();
  }

  _filter() {
    const now       = Math.floor(Date.now() / 1000);
    const maxAge    = getConfig('node_filters.max_age',     0);
    const maxHops   = getConfig('node_filters.max_hops',    99);
    const namedOnly = getConfig('node_filters.named_only',  false);
    const hasPos    = getConfig('node_filters.has_pos',     false);
    const hideMqtt  = getConfig('node_filters.hide_mqtt',   false);
    const hasSignal = getConfig('node_filters.has_signal',  false);
    const hasTelem  = getConfig('node_filters.has_telem',   false);
    const roles     = getConfig('node_filters.roles',       []);
    // During scan, force YAGI-only regardless of saved nodeSource setting
    const source    = this._scanActive ? 'yagi'
                    : getConfig('node_filters.node_source', 'both');
    const rotatorId = getRotatorDeviceId();

    const filtered = Array.from(this._cache.values()).filter(n => {
      if (maxAge > 0 && n.last_heard && (now - n.last_heard) > maxAge) return false;

      const hops = n.hops ?? n.hops_away ?? 0;
      if (hops > maxHops) return false;

      if (namedOnly && !n.user?.long_name) return false;

      if (hasPos && !n.position?.latitude_i) return false;

      if (hideMqtt && n.via_mqtt) return false;

      if (hasSignal && n.snr == null && n.rssi == null) return false;

      if (hasTelem && !n.device_metrics) return false;

      // only filter by role when the node actually has a role field
      if (roles.length > 0 && n.role != null && !roles.includes(n.role)) return false;

      if (source === 'yagi' && rotatorId) {
        if (n._device !== rotatorId) return false;
      } else if (source === 'omni' && rotatorId) {
        if (n._device === rotatorId) return false;
      }

      return true;
    });

    const hp = this.homePos;
    if (!hp) return filtered;
    return filtered.map(n => {
      if (!n.position?.latitude_i || !n.position?.longitude_i) return n;
      const lat = n.position.latitude_i / 1e7;
      const lon = n.position.longitude_i / 1e7;
      return { ...n, _km: haversine(hp.lat, hp.lon, lat, lon), _az: bearing(hp.lat, hp.lon, lat, lon) };
    });
  }

  _scheduleEmit() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('change', this._filter());
    }, 150);
  }
}

export const nodeList = new NodeList();
