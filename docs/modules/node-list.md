---
module: node-list
source: src/node-list.js
source_hash: 5464cd57beb218c867094be80842e0365cef19227c6816eebaf6e618b6d5c57b
updated: 2026-06-30
---

# Module: node-list

## Purpose

In-memory node cache and the single source of truth for the live node list. Aggregates
node identity, position, telemetry, and scan results from all gw events into a unified
per-node entry. Emits a debounced `'change'` event when the list changes so consumers
(ws-relay, active-tracker, passive-tracer) react to a single stream rather than
individual field updates.

Owns the scan buffering state machine: during a BLE scan, node updates are held in a
pending buffer until `confirmScanContact` proves physical proximity.

## Responsibilities

- Maintain `_cache`: live node entries that pass the current filter
- Maintain `_pending`: node entries buffered during scan, not yet confirmed by `scan_contact`
- Maintain `_ownDevices`: own BLE device nodes (never scan-filtered, never cleared on scan start)
- Route own-device updates to `_ownDevices` and remote-node updates to `_cache`/`_pending`
- Backfill identity and position from `nodeinfo` (permanent DB) when live data lacks them (`enrichFromCache`)
- Compute `_km` / `_az` relative to `home.lat`/`home.lon` config for positioned nodes
- Debounce `'change'` emission — 150 ms coalesce window to avoid per-field update storms
- Write traceroute results to SQLite (`stmts.upsertTraceroute`, `stmts.insertTracerouteHistory`) and patch in-memory entry

## Dependencies

- `db.js` — `getConfig`, `setConfig`, `getMqttNode`, `stmts`
- `device-config.js` — `getRotatorAddress`
- `node-filter.js` — `passesFilter`, `ownDeviceNums`
- `utils.js` — `haversine`, `bearing`
- `node:events` — EventEmitter base

## Public interface

### Singleton

```js
export const nodeList  // instance of NodeList
```

### Getters

```js
nodeList.nodes            // → nodeData[]  — filtered, __km/__az annotated if homePos set
nodeList.ownDeviceNodes   // → nodeData[]  — own BLE device entries (unfiltered)
nodeList.homePos          // → {lat,lon}|null  — from config 'home.lat'/'home.lon'
```

### Mutation methods

```js
// Bridge event ingest
nodeList.handleNodeUpdate(ev)
// ev: { data: nodeData, device: string|null, __ble_addr: string|null (v2, not yet used) }

// Packet receipt — update last_heard and device tag
nodeList.touchLastHeard(num, ts, device = null)

// Patch environment metrics onto in-memory entry
nodeList.setEnvironmentMetrics(num, data)

// Write traceroute result to DB and patch in-memory entry
nodeList.setTraceroute(num, data, fromNum, rxDevice)

// SCAN: promote pending node into live cache
nodeList.confirmScanContact(num, device, az, rssi, snr)

// SCAN: restore confirmed contacts after restart
nodeList.restoreScanNodes(nodes)

// Toggle scan mode — clears cache/pending on activation
nodeList.setScanActive(active, clearPersisted = true)

// Bulk seed from bridge REST (connect or scan start)
nodeList.seed(nodes, device, forceDevice = false)

// Restore device attribution from SQLite after cold seed
nodeList.restoreDeviceAttribution(rows)

// Seed a single own-device node
nodeList.seedOwnDevice(node, deviceId)

// Wipe all in-memory state (call after clearNodeCache())
nodeList.clear()

// Re-apply filter without new data (after config change)
nodeList.refilter()
```

## State

| Field | Type | Description |
|---|---|---|
| `_cache` | Map\<num, nodeData\> | Live confirmed nodes; the SSOT passed to consumers |
| `_pending` | Map\<num, nodeData\> | Buffered during scan; not yet confirmed by `scan_contact` |
| `_ownDevices` | Map\<num, nodeData\> | Own BLE device self-reports; never filtered, never cleared on scan |
| `_scanActive` | boolean | Scan mode flag; gates routing in `handleNodeUpdate` and `touchLastHeard` |
| `_emitTimer` | Timer\|null | Debounce handle for `'change'` emission (150 ms) |

### Node entry metadata fields (not from gw)

