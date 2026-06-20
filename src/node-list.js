import { EventEmitter } from 'events';
import { setConfig, getMqttNode, stmts } from './db.js';
import { getRotatorDeviceId, getAllDeviceCfgs } from './device-config.js';
import { passesFilter, ownDeviceNums } from './node-filter.js';

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

const NEW_NODE_TTL = 86400; // 24 hours

function enrichFromCache(node) {
  const cached = getMqttNode(node.num);
  if (!cached) return node;

  const now   = Math.floor(Date.now() / 1000);
  const isNew = cached.first_heard != null && (now - cached.first_heard) < NEW_NODE_TTL;

  // Node already has identity — just tag _new if applicable
  if (node.user?.short_name || node.user?.long_name) {
    return isNew ? { ...node, _new: true } : node;
  }

  // Backfill identity + position from cache
  return {
    ...node,
    user: {
      id:         node.user?.id ?? cached.node_id,
      short_name: cached.short_name,
      long_name:  cached.long_name,
      hw_model:   cached.hw_model ?? node.user?.hw_model ?? null,
      role:       cached.role     ?? node.user?.role      ?? null,
    },
    position: (node.position?.latitude_i != null) ? node.position : (
      (cached.lat != null && Math.abs(cached.lat) <= 90 && Math.abs(cached.lon) <= 180) ? {
        latitude_i:  Math.round(cached.lat * 1e7),
        longitude_i: Math.round(cached.lon * 1e7),
        altitude:    cached.alt ?? 0,
      } : node.position
    ),
    _from_cache: true,
    _new: isNew,
  };
}

class NodeList extends EventEmitter {
  constructor() {
    super();
    this._cache      = new Map(); // num (int) → nodeData (scan-filtered SSOT)
    this._pending    = new Map(); // num (int) → nodeData buffered during scan
    this._ownDevices = new Map(); // num (int) → nodeData for device self-nodes only (never cleared, never scan-filtered)
    this._scanActive = false;
    this._emitTimer  = null;
  }

  _ownNums() { return ownDeviceNums(); }

  // Called for each bridge node_update (and node_info) event
  handleNodeUpdate(ev) {
    const node = ev.data;
    if (!node?.num) return;

    // Route all updates about own BLE devices to _ownDevices (Devices tab).
    // This covers both self-reports and cross-device reports (e.g. YAGI reporting about OMNI).
    // _filter() excludes own nums from the public node list regardless of how they enter.
    if (this._ownNums().has(node.num)) {
      this._ownDevices.set(node.num, { ...(this._ownDevices.get(node.num) ?? {}), ...node, _device: ev.device ?? null });
      this._scheduleEmit();
      return;
    }

    const rotatorId = getRotatorDeviceId();
    // During scan, ignore updates from non-rotator devices
    if (this._scanActive && rotatorId && ev.device && ev.device !== rotatorId) return;
    const newDev = ev.device ?? null;

    if (this._scanActive) {
      if (this._cache.has(node.num)) {
        // Already promoted by scan_contact — update in place
        const existing = this._cache.get(node.num);
        const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
        const devices = newDev && !prevDevs.includes(newDev) ? [...prevDevs, newDev] : prevDevs;
        const merged = enrichFromCache({ ...existing, ...node });
        this._cache.set(node.num, { ...merged, _device: newDev ?? existing._device ?? null, _devices: devices });
        this._scheduleEmit();
      } else {
        // Buffer — only promote when scan_contact confirms this node was actually heard
        const existing = this._pending.get(node.num) ?? {};
        const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
        const devices = newDev && !prevDevs.includes(newDev) ? [...prevDevs, newDev] : prevDevs;
        const merged = enrichFromCache({ ...existing, ...node });
        this._pending.set(node.num, { ...merged, _device: newDev ?? existing._device ?? null, _devices: devices });
      }
      return;
    }

    // PASV/ACTV: tag _devices from ev.device — the radio that received this event
    const existing = this._cache.get(node.num) ?? {};
    const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
    const devices = newDev && !prevDevs.includes(newDev) ? [...prevDevs, newDev] : prevDevs;
    const merged = enrichFromCache({ ...existing, ...node });
    this._cache.set(node.num, {
      ...merged,
      _device:  newDev ?? existing._device ?? null,
      _devices: devices,
    });
    this._scheduleEmit();
  }

