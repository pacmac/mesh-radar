---
module: ws-relay
source: src/ws-relay.js
source_hash: fc6add069b7614a8bc6f69b96fd837510d2201fc882a9f8c00b4d9486307e06f
updated: 2026-06-30
---

# Module: ws-relay

## Purpose

WebSocket relay layer between the backend and browser. Translates bridge/rotator/scanner
events into browser-friendly WS messages, persists tilt and environment telemetry on
the way through, deduplicates live packet events, and replays the full current state
to every newly connected client so the browser is immediately consistent.

## Responsibilities

- Maintain two WebSocket servers: one global (`/events`) and one per-device (`/!{nodeId}/events`)
- Cache last-known BLE device state so new connections receive the current picture without HTTP calls
- Maintain `_liveNodeIds` (BLE MAC → `!hexid`) for use by callers requiring authoritative node IDs
- Translate raw bridge events into browser event types (OTA, tilt, telemetry, range test)
- Persist tilt readings and environment metrics inline as events arrive
- Deduplicate live `TEXT_MESSAGE_APP` events by `packet_id` per bridge session
- Enrich outbound events with pre-resolved display labels
- Enrich message history with threading metadata (direction, thread root, reply depth)
- Emit `radar_context` events when `FF.SSOT_ROUTE_RENDER` is enabled
- Feed bridge events into `alerts.js`
- Route HTTP upgrade requests to the correct WebSocket server

## Dependencies

- `ws` — `WebSocketServer`
- `bridge.js` — `bridge` (events: `connected`, `disconnected`, `event`)
- `rotator.js` — `rotator` (events: `status`, `point_target`, `signal_update`)
- `scanner.js` — `scanner` (events: `start`, `progress`, `contact`, `end`)
- `node-list.js` — `nodeList` (event: `change`; fields: `nodes`, `ownDeviceNodes`, `homePos`, `_cache`)
- `dash-mode.js` — `dashMode` (event: `change`; field: `value`)
- `passive-tracer.js` — `passiveTracer` (events: `tracing`, `traced`)
- `traceroute.js` — `traceroute` (events: `start`, `result`, `cancel`)
- `feature-flags.js` — `FF.SSOT_TRACEROUTE`, `FF.SSOT_ROUTE_RENDER`
- `db.js` — `insertTilt`, `insertEnvHistory`, `getTiltCal`, `queryRangeTestLog`, `queryAllTiltHistory`, `queryAllEnvHistory`, `stmts.queryTracerouteHistory`, `stmts.updateMessageStatus`, `persistNodeMac`, `loadNodeMacMap`
- `filters.js` — `queryMessages`
- `alerts.js` — `handleAlertEvent`
- `node-label.js` — `resolveNodeLabel`, `resolveDeviceLabel`
- `device-config.js` — `ensureDeviceCfgMac`

## Exports

```js
export function getLiveNodeIdByMac(mac)     // → !hexid | null
export function getLiveMacByNodeId(nodeId)  // → MAC | null
export function attachWsRelay(server, getRangeTimer?)  // → WebSocketServer (main wss)
```

### `getLiveNodeIdByMac(mac)`

Looks up `mac.toUpperCase()` in the module-level `_liveNodeIds` Map. Returns `null` if not found or if `mac` is falsy.

### `getLiveMacByNodeId(nodeId)`

Linear scan of `_liveNodeIds` for the first entry whose value equals `nodeId`. Returns the MAC or `null`.

### `attachWsRelay(server, getRangeTimer)`

Wires event handlers and returns the main `wss` instance. Must be called once at startup with the HTTP server. `getRangeTimer` is a function returning `{ active, endsAt, nodeId }` — defaults to a stub returning `{ active: false }`.

---

## Module-level state (initialised at import)

### `_liveNodeIds` — `Map<MAC, !hexid>`

