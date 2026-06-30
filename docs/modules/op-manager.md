---
module: op-manager
source: src/op-manager.js
source_hash: a3ea309acd6216cefb300c802ce1bf7b2fba7b26983af5e996628fab2b552ea2
updated: 2026-06-30
---

# Module: op-manager

## Purpose

Unified save-and-validate lifecycle for all dashboard write actions. Accepts an
operation request, executes it asynchronously (write → optional read-back), and
broadcasts the state transitions as `config_op` WebSocket events. Decouples the
REST request/response from the async execution, letting the browser track progress
via WS events.

## Responsibilities

- Maintain a registry (`REGISTRY`) of all named write operations with their class, HTTP method, endpoint, read-back path, match fields, and example payloads
- Accept op submissions synchronously and return an `op_id` immediately
- Run the appropriate runner class (Local, Radio, or Mode) asynchronously
- Broadcast state transitions (`saving → validating → success | error`) as `config_op` WS events
- Garbage-collect completed ops after 5 minutes
- Expose REST endpoints for submission, status polling, and the manifest

## Dependencies

- `express` — `Router`
- `node:crypto` — `randomUUID`
- `process.env.PORT` (default `8000`) — local loopback URL for write and read-back fetches
- `_bridge` (BridgeClient injected at construction) — `on/off('device_state')` for Mode WS postcondition

## Exports

```js
export class OpManager
```

### Constructor

```js
new OpManager(broadcastFn, bridge = null)
```

- `broadcastFn(payload)` — called on every state transition; typically `ws-relay.broadcast`
- `bridge` — `BridgeClient` instance; required for `device_state_ready` postcondition. Null disables WS postcondition (times out immediately).

### Public methods

```js
opManager.submit(kind, target, payload)  // → op_id (string)
opManager.router                          // Express Router — mount at /op and /ops
```

## Op state machine

```
submit()
  → state = 'saving'  [broadcast]
  → runner (Local / Radio / Mode)
      → if read-back path: state = 'validating'  [broadcast]
  → state = 'success'  [broadcast]
  OR
  → state = 'error'   [broadcast]
  → GC after 5 min
```

Each transition calls `_transition(op, state)` which:
1. Updates `op.state`, `op.result`, `op.error`, `op.ts`
2. Calls `this._broadcast({ type: 'config_op', op_id, kind, target, state, result, error, ts })`
3. On `success`/`error`: schedules `_ops.delete(op_id)` after 5 minutes

## REGISTRY

27 named operations in 3 classes. Each entry:

| Field | Type | Meaning |
|---|---|---|
| `class` | `'Local'`\|`'Radio'`\|`'Mode'` | Which runner handles this op |
| `description` | string | Human-readable label (served in manifest) |
| `method` | string | HTTP method for the write (`GET`/`PUT`/`POST`/`DELETE`/`PATCH`) |
| `endpoint` | `(params) => string` | Absolute path for the write request |
| `read_back_path` | `(params) => string \| null` | Path for GET after write; null skips read-back |
| `match_fields` | `string[]` | Fields to compare between write body and read-back response |
| `example_payload` | object | Safe test payload for `test_ops.py` and the manifest |
| `timeout_s` | number | Maximum seconds for the full operation |
| `reboot` | boolean | Whether a radio reboot is expected (informational; not used by runners) |
| `confirming` | string | Mode only: `'http_200'` or `'device_state_ready'` |

### Class 1 — Local (14 ops)

Written to node-dash's own config/DB. Read-back is immediate.

| Kind | Write endpoint | Read-back |
|---|---|---|
| `device_config_label` | `PUT /device-config/:target` | same |
| `device_config_color` | `PUT /device-config/:target` | same |
| `device_config_primary` | `PUT /device-config/:target` | same |
| `ble_auto_connect` | `PATCH /ble_devices/:target` | `/bridge_config` |
| `antenna_config` | `PUT /device-config/:target` | same |
| `home_position` | `PUT /home_pos` | same |
| `bridge_config` | `PUT /bridge_config` | same |
| `alert_config` | `PUT /alerts/config` | same |
| `alert_rule` | `PUT /alerts/rules/:target` | `/alerts/rules` |
| `radar_config` | `PUT /config/radar` | same |
| `auto_purge_settings` | `PUT /auto-purge` | `/auto-purge?device=:target` |
| `mqtt_publish_config` | `PUT /mqtt_publish` | same |
| `tilt_cal` | `PUT /tilt_cal` | same |
| `clear_range_test_log` | `DELETE /range_test/log` | same |

### Class 2 — Radio (6 ops)

Written through node-dash to mesh-gw and then to the radio. Read-back verifies the value was accepted by the firmware.

| Kind | Write endpoint | Read-back |
|---|---|---|
| `radio_config_section` | `PUT /:target/config/:section` | none |
| `channel_config` | `PUT /:target/channels/:index` | same |
| `owner_info` | `PUT /:target/owner` | same |
| `fixed_position_push` | `PUT /:target/fixed_position` | same |
| `fixed_position_clear` | `DELETE /:target/fixed_position` | none |
| `send_message` | `POST /:target/messages` | none |

### Class 3 — Mode (10 ops)

Action triggers. Confirmation is either the HTTP 200 response or a WS `device_state` event.