| Field | Set by | Meaning |
|---|---|---|
| `_device` | all mutation methods | Last BLE MAC that received data for this node |
| `_devices` | all mutation methods | All BLE MACs that have received data for this node |
| `_from_cache` | `enrichFromCache` | Identity/position backfilled from `nodeinfo` |
| `_new` | `enrichFromCache` | `first_heard` within last 24 h |
| `_scanAz` | `confirmScanContact` | Rotator azimuth at scan contact |
| `_scanRssi` | `confirmScanContact` | RSSI at scan contact |
| `_scanSnr` | `confirmScanContact` | SNR at scan contact; used to pick best contact on repeat |
| `_km` | `_filter` | Haversine distance from home position |
| `_az` | `_filter` | Bearing from home position |

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'change'` | `nodeData[]` | 150 ms after any state change; filtered and annotated |

## Scan state machine

```
setScanActive(true)
  → _cache.clear(), _pending.clear()
  → all handleNodeUpdate calls: own-device → _ownDevices; from non-rotator device → dropped;
    from rotator: if in _cache → update in place; else → buffer in _pending

confirmScanContact(num, …)
  → if in _pending → promote to _cache, delete from _pending
  → if in _cache → update scan fields if SNR improves
  → if neither → create minimal entry; node_update will enrich later
  → persists _cache to config('scan_nodes')

setScanActive(false)
  → _scanActive = false; future updates go directly to _cache
  → _pending entries remain until next scan start (they are not promoted)

restoreScanNodes(nodes)  — called on restart when scan was in progress
  → only nodes with _scanAz or _scanSnr (confirmed contacts) are restored
```

## Invariants

- `nodeList` is the single source of truth for the live node list. No other module maintains a parallel map of live nodes (except `_liveNodeIds` in `ws-relay.js` — a v1 artifact to be removed).
- `_ownDevices` entries are never cleared on `setScanActive(true)` or `clear()`. They are only updated, never removed.
- `_filter()` always excludes own-device nums (`ownDeviceNums()`), regardless of how they arrived in `_cache`.
- `touchLastHeard` is a no-op during scan (`_scanActive === true`). Packet receipts do not promote pending entries.
- `confirmScanContact` persists the live `_cache` to config `'scan_nodes'` on every call so progress survives a restart.
- `enrichFromCache` is idempotent: running it twice on the same node produces the same result.
- `_scheduleEmit` coalesces all changes within a 150 ms window into a single `'change'` emission.
- **v1 defect**: `ev.device` is used as the device key throughout (`handleNodeUpdate`, `seed`, etc.). After `bridge.js` v2 alignment, `ev.__ble_addr` must be used exclusively.
- `setTraceroute` writes directly to `db.stmts` — a mixed concern. Traceroute DB writes are coupled to the node cache because the in-memory patch and the DB write must stay in sync.

## Test notes

- **`handleNodeUpdate` PASV/ACTV**: event arrives → node in `_cache` with correct `_device` and `_devices`; `'change'` fires after 150 ms
- **`handleNodeUpdate` scan buffering**: `setScanActive(true)` → event from rotator → node in `_pending`, not `_cache`; event from non-rotator → dropped
- **`confirmScanContact` promotion**: pending node → promoted to `_cache` with `_scanAz`/`_scanRssi`/`_scanSnr` set
- **`confirmScanContact` SNR update**: repeated contact with better SNR → fields updated; worse SNR → ignored
- **`touchLastHeard` no-op during scan**: `setScanActive(true)` → `touchLastHeard` → `_cache` unchanged
- **`seed` scan mode**: confirmed entries in `_cache` get enriched, preserve scan fields; unconfirmed → `_pending`
- **`enrichFromCache` backfill**: node with no identity → `getMqttNode` returns cached names → returned node has `user.short_name` set, `_from_cache: true`
- **`_new` flag**: `first_heard` < 24 h ago → `_new: true`; older → `_new: false`
- **`clear()`**: both `_cache` and `_pending` empty; `_ownDevices` unchanged
- **`refilter()`**: no data change → `'change'` fires with same filtered set
- **`homePos` annotation**: node with position + homePos set → `_km` and `_az` present in `'change'` payload
- **`setEnvironmentMetrics`**: patches `environment_metrics` onto `_cache` entry; also patches `_pending` if not in cache; also patches `_ownDevices` if own device num

## Out of scope

- Filter rules — `node-filter.js` owns `passesFilter`
- Label resolution — `node-label.js` owns name lookup
- Broadcasting to browser WebSocket — `ws-relay.js` listens to `'change'`
- Scan rotation control — `scanner.js` owns the scan sequence; it calls `confirmScanContact`
- Traceroute lifecycle management — `traceroute.js` owns the request/response cycle; it calls `setTraceroute`

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Device attribution uses `ev.node_id ?? ev.addr` (V2 removed `device`); the scan-time source filter compares `ev.addr` against the rotator MAC.
