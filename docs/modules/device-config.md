---
module: device-config
source: src/device-config.js
source_hash: 1caf8a959e858fec7755edb2e23506606bc944f1f94977a62fa693a3ff2950c5
updated: 2026-07-16
---

# Module: device-config

## Purpose

Per-device configuration registry for BLE radios. Stores antenna properties,
role flags (rotator, primary), and fallback home position per MAC address.
Provides helper accessors used throughout the backend and exposes a REST API
for reading and updating device configs.

## Responsibilities

- Store and retrieve per-device config from the config DB under `device_cfg.<MAC>` keys
- Provide `getRotatorAddress()` and `getPrimaryMac()` for role-based device lookup
- Migrate legacy `!hexid`-keyed config entries to canonical uppercase MAC keys via `ensureDeviceCfgMac`
- Notify callers when the primary device's home position changes (`onHomePosChange`)
- Expose a `_nodeIdToMac` resolver (registered at startup) for !hexid → MAC lookups in REST endpoints
- Serve REST endpoints for GET/PUT device configuration by address

## Dependencies

- `db.js` — `getConfig`, `setConfig`, `deleteConfig`, `getConfigByPrefix`
- `express` — `Router`

## Exports

```js
// Callback registrations (call once at startup)
export function onHomePosChange(cb)                 // cb() fired when primary device fixed_lat/lon changes
export function registerNodeIdToMacResolver(fn)     // fn(!hexid) → MAC|null — live MAC lookup
export function registerMacToNodeIdResolver(fn)     // fn(MAC) → !hexid|null — live node ID lookup

// Primary device helpers
export function resolvePrimaryNodeId()              // → !hexid|MAC|null — live node ID of primary device
export function macToNodeId(mac)                    // → !hexid|MAC|null — resolve any MAC to its live node ID (falls through to MAC)

// Config read helpers
export function getDeviceCfg(address)               // → {...DEFAULT, ...stored} — by MAC (normalised to uppercase)
export function getAllDeviceCfgs()                   // → { [MAC]: cfg } — all devices
export function getPrimaryMac()                      // → MAC|null — first device with is_primary=true
export function getRotatorAddress()                  // → MAC|null — first device with is_rotator=true

// Migration helper
export function ensureDeviceCfgMac(addr, nodeId)    // migrate legacy !hexid key → MAC or bootstrap empty

// REST router (mounted at /device-config by index.js)
export default router
```

## Config key format

```
device_cfg.<UPPERCASE_MAC>   e.g.  device_cfg.E9:B0:3F:17:27:91
```

Keys are always normalised to uppercase by `getDeviceCfg` and `ensureDeviceCfgMac`. Legacy entries may exist under `device_cfg.!hexid` form (pre-migration).

## Per-device config fields (defaults)

| Field | Default | Meaning |
|---|---|---|
| `label` | null | Display label (OMNI, YAGI, Y, O, etc.) |
| `is_rotator` | false | This radio is physically mounted on the rotator |
| `is_primary` | false | This radio drives the Overview tab / status display |
| `load_nodes_on_boot` | false | Pre-load node list when bridge connects (slow) |
| `antenna_type` | null | Text description e.g. "DL6WU 5el Yagi" |
| `beam_deg` | 360 | Beam width in degrees (360 = omni) |
| `gain_dbi` | 0 | Antenna gain in dBi |
| `cable_loss_db` | 0 | Cable loss in dB |
| `fixed_lat` | null | Fallback home position latitude (decimal degrees) |
| `fixed_lon` | null | Fallback home position longitude (decimal degrees) |
| `color` | null | DaisyUI theme color for badges/radar |
| `ble_pin` | null | BLE pairing PIN — SSOT here; paired status lives in bleak_db, never here |

## REST API

### `GET /device-config`
Returns `{ [MAC]: cfg }` for all configured devices.

### `GET /device-config/:address`
Address may be a MAC or `!hexid`.
- MAC: returns `getDeviceCfg(mac)`
- `!hexid`: resolves to MAC via `_nodeIdToMac` if device is live; otherwise reads the legacy `device_cfg.!hexid` key directly; falls back to DEFAULT

### `PUT /device-config/:address`
Address may be a MAC or `!hexid`.
- `!hexid`: must be currently live (404 if not). Migrates any legacy `!hexid` key to MAC on first write.
- Accepts a partial body — only fields present in the request body are updated.
- **`is_primary` singleton**: when setting `is_primary=true`, clears `is_primary` from all other devices.
- **Home-pos callback**: if `fixed_lat` or `fixed_lon` changed AND `is_primary=true`, calls `_onHomePosChange()`.
- Returns the updated config object.

## `ensureDeviceCfgMac(addr, nodeId)` migration logic

Called by `ws-relay.js` when a device appears in a `device_state` event.