Tracks the authoritative node ID for each live BLE radio. Seeded from `loadNodeMacMap()` at module load so `getLiveNodeIdByMac` / `getLiveMacByNodeId` work correctly on a cold start before any WS events arrive.

Updated by:
- `device_snapshot` events: `_liveNodeIds.set(addr.toUpperCase(), flat.node_id)` + `persistNodeMac`
- `device_data` events: `_liveNodeIds.set(evAddr.toUpperCase(), ev.node_id)` + `persistNodeMac`

### `_seenLivePktIds` — `Set<packet_id>`

Session-level deduplication set for live `TEXT_MESSAGE_APP` packet events. Cleared on `bridge_connected` so a reconnect starts fresh. Also accepts packet IDs from `message_status` (`queued`/`sent`) to deduplicate messages the gateway itself sent.

### `_ownNums()` — helper

Derives gateway node numbers (uint32) from `_liveNodeIds` values. Used by `_enrichMessages` to classify messages as `tx` (from a gateway node) or `rx`.

---

## Event routing — `bridge.on('event', ...)`

### `device_snapshot`

Received once after bridge connects, carrying the full device list. For each device:
1. `ensureDeviceCfgMac(addr, node_id)` — migrate or bootstrap device config
2. Flatten `state_event` and `data_event` onto the device object; set `ble_state = state.toLowerCase()`
3. Store in `lastDeviceState[addr]`
4. If `node_id` present: update `_liveNodeIds`, call `persistNodeMac`
5. `broadcastDeviceList()` — compose from `lastDeviceState` and broadcast

### `device_state`

Updates `lastDeviceState[ev.addr]` with the new state and `ble_state`. Triggers OTA event translation (see below). Calls `broadcastDeviceList()`.

`ensureDeviceCfgMac(ev.addr, ev.node_id)` is called to handle MAC → config association.

**OTA state translations** (when `ev.node_id || ev.addr` is present):

| Bridge state | Browser event |
|---|---|
| `OTA_PENDING`, `OTA_HANDSHAKE` | `ota_start` |
| `OTA_FLASHING` | `ota_progress` with `pct`, `status: 'flashing'` |
| `OTA_COMPLETE` | `ota_complete` |
| `OTA_SERIAL_WAIT` | `ota_progress` with `status: 'nvs_erase_waiting'`, `deadline` |
| `OTA_SERIAL_ERASING` | `ota_progress` with `status: 'nvs_erasing'` |
| `OTA_ERROR`, `OTA_BOOTLOADER_STUCK`, `OTA_NVS_MISMATCH` | `ota_error` with `error` message |

### `device_data`

Updates `lastDeviceState[evAddr]` with `data_event`. Updates `_liveNodeIds` if `ev.node_id` present. Calls `broadcastDeviceList()`.

### `private_app` (portnum 256)

Tilt sensor data — `TiltSummaryV2` struct, sent via BLE FromRadio `sendToPhone()` from the RAK4631. NOT transmitted over LoRa; `transport_mechanism` and `hop_start` will be null. Decodes `ev.payload_b64` as a 24-byte packed little-endian binary. Values are displacement from boot baseline — stationary readings near 0°.

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | uint8 | version | Always 2 |
| 1 | uint8 | sample_count | Number of samples in window |
| 2 | uint16LE | window_ms | Sampling window duration (ms) |
| 4 | int16LE | current_axis_a_cd | centidegrees → `/100` = `roll` (°) |
| 6 | int16LE | current_axis_b_cd | centidegrees → `/100` = `pitch` (°) |
| 8 | int16LE | average_axis_a_cd | → `avg_roll` |
| 10 | int16LE | average_axis_b_cd | → `avg_pitch` |
| 12 | int16LE | min_axis_a_cd | → `min_roll` |
| 14 | int16LE | max_axis_a_cd | → `max_roll` |
| 16 | int16LE | min_axis_b_cd | → `min_pitch` |
| 18 | int16LE | max_axis_b_cd | → `max_pitch` |
| 20 | uint16LE | max_delta_cd | → `max_delta` |
| 22 | uint16LE | rms_motion_cd | → `rms_motion` |

