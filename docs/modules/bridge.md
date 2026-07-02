---
module: bridge
source: src/bridge.js
source_hash: b52c0d8748e50aa53624dc2bd4be791a7de0201335ef9f13f2de59650a3c0b8d
updated: 2026-06-30
---

# Module: bridge

## Purpose

Sole network client for the mesh-gw gateway. Owns the WebSocket connection to the gw
event stream and all REST HTTP calls to the gw API. No other module may open a network
connection to the gw directly.

This module does not implement business logic, storage, or browser concerns. It connects,
parses, emits, and forwards — nothing more.

## Responsibilities

- Open and maintain the WebSocket connection to `${BRIDGE_WS_URL}/events`
- Reconnect automatically on close (5 s delay)
- Validate the `hello` handshake on every connection before passing any other event downstream
- Maintain the `known_devices` cache: `__ble_addr → { node_id, short_name, long_name, hw_model }` — populated from `device_data` events; seeded from `device_snapshot` on connect
- Parse every inbound WS message as JSON; emit typed events to internal consumers
- Expose REST helpers (`get`, `post`, `put`, `delete`) for all gw HTTP calls
- Strip `__`-prefixed fields from all outbound REST and WS request bodies before they reach the gw

## Dependencies

- `ws` — WebSocket client
- `node:events` — EventEmitter base
- Environment: `BRIDGE_URL`, `BRIDGE_WS_URL`

## Public interface

```js
// Singleton
export const bridge = new BridgeClient();

// Lifecycle
bridge.start()                          // begin connection loop
bridge.stop()                           // terminate WS, cancel reconnect timer

// State
bridge.connected                        // boolean — true when WS is open and hello validated
bridge.apiVersion                       // string|null — e.g. "2.0"; null until hello received
bridge.knownDevices                     // Map<string, DeviceInfo> — __ble_addr → device metadata

// REST helpers — all throw on non-2xx; caller catches
bridge.get(path)                        // → Promise<any>
bridge.post(path, body)                 // → Promise<any>
bridge.put(path, body)                  // → Promise<any>
bridge.delete(path)                     // → Promise<any>

// Events (EventEmitter)
bridge.on('connected', () => {})        // WS open AND hello validated
bridge.on('disconnected', () => {})     // WS closed
bridge.on('version_error', (v) => {})  // hello received but api_version major ≠ "2"
bridge.on('event', (ev) => {})         // every inbound event (post-hello)
bridge.on(ev.type, (ev) => {})         // re-emitted by type, e.g. 'device_state', 'text'
```

`DeviceInfo` shape:
```js
{
  node_id:    string | null,   // e.g. "!3f172791"
  short_name: string | null,
  long_name:  string | null,
  hw_model:   string | null,
}
```

## State

| Field | Type | Description |
|---|---|---|
| `_ws` | WebSocket\|null | Active WS connection |
| `_reconnectTimer` | Timer\|null | Pending reconnect handle |
| `_connected` | boolean | True when WS open AND hello validated |
| `_apiVersion` | string\|null | Set from `hello.api_version`; null until received |
| `_knownDevices` | Map | `__ble_addr → DeviceInfo` |
| `_helloReceived` | boolean | Guards against processing events before hello |

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'connected'` | — | WS open and `hello` validated successfully |
| `'disconnected'` | — | WS close (any reason) |
| `'version_error'` | `{ api_version }` | `hello` received with major version ≠ `"2"` |
| `'event'` | event object | Every inbound gw event after hello |
| `ev.type` | event object | Re-emit of every event by its `type` field |

`hello` and events received before `hello` are **not** re-emitted as `'event'`.

## Invariants

- `bridge` is the only module that opens any network connection to the gw. No other module may call `fetch()` or open a WebSocket to `BRIDGE_URL` / `BRIDGE_WS_URL` directly.
- The first message on every WS connection must be `hello`. Any other message type arriving first is discarded and logged as a protocol error.
- If `hello.api_version` major ≠ `"2"`, emit `'version_error'` and stop processing the stream. Do not emit `'connected'`. Reconnect applies normally so recovery is automatic if gw upgrades.
- `bridge.connected` is `false` until `hello` is validated — not just until the socket opens.
- `known_devices` is the authoritative source of `__ble_addr → DeviceInfo`. Consumers must not maintain their own MAC-to-identity maps.
- All outbound REST bodies and inbound-echoed fields with `__` prefix are stripped before the request leaves node-dash. This prevents gateway metadata from corrupting radio payloads.
- Every event emitted to consumers carries `__ble_addr` as the primary device key. Consumers must not key on `addr` or `device` as primary identifiers.

## Test notes

Tests for this module target the gw contract (Phase 1). They do not require a live gw —
a mock WS server is sufficient.

- **v2 handshake happy path**: connect to mock WS → server sends `hello` with `api_version: "2.0"` → `bridge.connected` becomes true → `'connected'` event fires → subsequent events are re-emitted
- **hello validation — wrong major**: server sends `{"type":"hello","api_version":"3.0"}` → `'version_error'` fires → `bridge.connected` stays false → `'connected'` never fires
- **hello missing**: server sends a non-hello event first → event is discarded → `bridge.connected` stays false
- **known_devices seeding**: `device_snapshot` arrives → `known_devices` populated per entry from `data_event` → `bridge.knownDevices.get('AA:BB:CC:DD:EE:FF')` returns correct `DeviceInfo`
- **known_devices update**: `device_data` event arrives → `known_devices` entry updated
- **`__ble_addr` on every event**: after hello, every emitted event has `__ble_addr` set
- **REST helpers**: `get`, `post`, `put`, `delete` reach the correct gw URL with correct method and body; non-2xx throws
- **`__` stripping**: `post()` with a body containing `__ble_addr` → gw receives body without the `__ble_addr` field
- **reconnect**: WS closes → reconnect fires after 5 s → `_connected` is false during gap → reconnects and re-validates hello
- **`bridge.stop()`**: cancels reconnect timer, terminates WS, does not reconnect

## Out of scope

- Business logic — what to do with events belongs in callers (`persist.js`, `node-list.js`, `traceroute.js`, etc.)
- Storage — no SQLite access
- Browser concerns — no knowledge of `ws-relay.js` or the browser WS
- The `_liveNodeIds` map in `ws-relay.js` — this is a stale v1 artifact that duplicates `known_devices`; it will be removed in the ws-relay refactor task once `bridge.knownDevices` is authoritative
- Routing gw events to specific consumers — that belongs in `event-handler.js` (to be extracted from `index.js`)

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

BLE state log line labels devices by `node_id`/`addr` (V2 removed `device`).
