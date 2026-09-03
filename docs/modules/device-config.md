---
module: device-config
source: src/device-config.js
source_hash: 186812a4987a3f6e75225b3266948d1a4f5508b68f26b210e29056bbbff4b97d
updated: 2026-09-03
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
export function getDeviceCfg(address)               // → {...DEFAULT, ...stored, ...meshGwOwnedFields} — by MAC (normalised to uppercase)
export function getAllDeviceCfgs()                   // → { [MAC]: cfg } — all devices, same merge as getDeviceCfg
export function getPrimaryMac()                      // → MAC|null — first device with is_primary=true
export function getRotatorAddress()                  // → MAC|null — first device with is_rotator=true (mesh-gw-sourced)

// mesh-gw SSOT wiring (call once at startup, from ws-relay.js)
export function registerInstallLookup(fn)           // fn(MAC) → mesh-gw install object|null — live, from lastDeviceState

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
| `label` | null | Display label (OMNI, YAGI, Y, O, etc.) — **mesh-gw SSOT**, see below |
| `is_rotator` | false | This radio is physically mounted on the rotator — **mesh-gw SSOT**, see below |
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

## Absent is not cleared, and a sparse read must not become a write (2026-08-05)

Peter: *"I have set that several times, something wiped it out"* — home elevation
and the OMNI/YAGI fixed positions.

Three paths conflated **"not supplied"** with **"set to nothing"**. All three are
fixed; the third is the one that reached the radios.

| path | was | now |
|---|---|---|
| `PUT /home_pos` (`index.js`) | any field absent from the body was written as `null` — a PUT carrying only `lon` erased the latitude, and `op-manager`'s `home_position` op declares `example_payload {lat: null, lon: null}` | a key absent from the body leaves the stored value alone; an explicit `''`/`null` still clears |
| `device-config` `fixed_lat/lon` | already guarded with `!== undefined`, but a form submitting a blank input sends `''`, which clears | unchanged in behaviour, now documented — the protection is that a caller who says nothing changes nothing |
| `collectForm` → radio section PUT | submitted **every** field in the schema on every save | submits only fields the READ returned, or that the user actually touched |

### The third one is how a radio lost `fixed_position`

`mesh-gw`'s `GET /{node_id}/config/{section}` returns **only non-default fields**.
`collectForm` submitted every field in the schema. So a boolean the read omitted
rendered as an unchecked box and went back on the wire as an explicit `false` —
an unrelated edit anywhere in the section silently cleared it.

Evidence: OMNI held `fixed_position: true`, YAGI did not have the key at all —
same schema, same form. Both have `gps_mode: NOT_PRESENT`, so neither can
re-acquire a position on its own, which is why YAGI could not recover.

The gw's own rejection message names the fields its read returned as the
**required** ones, so omitting the rest is accepted and leaves them untouched.
That is what makes the fix safe rather than merely quieter.

It also closes a worse race: if the read had not returned, the form was blank and
that blank form could be submitted as real values. Now nothing is submitted and
the write is rejected loudly instead of clobbering the radio.

`collectForm(container, fields)` without the third argument behaves exactly as
before, so the other four callers are unaffected.

### `home.alt`

New. It never existed — zero references in `src/` or `public/` before this — which
is why setting it never persisted. Metres above sea level at the mast base.
Nothing else in the system had an elevation to work from, including the link
budget.

## mesh-gw is now SSOT for `label` and `is_rotator` (2026-09-03)

Peter, 2026-09-03: *"mesh-gw has expanded a lot. it is now the SSOT for devices, so our
datastore needs to relinquish that to mesh-gw."*

mesh-gw shipped `docs/gw/modules/device_install_object.md` (2026-09-01) — an `install`
object per device, carried on every `device_data`/`device_snapshot` WS event and already
flowing into `ws-relay.js`'s `lastDeviceState[addr].install` (spread there via
`Object.assign(flat, d.data_event)` / `{...existing, ...fields, data_event: ev}` — no new
fetch, no new subscription):

```json
"install": {
  "alias": "YAGI2",
  "description": "9-element yagi on the roof mast, ...",
  "antenna": { "directional": true, "rotator": { "host": "...", "port": 81, "api_ver": "v5", "url": "...", "lat": ..., "lon": ..., "alt": ... } }
}
```