| Kind | Trigger | Confirming |
|---|---|---|
| `wipe_nodedb` | `POST /purge-nodedb` | `http_200` |
| `rotator_mode_pasv` | `POST /rotator/mode` | `http_200` |
| `rotator_mode_actv` | `POST /rotator/mode` | `http_200` |
| `rotator_move` | `POST /rotator/move` | `http_200` |
| `rotator_scan_start` | `POST /rotator/scan/start` | `http_200` |
| `rotator_scan_abort` | `POST /rotator/scan/abort` | `http_200` |
| `range_test_start` | `POST /range_test/start` | `http_200` |
| `range_test_stop` | `POST /range_test/stop` | `http_200` |
| `send_alert_test` | `POST /alerts/test` | `http_200` |
| `ble_connect` | `POST /devices` | `device_state_ready` |
| `ble_disconnect` | `DELETE /devices/:target` | `http_200` |
| `send_traceroute` | `POST /:target/traceroute` | `http_200` |

## Runners

### LocalRunner (`_localRunner`)

1. `_localFetch(method, endpoint(params), params.values)` — write
2. Non-2xx → throw `Write failed HTTP N`
3. If `read_back_path` null → return `{ ok: true }`
4. Transition to `'validating'`
5. `_localFetch('GET', read_back_path(params))` — read-back
6. `_compareMatchFields(entry, body, readBackJson)` — throw on mismatch

### RadioRunner (`_radioRunner`)

Identical to `LocalRunner`. The distinction is architectural (future runners may add retry or device-state awareness), but the current code shares the same logic.

### ModeRunner (`_modeRunner`)

1. If `confirming === 'device_state_ready'`: arm `_waitForStateChange(target, s => s==='READY', timeout)` **before** the write to avoid a race with fast events.
2. `_localFetch(method, endpoint(params), params.values)` — trigger
3. Non-2xx → throw
4. If `postconditionPromise`: await it; timeout → throw `did not reach expected state`
5. Return `{ ok: true, data: writeResponseJson }`

### `_waitForStateChange(target, condition, timeoutMs)`

Registers `bridge.on('device_state', handler)`. Handler matches on `ev.node_id === target OR ev.addr === target`. Returns a Promise that resolves `true` when the condition is met or `false` on timeout. If `_bridge` is null, resolves `false` immediately.

## `_compareMatchFields(entry, body, responseJson)`

Iterates `entry.match_fields`. For each field present in `body`, compares `JSON.stringify(body[field])` to `JSON.stringify(flat[field])` where `flat = _flattenResponse(responseJson)`.

`_flattenResponse`: if the response is a single-key object whose value is also an object (e.g. `{ telemetry: {...} }`), unwraps it one level. This handles config sections that wrap their response.

Mismatches accumulate and are thrown as a single error.

## REST endpoints (mounted on `opManager.router`)

### `POST /op`

Body: `{ kind, target?, payload? }`.
- Unknown `kind` → 400
- Valid → calls `submit()` → returns `{ op_id }` immediately
- Async runner fires in background; state arrives via WS `config_op` events

### `GET /ops/manifest`

Returns `{ count, ops[] }` — full REGISTRY serialized. Each entry includes `kind`, `class`, `description`, `method`, `timeout_s`, `reboot`, `has_read_back`, `match_fields`, `confirming`, `example_payload`. Used by `test_ops.py` to enumerate all ops for automated testing.

### `GET /op/:op_id`

Returns the current op state: `{ op_id, kind, target, state, result, error, ts }`.
- 404 if op not found or already GC'd (completed ops are GC'd after 5 minutes).

## Invariants

- `submit()` returns the `op_id` before the async runner starts. The browser must track state via WS `config_op` events, not the submit response.
- All fetches in runners go to `http://localhost:PORT` — ops call node-dash's own REST layer, not bridge directly. This means op execution is subject to the same REST middleware as external callers.
- Failed ops (non-2xx write or read-back mismatch) always reach `state = 'error'` with a message. Uncaught runner exceptions are caught in `_run` and also transition to `'error'`.
- `_transition` is always called on state entry — there is no silent state change.
- `device_state_ready` postcondition listener is armed **before** the write to handle cases where the device reaches READY before the HTTP response arrives.
- `_waitForStateChange` matches on both `node_id` and `addr` because a connecting device may only report its BLE MAC (`addr`) before acquiring a mesh node ID.
- **LocalRunner and RadioRunner are currently identical** — the class distinction is forward-looking for future retry/reboot detection.
- Op state is in-memory only. A server restart loses all in-flight and completed ops.

## Test notes

- **unknown kind**: `submit('bad_op', null, {})` → throws `Unknown op kind`
- **local success**: write returns 200, read-back matches → `state = 'success'`; broadcast called twice (saving, success)
- **local write failure**: write returns 400 → `state = 'error'`; error message includes HTTP status
- **local read-back mismatch**: write ok, read-back `color='red'` but expected `'blue'` → `state = 'error'`; mismatch message
- **local no read-back**: `read_back_path = null` → only one fetch; transitions saving → success
- **mode http_200**: trigger returns 200, no WS postcondition → `state = 'success'`
- **mode device_state_ready — fast**: bridge emits `device_state` with `state='READY'` before await → resolves true
- **mode device_state_ready — timeout**: no WS event within timeout → `state = 'error'`
- **mode bridge null**: `bridge = null`, confirming = 'device_state_ready' → resolves false immediately → error
- **flattenResponse**: `{ telemetry: { hop_limit: 3 } }` → `{ hop_limit: 3 }` for field comparison
- **GC**: after success/error, op removed from `_ops` after 5 min; `GET /op/:op_id` → 404
- **manifest**: `GET /ops/manifest` → `count: 27`, one entry per REGISTRY key

## Out of scope

- Authentication or rate-limiting of op submissions
- Queuing — ops run immediately and concurrently; no serial queue
- Retry on failure — each op runs once; retry is the caller's responsibility
- Persistent op history — in-memory only; lost on restart
- Browser rendering of op state — `ws-relay.js` relays `config_op` events to the browser
