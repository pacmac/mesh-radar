---
module: config-api
source: src/config-api.js
source_hash: 147f1a9d9c60bbae8895c952043ced6bbcde39f8b3585055d5d1b15618c05022
updated: 2026-07-03
---

# Module: config-api

## Purpose

Express router for frontend display and filter configuration. Manages the 17
config keys that control what the browser shows — node filters, sort order,
radar display, message filters, and mode timing. Triggers node-list refiltering
when filter-relevant keys change.

## Responsibilities

- Read and write display/filter config keys via REST
- Provide a composite `/radar` sub-resource grouping display + mode timing config
- Validate all key names against a known DEFAULTS map (404/400 on unknown/missing)
- Call `nodeList.refilter()` whenever any `node_filters.*` key changes
- Expose mode timing defaults (pasv/actv/scan) alongside radar display settings

## Dependencies

- `db.js` — `getConfig`, `setConfig`
- `node-list.js` — `nodeList.refilter()`
- `express` — `Router`

## Exports

```js
export default router  // Express Router — mounted at /config by index.js
```

## Config keys and defaults (DEFAULTS)

| Key | Default | Meaning |
|---|---|---|
| `node_filters.max_age` | `0` | Max age (seconds) since last heard; 0 = no filter |
| `node_filters.max_hops` | `99` | Max hop count; 99 = no filter |
| `node_filters.named_only` | `false` | Require long_name to be set |
| `node_filters.has_pos` | `false` | Require lat/lon |
| `node_filters.hide_mqtt` | `false` | Exclude MQTT-sourced nodes |
| `node_filters.has_signal` | `false` | Require SNR reading |
| `node_filters.has_telem` | `false` | Require battery telemetry |
| `node_filters.roles` | `[]` | Allowlist of roles (empty = all) |
| `node_filters.node_source` | `'both'` | `'ble'`, `'mesh'`, or `'both'` |
| `node_sort.field` | `'last_heard'` | Sort field |
| `node_sort.dir` | `-1` | Sort direction: -1 = DESC, ≥0 = ASC |
| `radar.max_range_km` | `50` | Radar display range in km |
| `radar.log_scale` | `false` | Logarithmic radar scale |
| `radar.crosshair` | `false` | Show crosshair on radar |
| `message_filter.channels` | `[]` | Channel allowlist (empty = all) |
| `message_filter.hide_mqtt` | `false` | Exclude MQTT-sourced messages |
| `packet_sources` | `[]` | Packet source filter |
| `range_test.duration` | `10` | Default range test duration (minutes) |
| `perf.failure_epoch` | `null` | Read-only stamp (unix s): when traceroute failure recording began — the perf page treats pre-epoch windows as "n/a" (task `perf-honesty` step 2) |

`NODE_FILTER_KEYS` is the subset of keys starting with `node_filters.` — used to decide when to call `nodeList.refilter()`.

## REST endpoints

All paths are relative to the mount point `/config`.

### `GET /config`

Returns an object with all 18 DEFAULTS keys, each populated from `getConfig(key, default)`. No query parameters.

### `GET /config/radar`

Returns a composite object grouping display settings and mode timing:

```js
{
  display: { max_range_km, log_scale, crosshair },
  pasv:    { stale_sec: 1800, stale_fail_sec: 600, timeout_sec: 60, ...db },
  actv:    { dwell_sec: 90, retry_sec: 30, ...db },
  scan:    { step_deg: 5, dwell_sec: 60, ...db },
}
```

Mode objects are merged from in-code defaults + stored `pasv_config`/`actv_config`/`scan_config` objects (which are stored as single JSON blobs, not per-key).

### `PUT /config/radar`

Body: `{ display?, pasv?, actv?, scan? }` — any combination of sub-objects.

- `display`: allowed fields `max_range_km`, `log_scale`, `crosshair` → stored as individual `radar.*` keys
- `pasv`: allowed fields `stale_sec`, `stale_fail_sec`, `timeout_sec` → merged into `pasv_config` object
- `actv`: allowed fields `dwell_sec`, `retry_sec` → merged into `actv_config` object
- `scan`: allowed fields `step_deg`, `dwell_sec` → merged into `scan_config` object

Values for mode fields are coerced to `Number`. Unknown fields in each sub-object are silently ignored. Returns `{ ok: true }`.

### `GET /config/:key`

Returns `{ key, value }` for a single DEFAULTS key. 404 if `key` is not in DEFAULTS.

### `PUT /config/:key`

Body: `{ value }`. Sets `key` to `value` via `setConfig`. If `key` is in `NODE_FILTER_KEYS`, calls `nodeList.refilter()`. Returns `{ key, value }`.

- 404 if key unknown
- 400 if `value` is missing from body

### `PUT /config` (bulk)

Body: `{ [key]: value, ... }`. Updates multiple keys at once.

- 400 if body is not an object or any key is unknown (returns list of unknown keys)
- Calls `nodeList.refilter()` once if any of the updated keys is a `node_filter` key
- Returns the updates object

## Invariants

- Only keys present in DEFAULTS can be read or written via this router. Unknown keys return 404/400.
- `nodeList.refilter()` is called at most once per request, even for bulk PUT with multiple node_filter keys.
- The `/radar` sub-resource mixes per-key storage (`radar.*`) with blob storage (`pasv_config`, `actv_config`, `scan_config`). The two storage patterns are not unified.
- `PUT /radar` coerces mode values to `Number` before storing. Passing non-numeric strings results in `NaN` stored silently.
- `PUT /config/radar` does not trigger `nodeList.refilter()` even if scan config changes, because scan timing is not a node filter.
- `GET /config` does not include `pasv_config`, `actv_config`, or `scan_config` blobs — those are only accessible via `GET /config/radar`.

## Callers

| Caller | Usage |
|---|---|
| `index.js` | `app.use('/config', configRouter)` |

## Test notes

- **GET /**: returns object with all 17 keys at defaults when DB is empty
- **PUT /:key — node_filter**: `PUT /config/node_filters.named_only` with `{value: true}` → `nodeList.refilter()` called
- **PUT /:key — non-filter**: `PUT /config/radar.max_range_km` → `nodeList.refilter()` NOT called
- **PUT /:key — unknown**: 404 `{ error: 'Unknown config key' }`
- **PUT /:key — missing value**: 400 `{ error: 'value required' }`
- **PUT / — bulk**: updates 3 keys including 2 node_filter → `refilter()` called once
- **PUT / — unknown key**: 400 listing the unknown key name
- **GET /radar**: `pasv.stale_sec = 1800` by default; after `PUT /radar { pasv: { stale_sec: 900 } }` → `pasv.stale_sec = 900`
- **PUT /radar — unknown display field**: `{ display: { unknown: 1 } }` → silently ignored, returns `{ ok: true }`

## Out of scope

- Node-dash operational config (bridge URL, rotator URL, DB path) — set via environment variables
- Device-specific config — `device-config.js` router owns that
- Alert rules and SMTP config — `index.js` directly manages those endpoints
- Bridge (mesh-gw) config — proxied by `index.js` to the bridge REST API

## Note (task `radar-display`)

`radar.log_scale` defaults to `true` — selects the adaptive quantile radial
scale (see docs/modules/app-radar.md); `false` is the linear opt-out. The
Config → Radar toggle is labelled "Adaptive scale".