All centidegree fields are divided by 100 before storage and broadcast. `roll`/`pitch` names are kept for backwards compatibility with `alerts.js` and the browser. No flags field. `insertTilt` is called to persist all fields. A `tilt_update` event carrying `{ roll, pitch, version, sample_count, window_ms, avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch, max_delta, rms_motion }` is sent to `handleAlertEvent` and broadcast. Packets not exactly 24 bytes are silently ignored.

### `telemetry`

- `environment_metrics` (temperature or humidity present): `insertEnvHistory` → broadcast `{ type: 'telemetry_update', variant: 'environment_metrics', data: em }`
- `device_metrics`: broadcast `{ type: 'telemetry_update', variant: 'device_metrics', data: dm }`

### `rangetest`

Extracts numeric sequence from `ev.data.text` (strips non-digits). Broadcasts `{ type: 'range_test_entry', device, data: { ts, from_num, rssi, snr, hops, seq, via_mqtt } }`.

### `user`, `position`, `admin`, `node_update`

Silently dropped — handled server-side by `persist.js` and `node-list.js`. No browser event emitted.

### `message_status`

Calls `stmts.updateMessageStatus.run(...)` to update the DB. Adds packet ID to `_seenLivePktIds` if status is `queued` or `sent`. Broadcasts the event as-is.

### `packet` (TEXT_MESSAGE_APP live dedup)

Before broadcasting, checks `_seenLivePktIds` for the packet ID. If already seen, drops the event. Otherwise records the ID and continues to `handleAlertEvent` + broadcast.

This ensures the browser receives exactly one event per logical message regardless of how many gateway radios heard it. The second reception is still persisted to SQLite (by `persist.js`) and visible in the next `message_history` replay.

### All other events

Passed to `handleAlertEvent(ev)` and then broadcast as-is.

---

## Event enrichment

### `enrichEvent(ev)` — applied to every outbound message

| Event type | Enrichment added |
|---|---|
| `node_list` | Each node gets `display_name: resolveNodeLabel(n.num)` |
| `device_list` | Each device gets `display_name: resolveDeviceLabel(d.node_id)` |
| `range_test_entry` | `from_name: resolveNodeLabel(ev.data.from_num)`, `rx_name: resolveDeviceLabel(ev.device)` |
| `text_message` | `from_name: resolveNodeLabel(ev.data.from_num)` |
| All others | Passed through unchanged |

### `_enrichMessages(rows)` — applied to `message_history` on-connect

Adds threading metadata to each message row before sending to a new client:

- `direction`: `'tx'` if `from_num` is a gateway node (in `_ownNums()`), else `'rx'`
- `thread_root_packet_id`: walks the `reply_id` chain to the root; cycle-safe via `visited` Set and `rootCache` Map
- `is_orphan`: `true` if `reply_id` is set but the referenced message is not in the row set
- `reply_depth`: count of hops back to the thread root

Sort order: threads newest-first (by the latest `ts` in the thread); replies within a thread oldest-first immediately after their root.

---

## Rotator throttle — `makeRotatorThrottle(sendFn)`

Rate-limits `rotator 'status'` events per client to avoid flooding during antenna movement:
- If `busy`, `stall`, or `dir` changed → send immediately
- If 100 ms elapsed and `busy=true` → send
- If 1000 ms elapsed and `busy=false` → send
- Otherwise skip

One throttle instance is created per client connection and per rotator listener.

---

## Feature flags

### `FF.SSOT_TRACEROUTE` (default false)

- `false`: `passiveTracer.on('traced')` → `route_discovered` (legacy path)
- `true`: `traceroute.on('result')` → `route_discovered` (SSOT path — all traceroutes, not just PASV)

