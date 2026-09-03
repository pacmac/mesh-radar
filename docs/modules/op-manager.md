---
module: op-manager
source: src/op-manager.js
source_hash: e7c49dd2b6ff6b15eff15b489844a9932de5e8cd636a4ebdad11ed9ec7d0c77d
updated: 2026-09-03
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

14 named operations in 3 classes (2026-09-03: down from 32 — see "Removed
2026-09-03" below). Each entry:

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
| `confirming` | string | Mode only: `'http_200'` or `'device_state_ready'` (no current op uses `device_state_ready` — its last user, `ble_connect`, was removed 2026-09-03; the branch stays, unreachable, in `_modeRunner`) |

### Class 1 — Local (10 ops)

Written to node-dash's own config/DB. Read-back is immediate.

| Kind | Write endpoint | Read-back |
|---|---|---|
| `home_position` | `PUT /home_pos` | same |
| `bridge_config` | `PUT /bridge_config` | same |
| `alert_config` | `PUT /alerts/config` | same |
| `alert_rule` | `PUT /alerts/rules/:target` | `/alerts/rules` |
| `radar_config` | `PUT /config/radar` | same |
| `auto_purge_settings` | `PUT /auto-purge` | `/auto-purge?device=:target` |
| `mqtt_publish_config` | `PUT /mqtt_publish` | same |
| `tilt_cal` | `PUT /tilt_cal` | same |
| `clear_range_test_log` | `DELETE /range_test/log` | same |

### Class 2 — Radio (1 op)

Written through node-dash to mesh-gw and then to the radio.

| Kind | Write endpoint | Read-back |
|---|---|---|
| `send_message` | `POST /:target/messages` | none |

### Class 3 — Mode (3 ops)

Action triggers. Confirmation is either the HTTP 200 response or a WS `device_state` event.

| Kind | Trigger | Confirming |
|---|---|---|
| `range_test_start` | `POST /range_test/start` | `http_200` |
| `range_test_stop` | `POST /range_test/stop` | `http_200` |
| `send_alert_test` | `POST /alerts/test` | `http_200` |

`send_traceroute` was removed 2026-08-17 (task `traceroute-callers-rewrite`).
Its endpoint, node-dash's own `POST /:target/traceroute`, no longer exists.
No op dispatches a traceroute.

## Removed 2026-09-03 (task `devices-management-removed-meshgw-owns-it`)

node-dash "is no longer responsible to manage devices" (Peter, 2026-09-03) —
mesh-gw owns BLE pairing, radio config, and device removal now; duplicating
those as ops here would be exactly the re-invention Peter ruled against.

- **Local**: `device_config_label`, `device_config_color`,
  `device_config_primary`, `antenna_config` — all wrote through the now-deleted
  `/device-config` REST API. `ble_auto_connect` — wrote `PATCH /ble_devices/:target`,
  gone with the BLE pairing surface.
- **Radio**: `radio_config_section`, `channel_config`, `owner_info`,
  `fixed_position_push`, `fixed_position_clear` — already removed 2026-08-18
  (see the radio-admin history below); this task did not touch them further.
- **Mode**: `wipe_nodedb` — device management. `rotator_mode_pasv`/`rotator_mode_actv`/
  `rotator_move`/`rotator_scan_start`/`rotator_scan_abort` — already dead (their
  endpoints were deleted 2026-09-03 in the earlier rotator-to-aim task and missed
  in that pass; cleaned up here rather than left as a second stale reference).
  `ble_connect`/`ble_disconnect` — BLE pairing, mesh-gw's job now.

## Runners

### LocalRunner (`_localRunner`)

1. `_localFetch(method, endpoint(params), params.values)` — write
2. Non-2xx → throw `Write failed HTTP N`
3. If `read_back_path` null → return `{ ok: true }`
4. Transition to `'validating'`
5. `_localFetch('GET', read_back_path(params))` — read-back
6. `_compareMatchFields(entry, body, readBackJson)` — throw on mismatch

### RadioRunner (`_radioRunner`)

1. `_localFetch(method, endpoint(params), params.values)` — write
2. Non-2xx → throw `Write failed HTTP N`
3. If `read_back_path` is null → return `{ ok: true }`
4. Otherwise transition to `'validating'`, retry the read-back and comparison up
   to 4 times with 1s/2s/3s backoff, and throw the last mismatch on exhaustion.

`channel_config` deliberately has no read-back. Mesh-gw's channel GET is a
connection cache, not a live firmware query, and remains stale after a channel
write until a reconnect/resync. Comparing the write to that cache creates a
deterministic false failure even when the BLE write was accepted.

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

### `POST /ops`

Body: `{ kind, target?, payload? }`.
- Unknown `kind` → 400
- Valid → calls `submit()` → returns `{ op_id }` immediately
- Async runner fires in background; state arrives via WS `config_op` events

### `GET /ops/manifest`

Returns `{ count, ops[] }` — full REGISTRY serialized. Each entry includes `kind`, `class`, `description`, `method`, `timeout_s`, `reboot`, `has_read_back`, `match_fields`, `confirming`, `example_payload`. Used by `test_ops.py` to enumerate all ops for automated testing.

### `GET /ops/:op_id`

Returns the current op state: `{ op_id, kind, target, state, result, error, ts }`.
- 404 if op not found or already GC'd (completed ops are GC'd after 5 minutes).

