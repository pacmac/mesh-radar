import { EventEmitter } from 'events';
import { getConfig, setConfig, getMqttNode, listFavourites, listFavouriteNodes, stmts } from './db.js';
import { getRotatorAddress } from './device-config.js';
import { passesFilter, ownDeviceNums } from './node-filter.js';
import { haversine, bearing } from './utils.js';
import { clientRole } from './client-role.js';

const NEW_NODE_TTL = 86400; // 24 hours

// Hops-away, computed the way the Meshtastic firmware does (NodeDB.cpp
// getHopsAway): hop_start - hop_limit, GUARDED. Returns null (UNKNOWN) so the
// caller leaves any prior value intact rather than storing a bogus distance.
//   - hop_start / hop_limit missing → unknown
//   - hop_start === 0               → unknown (old/MQTT packets that never set
//                                     it; the v3 0-hop has_bitfield exception
//                                     isn't visible in our event feed)
//   - hop_start < hop_limit         → unknown (invalid)
//   - else                          → hop_start - hop_limit (>= 0; 0 = direct)
export function hopsAway(hopStart, hopLimit) {
  if (hopStart == null || hopLimit == null) return null;
  if (hopStart === 0) return null;
  if (hopStart < hopLimit) return null;
  return hopStart - hopLimit;
}

