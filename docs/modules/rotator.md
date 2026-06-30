---
module: rotator
source: src/rotator.js
source_hash: 4abfce502902dc8333b2772f4ef7eafbf297dc00bf41957342f532081dcbaeb7
updated: 2026-06-30
---

# Module: rotator

## Purpose

WebSocket client for the YAGI antenna rotator hardware. Owns the connection,
reconnection, and all commands sent to the rotator. Also used as a shared
event bus by `active-tracker.js` for `point_target` and `signal_update`
events — callers that want rotator state changes listen on this singleton.

## Responsibilities

- Open and maintain a WebSocket connection to the rotator controller (`ROTATOR_WS_URL`)
- Reconnect on close after 5 s delay
- Send periodic pings (5 s interval) to keep the connection alive
- Send `seek2az` commands to move the antenna to a bearing
- Forward arbitrary actions to the rotator via `sendAction`
- Accumulate inbound status messages into `_status` and emit `'status'`

## Dependencies

- `ws` — WebSocket client
- `node:events` — EventEmitter base
- Environment: `ROTATOR_WS_URL` (default: `ws://192.168.10.186:81`)

## Public interface

```js
export const rotator  // singleton RotatorClient

// Lifecycle
rotator.start()                   // initiate WS connection
rotator.stop()                    // terminate WS and all timers; does not reconnect

// Getters
rotator.connected                 // boolean — true when WS is open
rotator.status                    // object — accumulated status (merged from inbound messages)

// Commands (silently no-op when not connected)
rotator.move(az)                  // send { action: 'seek2az', args: [az] }
rotator.sendAction(action, args?) // send { action, args } or { action }
```

## State

| Field | Type | Description |
|---|---|---|
| `_ws` | WebSocket\|null | Active connection |
| `_connected` | boolean | True when WS open |
| `_status` | object | Accumulated rotator status; merged from every inbound message |
| `_reconnectTimer` | Timer\|null | Pending reconnect handle |
| `_pingTimer` | Timer\|null | 5 s keep-alive ping interval |

## Events emitted (by rotator.js itself)

| Event | Payload | When |
|---|---|---|
| `'connected'` | — | WS open |
| `'disconnected'` | — | WS close (any reason); reconnect scheduled |
| `'status'` | inbound message object | Every message received from the rotator |

## Events emitted via `rotator` (by other modules — proxy bus use)

`rotator` is used as a shared event bus. These events are **not** emitted by rotator.js itself — they are emitted by callers via `rotator.emit(...)`.

| Event | Emitted by | Payload | Consumed by |
|---|---|---|---|
| `'point_target'` | `active-tracker.js` | `{ point_target, az, _mode, yagi_* stats }` | `index.js`, `ws-relay.js` |
| `'signal_update'` | `active-tracker.js` | `{ signal_num, rssi, snr, ts }` | `ws-relay.js` |

## Invariants

- `move(az)` and `sendAction(...)` silently no-op when `_connected` is false. Callers must not assume commands are delivered.
- `_status` is an accumulated merge. Each inbound message is spread onto `_status`. Status fields are only ever added or overwritten — never deleted by this module.
- Reconnect is automatic on close. Calling `stop()` cancels the reconnect timer.
- The 5 s ping timer is started on `'open'` and cleared on `'close'`. It is never active while disconnected.
- `'status'` fires for **every** inbound message, including partial updates. Consumers must not assume a `'status'` event contains the full status object.
- **Code smell**: `index.js` attaches `_lastTracedNum` and `_lastTracedAt` directly to the `rotator` instance as ad-hoc state. These fields do not belong to this module and must be moved to `index.js`/`traceroute.js` state in a future refactor.
- **Proxy bus**: the `'point_target'` and `'signal_update'` events are emitted by `active-tracker.js` via `rotator.emit()`, not by this module. This is a design choice (single subscriber surface) but couples `active-tracker.js` to this module's EventEmitter identity.

## Test notes

- **connect**: `rotator.start()` → WS opens → `rotator.connected === true` → `'connected'` fires
- **`move`**: connected → `move(180)` → WS receives `{ action: 'seek2az', args: [180] }`
- **`move` disconnected**: not connected → `move(180)` → no message sent, no error
- **`sendAction`**: `sendAction('setOffset', ['5'])` → WS receives `{ action: 'setOffset', args: ['5'] }`
- **status accumulation**: two inbound messages `{ az: 90 }` then `{ busy: false }` → `status === { az: 90, busy: false }`
- **reconnect**: WS closes → after 5 s → `_connect()` called again; `'disconnected'` fired before retry
- **stop**: `stop()` → `_connected === false` → reconnect timer cleared → WS terminated
- **ping interval**: on connect → `ws.ping()` sent every 5 s; on disconnect → interval cleared

## Out of scope

- Rotator hardware protocol — commands are JSON objects; the hardware interprets them
- Rotation completion detection — callers poll `rotator.status.busy`
- Which azimuth to point at — `active-tracker.js` and `scanner.js` decide that
- Signal tracking — `active-tracker.js` owns `point_target` / `signal_update` semantics