**Measured live, same day, proving the local copy had drifted:** after the physical Yagi
swap (`F4:12:FA:39:F7:B6` → `FC:0A:85:C6:EC:B7`, "YAGI2"), `device_cfg` for the new MAC sat
at `{label:null, is_rotator:false}` — bootstrap defaults, never populated — while mesh-gw's
`install` already had `alias:"YAGI2", antenna.rotator:{...}` correct and complete.
`getRotatorAddress()` returned `null`: no `device_cfg` row anywhere had `is_rotator:true`,
because the flag had been cleared from the old MAC during the swap and never set on the
new one. Every consumer below was silently running with "no rotator configured" while a
working rotator sat connected the whole time.

**Symptom already seen in this session, independently:** the Garage node's Signal tile
showed `F4:12:FA:39:F7:B6` (a raw MAC, not a name) for its most-recent-but-one radio —
`node-label.js resolveDeviceLabel()` falls back to the bare MAC exactly when
`getAllDeviceCfgs()[mac].label` is null, which is this same gap.

### What moves, what stays

Field-by-field survey (Investigate phase) against mesh-gw's live `/devices` response:

| `device_cfg` field | mesh-gw equivalent | this task |
|---|---|---|
| `label` | `install.alias` | **relinquished** |
| `is_rotator` | `install.antenna.rotator != null` | **relinquished** |
| `is_primary`, `load_nodes_on_boot`, `antenna_type`, `beam_deg`, `gain_dbi`, `cable_loss_db`, `antenna_height_m`, `fixed_lat`, `fixed_lon`, `color`, `ble_pin` | none seen (`ble_pin` deliberately excluded by mesh-gw, per `radio_rotator_config.md`; `beam_deg`'s mesh-gw analogue `antenna.beamwidth_deg` is `null` in every live sample; `antenna.rotator.alt` is mast ASL altitude, not `antenna_height_m`'s "height above ground") | **stays local**, unchanged |

Rotator **connection endpoint** (`install.antenna.rotator.{host,port,api_ver,url}`, and the
self-sufficient `point` route for commanding it without v4/v5 dialect knowledge) is real and
usable, but is a separate, larger change — `rotator.js` currently sources its targets from
`ROTATOR_WS_URL`/`ROTATOR_V5_WS_URL` env vars / the `rotator_targets` config key, connecting
**directly** to the mast, not through mesh-gw. Swapping that source, or routing rotator
commands through mesh-gw's `/plugins/aim/point` instead of a direct connection, touches live
shared hardware and is **explicitly out of scope for this task** — a candidate follow-up,
not bundled in here.

### The mechanism: one merge point, not nine call-site edits

`getDeviceCfg()` already normalises `{...DEFAULT, ...stored}` for every caller. Both
mesh-gw-owned fields fold in at that single point — `getAllDeviceCfgs()` and
`getRotatorAddress()` are the only other functions in this file that read config directly
rather than through `getDeviceCfg()`, so they are the only other edits needed. Every
external consumer (`resolve.js`, `dash-mode.js`, `node-filter.js`, `doors.js`,
`node-label.js`, `node-list.js`, `lifecycle.js`, `startup.js`, `ws-relay.js`'s own `cfg:`
field) needs **no changes** — they already call `getDeviceCfg`/`getAllDeviceCfgs`/
`getRotatorAddress` and inherit the fix.

**Wiring, to avoid a circular import.** `device-config.js` cannot import `ws-relay.js`
(`ws-relay.js` already imports `getDeviceCfg`/`ensureDeviceCfgMac` from here). Same pattern
already used for `_nodeIdToMac`/`_macToNodeId`: `ws-relay.js` calls
`registerInstallLookup(mac => lastDeviceState[mac]?.install ?? null)` once, inside
`attachWsRelay()`, right after `lastDeviceState` is declared.

### Exact diff

**`src/device-config.js`**

Add, near `registerMacToNodeIdResolver` (after line 18):

```js
// BEFORE — nothing here

// AFTER
let _installFor = null;
// Registered once by ws-relay.js. Returns mesh-gw's live `install` object for a
// MAC, or null before the device has reported one. mesh-gw SSOT for `label` and
// `is_rotator` — docs/gw/modules/device_install_object.md.
export function registerInstallLookup(fn) { _installFor = fn; }
```