## `discovery_config`

`Local` class, `PUT /config/discovery`, read-back from the same path — mirroring
`radar_config`. Carries the six discovery settings; the server clamps them, so
the browser re-reads after a save rather than trusting what it sent.

## Invariants

- `submit()` returns the `op_id` before the async runner starts. The browser must track state via WS `config_op` events, not the submit response.
- All fetches in runners go to `http://localhost:PORT` — ops call node-dash's own REST layer, not bridge directly. This means op execution is subject to the same REST middleware as external callers.
- Failed ops (non-2xx write or read-back mismatch) always reach `state = 'error'` with a message. Uncaught runner exceptions are caught in `_run` and also transition to `'error'`.
- `_transition` is always called on state entry — there is no silent state change.
- `device_state_ready` postcondition listener is armed **before** the write to handle cases where the device reaches READY before the HTTP response arrives.
- `_waitForStateChange` matches on both `node_id` and `addr` because a connecting device may only report its BLE MAC (`addr`) before acquiring a mesh node ID.
- `channel_config` performs exactly one PUT and no validation GET. Gateway 2xx is
  the strongest synchronous evidence available at this boundary; non-2xx still
  transitions the operation to `error`.
- Radio operations that do have a fresh `read_back_path` retry comparison up to
  four times; Local operations compare once.
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
- **GC**: after success/error, op removed from `_ops` after 5 min; `GET /ops/:op_id` → 404
- **channel write accepted**: fake gateway returns 2xx → exactly one PUT, no GET,
  terminal `success`
- **channel write rejected**: fake gateway returns non-2xx → exactly one PUT, no
  GET, terminal `error` containing the HTTP status
- **manifest**: `GET /ops/manifest` → `count: 14`, one entry per REGISTRY key

## Out of scope

- Authentication or rate-limiting of op submissions
- Queuing — ops run immediately and concurrently; no serial queue
- Retry on failure — each op runs once; retry is the caller's responsibility
- Persistent op history — in-memory only; lost on restart
- Browser rendering of op state — `ws-relay.js` relays `config_op` events to the browser
- Browser channel form/PSK serialization — tracked separately from this backend contract
- Changes to mesh-gw's channel cache or firmware acknowledgement semantics

## Read-back retry (task `radio-readback-retry`, 2026-07-16)

Some radio config commits are not instantaneous: after a `PUT`, a genuinely
live admin read-back can briefly return the pre-write state. The retry applies
only when the registered read-back endpoint supplies fresh device state.

`_radioRunner` now retries the read-back + compare up to 4 attempts with
1s/2s/3s backoff (~6s budget, inside every Radio op's 15s timeout) and only
throws the last error after all attempts fail. `channel_config` is excluded:
its GET endpoint is cached state and cannot validate the just-completed write.
A genuine mismatch on a fresh read-back still fails, just ~6s later.