```
mac = addr.toUpperCase()
all = getConfigByPrefix('device_cfg.')

if nodeId is known AND exists as a key in all:
  → migrate: setConfig(device_cfg.<mac>, all[nodeId]); deleteConfig(device_cfg.<nodeId>)
elif device_cfg.<mac> does not yet exist:
  → bootstrap: setConfig(device_cfg.<mac>, {...DEFAULT})
else:
  → no-op (MAC entry already exists)
```

Identity is never inferred from MAC-suffix arithmetic.

## Callers

| Caller | Imports |
|---|---|
| `index.js` | all exports; mounts router; registers both resolvers; calls `onHomePosChange` |
| `dash-mode.js` | `getRotatorAddress`, `getPrimaryMac`, `macToNodeId` (per-mode transmitter resolution) |
| `lifecycle.js` | `getRotatorAddress`, `onHomePosChange` |
| `active-tracker.js` | `getRotatorAddress` |
| `scanner.js` | `getRotatorAddress` |
| `passive-tracer.js` | `getRotatorAddress` |
| `node-list.js` | `getRotatorAddress` |
| `node-filter.js` | `getRotatorAddress`, `getAllDeviceCfgs` |
| `node-label.js` | `getAllDeviceCfgs` |
| `ws-relay.js` | `ensureDeviceCfgMac` |

## Invariants

- `getRotatorAddress()` and `getPrimaryMac()` scan all configs on every call — no cache. Multiple calls may return different results if the config DB changes between calls (rare in practice).
- `is_primary` is a singleton: the PUT endpoint enforces at most one primary device. `getPrimaryMac()` returns the first match if multiple are set (should not happen in normal use).
- `getDeviceCfg(address)` always returns a complete object with all DEFAULT fields. Missing keys from DB are filled with defaults. Callers can destructure safely.
- `_nodeIdToMac` is null until `registerNodeIdToMacResolver` is called. REST endpoints gracefully handle `null` by treating the !hexid as unresolvable.
- `_macToNodeId` is null until `registerMacToNodeIdResolver` is called. `resolvePrimaryNodeId()` falls back to returning the raw MAC if the resolver is null or returns null.
- `resolvePrimaryNodeId()` returns null if no primary device is configured; returns the MAC as fallback if `_macToNodeId` has no mapping (device not yet live).
- `_onHomePosChange` fires only when `is_primary=true` on the device being updated. Changes to a non-primary device's home position are silently ignored.

## Test notes

- **getRotatorAddress**: one device with `is_rotator=true` → returns its MAC; none → returns null
- **getPrimaryMac**: one device with `is_primary=true` → returns its MAC; none → returns null
- **PUT is_primary singleton**: device A already primary → PUT device B with `is_primary=true` → A's `is_primary` cleared; B's set
- **PUT homePos callback**: primary device, change `fixed_lat` → `_onHomePosChange` called; non-primary device change → not called
- **ensureDeviceCfgMac migration**: MAC has no entry, nodeId has legacy entry → MAC gets the data, nodeId entry deleted
- **ensureDeviceCfgMac bootstrap**: MAC has no entry, nodeId not in DB → MAC bootstrapped with DEFAULT
- **ensureDeviceCfgMac idempotent**: MAC already exists → no change
- **GET !hexid live**: `_nodeIdToMac('!abc')` returns a MAC → returns that device's cfg
- **GET !hexid not live, legacy exists**: `_nodeIdToMac` returns null, legacy `device_cfg.!abc` present → returns legacy merged with DEFAULT
- **PUT !hexid not live**: 404 response

## Out of scope

- BLE paired status — lives in bleak_db (mesh-gw side), never in this module
- Which radio is currently connected — `bridge.js` / `ws-relay.js` own the live device list
- Home position computation — `active-tracker.js` reads `getConfig('home.lat')` separately; the `fixed_lat/fixed_lon` here are device-specific fallbacks

## Phase C2

The PUT handler calls `pokeDeviceList()` after writing so the enriched
`device_list` (which carries each device's `cfg`) rebroadcasts immediately.
GET /device-config remains for tooling but the browser no longer calls it.

## Key validation + removal (task `device-remove-op`, 2026-07-16)

- `GET/PUT /:address` reject keys that are neither MAC- nor `!hexid`-shaped
  with 400 — this kills the `device_cfg.UNDEFINED` creation path (a browser
  bug once sent `PUT /device-config/undefined`; the perf task filtered the
  phantom in the UI and deferred the real cleanup here).
- `ensureDeviceCfgMac` bootstraps a default row only for MAC-shaped keys.
- `deleteDeviceCfg(key)` exported — removes a cfg row by MAC (uppercased) or
  legacy `!hexid` key (as stored). Called by `device-remove.js`.
- One-time idempotent purge at module load deletes any malformed
  `device_cfg.*` rows, logging each purged key.