`getDeviceCfg` (lines 63-65):

```js
// BEFORE
export function getDeviceCfg(address) {
  return { ...DEFAULT, ...getConfig(PREFIX + address.toUpperCase(), {}) };
}

// AFTER
export function getDeviceCfg(address) {
  const mac     = address.toUpperCase();
  const stored  = getConfig(PREFIX + mac, {});
  const install = _installFor?.(mac) ?? null;
  return {
    ...DEFAULT,
    ...stored,
    // mesh-gw is SSOT for these two once it has reported an install object —
    // a stale local flag must never outrank a live one (2026-09-03).
    ...(install ? { label: install.alias ?? null, is_rotator: install.antenna?.rotator != null } : {}),
  };
}
```

`getAllDeviceCfgs` (lines 68-70):

```js
// BEFORE
export function getAllDeviceCfgs() {
  return getConfigByPrefix(PREFIX);
}

// AFTER
export function getAllDeviceCfgs() {
  const stored = getConfigByPrefix(PREFIX);
  const merged = {};
  for (const mac of Object.keys(stored)) merged[mac] = getDeviceCfg(mac);
  return merged;
}
```

`getRotatorAddress` (lines 81-86) — same iteration shape, reads through the merge instead of
the raw stored row:

```js
// BEFORE
export function getRotatorAddress() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_rotator) return mac;
  }
  return null;
}

// AFTER
export function getRotatorAddress() {
  for (const mac of Object.keys(getConfigByPrefix(PREFIX))) {
    if (getDeviceCfg(mac).is_rotator) return mac;
  }
  return null;
}
```

`getPrimaryMac` is **not touched** — `is_primary` has no mesh-gw equivalent and stays
entirely local.

**`src/ws-relay.js`**

Import (line 63):

```js
// BEFORE
import { ensureDeviceCfgMac, getDeviceCfg } from './device-config.js';

// AFTER
import { ensureDeviceCfgMac, getDeviceCfg, registerInstallLookup } from './device-config.js';
```

Registration, right after `lastDeviceState` is declared (line 447):

```js
// BEFORE
  const lastDeviceState = {};

// AFTER
  const lastDeviceState = {};
  registerInstallLookup(mac => lastDeviceState[mac]?.install ?? null);
```

### Explicitly NOT changed by this task

- `resolve.js`, `dash-mode.js`, `node-filter.js`, `doors.js`, `node-label.js`,
  `node-list.js`, `lifecycle.js`, `startup.js` — inherit the fix through the accessors
  they already call. No edits.
- `is_primary`, `load_nodes_on_boot`, `antenna_type`, `beam_deg`, `gain_dbi`,
  `cable_loss_db`, `antenna_height_m`, `fixed_lat`, `fixed_lon`, `color`, `ble_pin` — no
  mesh-gw equivalent exists yet; stay local, unchanged.
- Rotator connection endpoint (`ROTATOR_WS_URL`/`ROTATOR_V5_WS_URL`/`rotator_targets`) and
  whether rotator commands should route through mesh-gw's `/plugins/aim/point` — real,
  larger questions, deliberately left for a separate task.
- The `tab-devices.html` "Save label" control still PUTs to `/device-config/:address`
  locally (`op-manager.js` `device_config_label`, class `Local`). Once mesh-gw is SSOT for
  `label`, a local write is silently overridden on the next `install` event (last-write-wins
  toward mesh-gw, since `getDeviceCfg` always prefers `install` when present) rather than
  rejected — worth a UI follow-up (grey out / repoint the field) but not a correctness bug
  in this task's scope: no data is corrupted, the write just stops being the thing that
  sticks.

### Restored 2026-08-05

- `home.lat/lon` `51.0263296, -3.1588352` (were intact), `home.alt` **30 m**
  (SRTM bare-earth at the mast base — revise once the mast height is known).
- `device_cfg.fixed_lat/lon` set to the same on both OMNI and YAGI. Peter:
  *"the radios should be identical to our real home position."*
- Pushed to both radios (`PUT /{id}/fixed_position`, `verified:true`), and
  YAGI's `fixed_position` flag re-enabled — a position packet does not set it,
  it is a separate field in the position section.
- Both radios now report `fixed_position = True`.