### `FF.SSOT_ROUTE_RENDER` (default true)

When enabled, the backend maintains `radar_context` state and broadcasts it whenever relevant state changes. The browser uses this pre-computed context rather than deriving it locally.

**`radar_context` event payload:**

```js
{
  type: 'radar_context',
  mode: 0|1|2,               // current dash mode
  traceroute_node: num|null,  // node to show crosshairs on
  traceroute_active: bool,    // traceroute in flight (animate route)
  target_arm_az: deg|null,    // target azimuth (ACTV/SCAN only; null in PASV)
  active_card: {              // card above radar (or null)
    mode: 'actv'|'pasv',
    node_num, label,
    border, accent, nameclr, divider,  // rgba colour strings
  }|null,
}
```

Mode rules:
- **ACTV (1)**: crosshairs on `lastPointTarget.point_target`; card shown while target set; `traceroute_active` while dispatch in flight
- **PASV (0)**: crosshairs on last traced node (`_rcTracerouteNode`); card shown during active passive trace (`_rcPassiveTracingNode`); both cleared on `traceroute.result`
- **SCAN (2)**: crosshairs on last traced node; no card; `_rcPassiveTracingNode` cleared on mode change

Triggers: `traceroute.start/result/cancel`, `passiveTracer.tracing`, `rotator.point_target`, `dashMode.change`, `scanner.contact`.

---

## WebSocket servers

### Main — `wss` — path `/events`

Global dashboard view. Broadcasts all events.

**On-connect replay sequence (in order):**

1. Bridge connection state (`bridge_connected` or `bridge_disconnected`)
2. Last-known device state for each BLE device (individual flattened objects from `lastDeviceState`)
3. `device_list` (from `lastDeviceList` cache, or freshly composed)
4. `rotator` with `{ _mode: dashMode.value }`
5. Rotator full status (if connected and non-empty)
6. `rotator` with `lastPointTarget` (if any)
7. `signal_update` with `lastSignalUpdate` (if any)
8. `radar_context` (if `FF.SSOT_ROUTE_RENDER`)
9. `scan_start` with `{ resumed: true, az, dwell_az, contacts }` (if scan active)
10. `node_list` (enriched)
11. `known_nodes` — all named nodes from `nodeList._cache` with `display_name`
12. `tilt_cal`
13. `message_history` — last 50, enriched via `_enrichMessages` + `display_name`
14. `tilt_history` — last 24 hours
15. `env_history` — last 7 days
16. `range_test_log` — last 500 entries with `from_name`/`rx_name`
17. `range_test_timer` — current timer state
18. `traceroute_history` — last 200, with `route`/`route_back`/`snr_towards`/`snr_back`/`relay_positions` parsed from JSON strings

If any history query throws (steps 13–18), the error is logged and remaining history is skipped.

### Per-device — `wssDevice` — path `/!{nodeId}/events`

Scoped to one gateway radio. Replays: device state, dash mode, rotator status, `lastPointTarget`, `lastSignalUpdate`, `radar_context`, scan state (if active), and `node_list`. Message history, tilt/env history, range test log, and traceroute history are NOT replayed.

Live event filter: `evAddr = ev.addr || ev.__ble_addr || ev.device`. An event passes if `evAddr === addr` OR `ev.node_id === nodeId` OR `ev.type?.startsWith('ota_')`.

`__ble_addr` is included in the fallback chain because V2 gw `ota_download_*` events carry only `__ble_addr` — no `addr`, no `device`. Without this fallback `evAddr` is null and `!evAddr` is true, causing all OTA download events to be sent to every device WS client. With the fallback, `evAddr === addr` routes each event to the correct device only.

The `startsWith('ota_')` catch-all is retained for `ota_start`/`ota_progress`/`ota_complete`/`ota_error` events synthesised by ws-relay.js from `device_state` FSM transitions (those always carry `addr`).

All event listeners are attached per connection and removed on `close` — no leaks.