function enrichFromCache(node) {
  const cached = getMqttNode(node.num);
  // CORE SSOT: our own "is this ours / what kind", server-derived so the browser
  // never classifies (BROWSER_CONTRACT). null for regular nodes. See client-role.md.
  const client_role = clientRole(node.user?.role ?? cached?.role ?? null);
  if (!cached) return { ...node, client_role };

  const now   = Math.floor(Date.now() / 1000);
  const isNew = cached.first_heard != null && (now - cached.first_heard) < NEW_NODE_TTL;

  const traceroute = cached.last_traceroute ? JSON.parse(cached.last_traceroute) : undefined;
  // Warm the persisted hops-away onto a COLD entry (no live value yet) so the
  // badge + max_hops filter start populated after a restart. A live node.hops
  // always wins — this only fills the gap.
  const hopsExtra = (node.hops == null && cached.hops_away != null) ? { hops: cached.hops_away } : {};
  // Persisted on nodeinfo, so it survives clearNodeCache().
  const favExtra = { favourite: !!cached.favourite };

  // Node already has identity — just tag _new and attach stored traceroute + warm hops
  if (node.user?.short_name || node.user?.long_name) {
    return isNew
      ? { ...node, client_role, _new: true, ...(traceroute ? { last_traceroute: traceroute } : {}), ...hopsExtra, ...favExtra }
      : { ...node, client_role, ...(traceroute ? { last_traceroute: traceroute } : {}), ...hopsExtra, ...favExtra };
  }

  // Backfill identity + position from cache
  return {
    ...node,
    client_role,
    ...favExtra,
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
    ...(traceroute ? { last_traceroute: traceroute } : {}),
    ...hopsExtra,
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
    this._persistedHops = new Map(); // num → last hops_away persisted (write dedup)
  }

  _ownNums() { return ownDeviceNums(); }

  // Called for each bridge node_update (and node_info) event
  handleNodeUpdate(ev) {
    // Strip the gw's UNGUARDED aggregate `hops` — node hops-away is owned
    // solely by setHopsAway (guarded, per-packet). See "Hops-away ownership".
    const { hops: _gwHops, ...node } = ev.data ?? {};
    if (!node?.num) return;

    // Route all updates about own BLE devices to _ownDevices (Devices tab).
    // This covers both self-reports and cross-device reports (e.g. YAGI reporting about OMNI).
    // _filter() excludes own nums from the public node list regardless of how they enter.
    if (this._ownNums().has(node.num)) {
      // _device is MAC-first, matching _cache._device (identity Phase B, B8)
      this._ownDevices.set(node.num, { ...(this._ownDevices.get(node.num) ?? {}), ...node, _device: ev.__ble_addr ?? ev.addr ?? ev.node_id ?? null });
      this._scheduleEmit();
      return;
    }

    const rotatorId = getRotatorAddress();
    // During scan, ignore updates from non-rotator devices
    if (this._scanActive && rotatorId && ev.addr && ev.addr !== rotatorId) return;

    // node_info is a nodedb REPLAY on every BLE sync — both radios replay the
    // same nodedb, so it is never evidence that this radio HEARD the node.
    // _device/_devices are written only by heard-evidence paths
    // (touchLastHeard, confirmScanContact, restoreDeviceAttribution);
    // attributing here tagged every node with every radio and made the
    // node_source filter a no-op.
    if (this._scanActive) {
      if (this._cache.has(node.num)) {
        // Already promoted by scan_contact — update in place
        const existing = this._cache.get(node.num);
        this._cache.set(node.num, enrichFromCache({ ...existing, ...node }));
        this._scheduleEmit();
      } else {
        // Buffer — only promote when scan_contact confirms this node was actually heard
        const existing = this._pending.get(node.num) ?? {};
        this._pending.set(node.num, enrichFromCache({ ...existing, ...node }));
      }
      return;
    }

    // PASV/ACTV: enrich EXISTING entries only. node_info replays the radio's
    // whole nodedb on BLE sync — creating entries here puts never-heard nodes
    // on the radar and the ACTV rotator queue (the recurring phantom-target
    // bug). Liveness (entry creation) is reserved for heard packets
    // (touchLastHeard), the opt-in boot seed, and confirmed scan contacts.
    if (!this._cache.has(node.num)) return;
    const existing = this._cache.get(node.num) ?? {};
    this._cache.set(node.num, enrichFromCache({ ...existing, ...node }));
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

  // Patch environment_metrics onto the in-memory entry (own devices and regular cache)
  setEnvironmentMetrics(num, data) {
    if (this._ownDevices.has(num)) {
      this._ownDevices.set(num, { ...this._ownDevices.get(num), environment_metrics: data });
      this._scheduleEmit();
      return;
    }
    const existing = this._cache.get(num) ?? this._pending.get(num);
    if (existing) {
      const patched = { ...existing, environment_metrics: data };
      if (this._cache.has(num)) this._cache.set(num, patched);
      else                       this._pending.set(num, patched);
      this._scheduleEmit();
    }
  }

  // Patch guarded hops-away onto the in-memory entry (per received packet).
  // hops comes from hopsAway(pkt.hop_start, pkt.hop_limit): a null (UNKNOWN)
  // is ignored so a prior KNOWN value survives — mirrors the firmware's
  // updateFrom, which only sets hops_away when it can compute it.
  setHopsAway(num, hops) {
    if (hops == null) return;
    // Write-through to nodeinfo (deduped) so REPORTED hops survives restarts and
    // accumulates like the firmware NodeDB — independent of live-cache membership.
    if (this._persistedHops.get(num) !== hops) {
      stmts.upsertNodeHopsAway.run({ num, hops });
      this._persistedHops.set(num, hops);
    }
    if (this._ownDevices.has(num)) {
      const cur = this._ownDevices.get(num);
      if (cur.hops === hops) return;
      this._ownDevices.set(num, { ...cur, hops });
      this._scheduleEmit();
      return;
    }
    const existing = this._cache.get(num) ?? this._pending.get(num);
    if (!existing || existing.hops === hops) return;
    const patched = { ...existing, hops };
    if (this._cache.has(num)) this._cache.set(num, patched);
    else                       this._pending.set(num, patched);
    this._scheduleEmit();
  }

  // Save a traceroute result for a node — persists to SQLite and patches in-memory entry
  setTraceroute(num, data, fromNum, rxDevice) {
    stmts.upsertTraceroute.run({ num, json: JSON.stringify(data) });
    const info = stmts.insertTracerouteHistory.run({
      ts:              Math.floor((data.ts ?? Date.now()) / 1000),
      from_num:        fromNum ?? null,
      to_num:          num,
      rx_device:       rxDevice ?? null,
      route:           JSON.stringify(data.route ?? []),
      route_back:      JSON.stringify(data.route_back ?? []),
      snr_towards:     JSON.stringify(data.snr_towards ?? []),
      snr_back:        JSON.stringify(data.snr_back ?? []),
      relay_positions: JSON.stringify(data.relay_positions ?? {}),
      tx_device:       data.tx_device ?? null,
      rotator_az:      data.rotator_az ?? null,
      status:          'ok',
    });
    const historyId = info.lastInsertRowid;
    const existing = this._cache.get(num) ?? this._pending.get(num);
    if (existing) {
      const patched = { ...existing, last_traceroute: data };
      if (this._cache.has(num))   this._cache.set(num, patched);
      else                         this._pending.set(num, patched);
      this._scheduleEmit();
    }
    // History row id — WS-pushed rows carry it so the browser table keys
    // live rows the same way as replayed ones (C1, WS-only page data)
    return historyId;
  }

  // Called when scanner emits a scan_contact — promotes pending node data into the live cache
  confirmScanContact(num, device, az, rssi, snr) {
    const scanFields = { _scanAz: az ?? null, _scanRssi: rssi ?? null, _scanSnr: snr ?? null };
    // A scan contact IS heard evidence — stamp the scanning device
    const tag = (entry) => {
      const prevDevs = entry._devices ?? (entry._device ? [entry._device] : []);
      return {
        _device:  entry._device ?? device ?? null,
        _devices: device && !prevDevs.includes(device) ? [...prevDevs, device] : prevDevs,
      };
    };
    if (this._pending.has(num)) {
      const pending = this._pending.get(num);
      this._cache.set(num, { ...pending, ...scanFields, ...tag(pending) });
      this._pending.delete(num);
    } else if (this._cache.has(num)) {
      // Repeat contact — update scan fields if signal is better
      const existing = this._cache.get(num);
      if (snr == null || existing._scanSnr == null || snr > existing._scanSnr) {
        this._cache.set(num, { ...existing, ...scanFields, ...tag(existing) });
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
      // Snapshot the live list — the scan works on a clean slate, but the
      // PASV/ACTV world must come back at scan end (previously the wipe was
      // permanent: post-scan ACTV starved on a near-empty radar).
      this._preScanCache = this._cache;
      this._cache = new Map();
      this._pending.clear();
      if (clearPersisted) setConfig('scan_nodes', []);
    } else if (this._preScanCache) {
      // Restore the pre-scan list; confirmed scan contacts overlay it —
      // their signal/az/identity data is fresher than the snapshot's.
      const restored = this._preScanCache;
      for (const [num, n] of this._cache) {
        restored.set(num, { ...(restored.get(num) ?? {}), ...n });
      }
      this._cache = restored;
      this._preScanCache = null;
    }
    this._scheduleEmit();
  }

  // Bulk seed from bridge REST (call on bridge connect or scan start)
  // forceDevice: if true, device tag overwrites any existing _device (used for scan reseed)
  seed(nodes, device, forceDevice = false) {
    for (const rawN of nodes) {
      if (rawN.num == null) continue;
      // Drop the gw's unguarded hops — owned solely by setHopsAway (guarded).
      const { hops: _gwHops, ...n } = rawN;

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

  // Restore device attribution from SQLite after a cold seed.
  // nodes.device holds the last device that received each node's packet.
  restoreDeviceAttribution(rows) {
    let changed = false;
    for (const { num, device } of rows) {
      if (!device || !this._cache.has(num)) continue;
      const existing = this._cache.get(num);
      const prevDevs = existing._devices ?? (existing._device ? [existing._device] : []);
      if (prevDevs.includes(device)) continue;
      this._cache.set(num, {
        ...existing,
        _device:  existing._device ?? device,
        _devices: [...prevDevs, device],
      });
      changed = true;
    }
    if (changed) this._scheduleEmit();
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

  // Favourites are stored on nodeinfo, but cached node objects were enriched
  // when the node was last HEARD — so toggling a favourite leaves the cache
  // stale and the filter bypass never fires. Sync the flag onto the cache
  // explicitly, then emit.
  syncFavourites() {
    const favs = new Set(listFavourites().map(f => f.num));
    for (const [num, node] of this._cache) {
      const isFav = favs.has(num);
      if (!!node.favourite !== isFav) this._cache.set(num, { ...node, favourite: isFav });
    }
    this._scheduleEmit();
  }

  get homePos() {
    const lat = getConfig('home.lat', null);
    const lon = getConfig('home.lon', null);
    return lat != null && lon != null ? { lat, lon } : null;
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

    // "Favourites are ALWAYS excluded from ALL filters" includes the implicit
    // filter of not having been heard yet: the live cache is in-memory, so a
    // favourite that has not transmitted since the last restart would otherwise
    // vanish from the list it is pinned in. Seed any missing one from the
    // persisted nodeinfo row.
    const present = new Set(filtered.map(n => n.num));
    for (const f of listFavouriteNodes()) {
      if (present.has(f.num) || ownNums.has(f.num)) continue;
      filtered.push({
        num: f.num,
        favourite: true,
        _fromCache: true,          // not heard this session — identity only
        hops: f.hops_away ?? null,
        user: { id: f.node_id, short_name: f.short_name, long_name: f.long_name,
                hw_model: f.hw_model, role: f.role },
        position: (f.lat != null && f.lon != null)
          ? { latitude_i: Math.round(f.lat * 1e7), longitude_i: Math.round(f.lon * 1e7) }
          : undefined,
      });
    }

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