  // Update last_heard and device tag from a received packet
  touchLastHeard(num, ts, device = null) {
    if (this._scanActive) return;
    if (!this._cache.has(num)) {
      // Node seen only via packet — hydrate identity+position from nodeinfo, or
      // fall back to nodes table for position only (so active-tracker targets stay visible)
      let hydrated = enrichFromCache({ num });
      if (!hydrated._from_cache) {
        const pos = stmts.getNodePos.get(num, num);
        if (!pos) return; // unknown node, skip
        hydrated = {
          num,
          position: { latitude_i: Math.round(pos.lat * 1e7), longitude_i: Math.round(pos.lon * 1e7) },
        };
      }
      this._cache.set(num, {
        ...hydrated,
        last_heard: ts ?? Math.floor(Date.now() / 1000),
        _device:  device ?? null,
        _devices: device ? [device] : [],
      });
      this._scheduleEmit();
      return;
    }
    const existing = this._cache.get(num);
    const newTs = ts ?? Math.floor(Date.now() / 1000);
    const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
    const devices = device && !prevDevs.includes(device) ? [...prevDevs, device] : prevDevs;
    const tsChanged = !existing.last_heard || existing.last_heard < newTs;
    const devChanged = devices !== prevDevs;
    if (!tsChanged && !devChanged) return;
    // Backfill position if the cached entry has none (e.g. seeded without position)
    let pos = existing.position?.latitude_i ? null : stmts.getNodePos.get(num, num);
    this._cache.set(num, {
      ...existing,
      ...(pos ? { position: { latitude_i: Math.round(pos.lat * 1e7), longitude_i: Math.round(pos.lon * 1e7) } } : {}),
      last_heard: tsChanged ? newTs : existing.last_heard,
      _device:  existing._device ?? device ?? null,
      _devices: devices,
    });
    this._scheduleEmit();
  }

  // Called when scanner emits a scan_contact — promotes pending node data into the live cache
  confirmScanContact(num, device, az, rssi, snr) {
    const scanFields = { _scanAz: az ?? null, _scanRssi: rssi ?? null, _scanSnr: snr ?? null };
    if (this._pending.has(num)) {
      this._cache.set(num, { ...this._pending.get(num), ...scanFields });
      this._pending.delete(num);
    } else if (this._cache.has(num)) {
      // Repeat contact — update scan fields if signal is better
      const existing = this._cache.get(num);
      if (snr == null || existing._scanSnr == null || snr > existing._scanSnr) {
        this._cache.set(num, { ...existing, ...scanFields });
      }
    } else {
      // scan_contact arrived before node_update — minimal entry; node_update will enrich it
      this._cache.set(num, { num, _device: device, _devices: device ? [device] : [], ...scanFields });
    }
    if (this._scanActive) setConfig('scan_nodes', Array.from(this._cache.values()));
    this._scheduleEmit();
  }

  // Restore persisted scan nodes (called on startup when resuming a scan)
  restoreScanNodes(nodes) {
    for (const n of nodes) {
      // Only restore nodes that were actually confirmed scan contacts
      if (n.num != null && (n._scanAz != null || n._scanSnr != null)) {
        this._cache.set(n.num, n);
      }
    }
    this._scheduleEmit();
  }

  setScanActive(active, clearPersisted = true) {
    if (this._scanActive === active) return;
    this._scanActive = active;
    if (active) {
      this._cache.clear();
      this._pending.clear();
      if (clearPersisted) setConfig('scan_nodes', []);
    }
    this._scheduleEmit();
  }

  // Bulk seed from bridge REST (call on bridge connect or scan start)
  // forceDevice: if true, device tag overwrites any existing _device (used for scan reseed)
  seed(nodes, device, forceDevice = false) {
    for (const n of nodes) {
      if (n.num == null) continue;

      if (this._scanActive) {
        if (this._cache.has(n.num)) {
          // Already a confirmed scan contact — enrich data but preserve scan fields
          const existing = this._cache.get(n.num);
          this._cache.set(n.num, {
            ...existing, ...n,
            _device: existing._device, _devices: existing._devices,
            _scanAz: existing._scanAz, _scanSnr: existing._scanSnr, _scanRssi: existing._scanRssi,
          });
        } else {
          // Not yet confirmed — buffer in pending so confirmScanContact can promote it
          const existing = this._pending.get(n.num) ?? {};
          const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
          const devices = device && !prevDevs.includes(device) ? [...prevDevs, device] : prevDevs;
          this._pending.set(n.num, { ...existing, ...n, _device: device ?? existing._device ?? null, _devices: devices });
        }
        continue;
      }

      const existing = this._cache.get(n.num) ?? {};
      const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
      const devices = device && !prevDevs.includes(device) ? [...prevDevs, device] : prevDevs;
      const enriched = enrichFromCache({ ...existing, ...n });
      this._cache.set(n.num, {
        ...enriched,
        _device:  forceDevice ? (device ?? null) : (existing._device ?? device ?? null),
        _devices: devices,
      });
    }
    this._scheduleEmit();
  }

  // Wipe all in-memory node state (call after clearing SQLite nodes table)
  clear() {
    this._cache.clear();
    this._pending.clear();
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

  // Seed own-device cache from REST data on bridge connect
  seedOwnDevice(node, deviceId) {
    if (!node?.num || !deviceId) return;
    this._ownDevices.set(node.num, { ...(this._ownDevices.get(node.num) ?? {}), ...node, _device: deviceId });
    this._scheduleEmit();
  }

  // Device self-nodes: never scan-filtered, for Devices tab metadata only
  get ownDeviceNodes() {
    return Array.from(this._ownDevices.values());
  }

  _filter() {
    const ownNums = ownDeviceNums();
    const filtered = Array.from(this._cache.values())
      .filter(n => passesFilter(n, { scanActive: this._scanActive, ownNums }));

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