---

## HTTP upgrade router

```
server.on('upgrade', (req) => {
  /!{hexid}/events  → wssDevice (attachDeviceClient)
  /events           → wss
  anything else     → HTTP 404 + socket.destroy()
})
```

Exactly one WSS handles each upgrade request.

---

## `lastDeviceState` cache

Object keyed by BLE MAC address. Each entry is the flattened device shape from `device_snapshot` or the merged result of `device_state`/`device_data` updates. Always contains `ble_state` (lowercase). Replayed to new connections — no HTTP round-trips after startup.

---

## Invariants

- `_liveNodeIds` is seeded at module load from `loadNodeMacMap()` so MAC-to-nodeId resolution works before any WS events arrive.
- `_seenLivePktIds` grows unboundedly during a session but is bounded by the number of unique packet IDs received. It is cleared on `bridge_connected`.
- All outbound events pass through `enrichEvent`. No browser event carries a bare node num without an enriched label (for types that define one).
- `_enrichMessages` is only called for the on-connect `message_history` replay. Real-time `packet` events are not threaded — the browser appends and re-sorts.
- `broadcastDeviceList` always composes from `lastDeviceState` in memory — never fetches from bridge. An OFFLINE device remains in the list.
- **Encapsulation leak**: `nodeList._cache` is accessed directly for `known_nodes` (count, filtering, values). Should use a public accessor.
- **Code smell**: `attachDeviceClient` does not replay `known_nodes`, message history, tilt/env history, or range test log. Per-device connections start without those.

## Test notes

- **getLiveNodeIdByMac**: MAC in map → returns `!hexid`; unknown → null; falsy → null
- **device_snapshot**: 2 devices → `lastDeviceState` has 2 entries; `device_list` broadcast; `_liveNodeIds` updated
- **device_state OTA_FLASHING**: `ev.pct = 42` → `ota_progress` with `pct: 42` broadcast
- **private_app portnum=256, 24 bytes**: TiltSummaryV2 decoded; `insertTilt` called; `tilt_update` broadcast + `handleAlertEvent`
- **private_app portnum=256, 23 bytes**: not 24 → ignored
- **telemetry environment**: `insertEnvHistory` called; `telemetry_update` variant `environment_metrics`
- **telemetry device_metrics only**: `insertEnvHistory` NOT called; variant `device_metrics`
- **TEXT_MESSAGE_APP dedup**: same `packet_id` twice → second dropped; first broadcast
- **message_status queued**: ID added to `_seenLivePktIds`; `stmts.updateMessageStatus` called
- **bridge_connected**: `_seenLivePktIds` cleared
- **throttle busy**: 3 status events 20 ms apart → 1st passes (first call), 2nd+3rd suppressed
- **_enrichMessages direction**: `from_num` in `_ownNums()` → `direction: 'tx'`
- **_enrichMessages thread root**: A→B→C chain → A and B root at C
- **_enrichMessages is_orphan**: `reply_id` not in row set → `is_orphan: true`
- **radar_context PASV**: `passiveTracer.tracing` → `active_card.mode = 'pasv'`; `traceroute.result` → card null
- **per-device filter**: event for device B not sent to per-device WS for device A; `ota_start` sent to both
- **per-device filter V2 OTA download**: `ota_download_start` with only `__ble_addr` set → `evAddr = __ble_addr` → routed to matching device only, not broadcast to all

## Out of scope

- Browser rendering — `ws-relay.js` emits events; the browser owns display logic
- Message persistence — `persist.js` owns all writes
- Node cache management — `node-list.js` owns the in-memory node set
- Alert delivery — `alerts.js` owns that; `ws-relay.js` only feeds it events
- REST endpoints — `index.js` owns all HTTP routes

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Consumes the V2 `range_test` event name (was `rangetest` — dead pipeline). Dead `text_message` enrichment branch removed (texts ride `packet` events).
