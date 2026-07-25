---
module: ws-relay
source: src/ws-relay.js
source_hash: 8304c6cbe482accce0162733d8d5c7b2d678be3c2f2ef51e6153fa6fc26ec669
updated: 2026-07-25
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
- `pac-host.js` — `connectMessage` (sent on connect + rebroadcast on `events` `change`) — see docs/modules/pac-host.md
- `rotator.js` — `rotator` (events: `status`, `point_target`, `signal_update`)
- `scanner.js` — `scanner` (events: `start`, `progress`, `contact`, `end`)
- `node-list.js` — `nodeList` (event: `change`; fields: `nodes`, `ownDeviceNodes`, `homePos`, `_cache`)
- `dash-mode.js` — `dashMode` (event: `change`; field: `value`); `isListenerForMode`, `isTransmitterForMode` (per-radio role for the current mode)
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
export function getChannelNameByMac(mac, index)        // → channel name | null
export function attachWsRelay(server, getRangeTimer?)  // → WebSocketServer (main wss)
```

### `getChannelNameByMac(mac, index)`

Resolves the **logical channel name** for a stored message's `(device, channel)`
pair. The stored `channel` is the **per-gateway channel INDEX** (both tx and rx —
the receiving radio resolves the on-air hash to *its own* local index before the gw
sees it; proven on live data — see task `channel-identity-table`). The same number
is a different channel on different radios (e.g. `(OMNI,1)=mqtt` but
`(YAGI,1)=Private`), so resolution **must** be per-device.

Reads the already-maintained `lastDeviceChannels[MAC.toUpperCase()]` cache (populated
by `refreshDeviceChannels` on device READY). Returns the configured `name` for the
slot; for an unnamed `PRIMARY`-role slot returns `'Primary'` (its identity by role);
otherwise `null` (unknown gateway, slot not cached yet, or unnamed secondary). No
network call — pure read of the in-memory cache.

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

### Tilt ingest — PRIVATE_APP (task `tilt-ingest-v2`, 2026-07-03)

Tilt sensor data from the RAK4631. TWO event shapes are accepted:

- **V2 (live)**: raw `packet` event with `decoded.portnum === 'PRIVATE_APP'`
  (string) and base64 `decoded.payload`. Handled WITHOUT consuming the
  event — the raw packet still falls through to the browser packet log.
  Both radios deliver the same broadcast, so decoding is deduped per
  `packet.id` (`_seenTiltPktIds`, capped at 500). The firmware ALSO emits
  each reading twice under different packet ids (BLE sendToPhone copy +
  LoRa broadcast), so `_handleTiltPayload` additionally drops identical
  payloads per device within 10 s (`_lastTiltPayload`).
- **V1 legacy**: typed `private_app` event with numeric `portnum === 256`
  and `ev.payload_b64` (returns after handling). Kept for replay compat.
  Gating on ONLY this shape is what killed ingest 2026-06-30 → 07-03.

The struct is version-detected by payload length in `_handleTiltPayload`:

**20 bytes — legacy float32×5** (current firmware): `[roll, pitch, x_g,
y_g, z_g]` little-endian float32. Stored with `version: 0` and all
TiltSummaryV2-only columns null; `tilt_update.data` = `{ roll, pitch,
x, y, z, version: 0 }`.

**24 bytes — TiltSummaryV2**: values are displacement from boot baseline —
stationary readings near 0°.

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

All centidegree fields are divided by 100 before storage and broadcast. `roll`/`pitch` names are kept for backwards compatibility with `alerts.js` and the browser. No flags field. `insertTilt` is called to persist all fields. A `tilt_update` event carrying `{ roll, pitch, version, sample_count, window_ms, avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch, max_delta, rms_motion }` is sent to `handleAlertEvent` and broadcast. Payloads that are neither 20 nor 24 bytes are silently ignored.

**Interim identity decision** (until the `identity-ssot` migration): the
tilt row key and `tilt_update.device` use `ev.node_id ?? ev.addr` —
node_id-preferred — because the browser's tilt-append gate compares
against `activeNodeId` (`!hex`) and `_tiltHistoryAll` is sliced by the
same value. The `tilt_history.node_id` column actually holding a device
key is audited violation #4; re-keying it to MAC happens in the identity
migration, not here.

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
| `node_list` | Each node gets `display_name: resolveNodeLabel(n.num)`, `via` bundle, and the hops-away display fields `hops_verified` + `hops_display` (see "hops-display") |
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

Each broadcast `rotator 'status'` frame is augmented with the switchable
target metadata — `{ ...data, targets: rotator.targets, active_target:
rotator.activeTarget }` — so the browser renders a data-driven v4/v5 selector
without a REST GET (transport rule). `variant` already rides the normalized
`rotator.status`. `active_target` on every frame means the UI reflects a
`POST /rotator/active` switch within one throttle window; `targets` also rides
the on-connect `{_mode}` frame so the selector renders even when the rotator
is offline.

**Rotator device schema (task rotator-device-schema-backend).** The v5 config
`schema` (`rotator.schema`) rides the on-connect `{_mode,…}` frame, and a
`rotator.on('schema')` handler broadcasts `{type:'rotator', data:{schema}}`
whenever the device (re)sends it — so the browser builds its rotator config
form from the device's own field list via the shared `buildForm`. Not added to
the per-status throttled frame (it changes only on connect/device-switch).

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
4. `rotator` with `{ _mode: dashMode.value, targets, active_target, schema }`
   (`schema` = `rotator.schema`, the v5 device config schema or null)
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

## Phase C1 — traceroute history over WS

The on-connect `traceroute_history` replay (limit 500, includes `status`
and row `id`) carries `failure_epoch` (config `perf.failure_epoch`) and is
the SOLE browser transport for perf history. `traceroute.on('cancel')`
broadcasts `{ type: 'traceroute_failed', row }` when the event carries the
recorded failure row.

## Phase C2 — device_list carries settings + radio config

Each device in `device_list` carries `cfg` (its node-dash settings from the
MAC-keyed store) and `lora` (radio lora config, fetched from the gw by MAC
whenever the device reaches READY — including post-reboot after config
writes — and cached in `lastDeviceLora`). `pokeDeviceList()` (module
export, closure-assigned) lets device-config rebroadcast after a settings
PUT. The browser reads ALL device page-data from this event; no GETs.

## settings-via-ws additions

- `settings` event: `{ type, config }` over all config-api DEFAULTS keys —
  replayed on connect, re-broadcast via the `broadcastSettings()` hook
  after every config write. Sole transport for page-state settings.
- `device_list` devices additionally carry `auto_purge`
  (`getAutoPurgeCfg(node_id ?? addr)` — legacy keys are browser-written,
  node_id-first); auto-purge saves poke the list.

## mode_role on device_list (task `mode-roles-expose-backend`)

Each device in `device_list` carries `mode_role: { rx, tx } | null` — the
radio's listener/transmitter role for the **current** mode, computed via
`isListenerForMode(dashMode.value, d.addr)` / `isTransmitterForMode(...)`. The
browser renders RX/TX badges straight from this and makes no decision
(BROWSER_CONTRACT). Because it is mode-dependent, `dashMode.on('change')` now
also calls `broadcastDeviceList()` so badges flip live on a mode switch; a
`PUT /config/modes` refresh comes via `pokeDeviceList()`. `null` when the
device has no `addr`.
- First client→server RPC: `ws.on('message')` handles
  `{ type: 'geocode', num }` → `lookupGeocode(num)` →
  `{ type: 'geocode_result', num, address }`. The Nominatim 1.1 s queue
  lives in geocode.js regardless of caller.

## radar-list-via

`node_list` rows carry a `via` bundle `{ num, node_id, short_name }` —
the first hop of the node's last traceroute (route[0]; broadcast sentinel
excluded), resolved server-side per IDENTITY.md §3. Null when direct or
no traceroute exists.

## hops-display (task `hops-display-backend-enrich`, 2026-07-08)

The **backend owns the hops-away display decision** — the browser is a
presentation layer and makes none (BROWSER_CONTRACT). `enrichEvent` adds two
fields to every `node_list` row, alongside `via`:

- **`hops_verified`** — `number | null`. The traceroute-verified relay count,
  `n.last_traceroute.route.length` (0 = direct, i.e. reached with no relay;
  1 = via one node; …). `null` when the node has no traceroute record.
- **`hops_display`** — `number | null`. The value the UI shows:
  **verified takes priority over reported** —
  `hops_verified ?? (n.hops_away ?? n.hops)`. So a traceroute result (incl. a
  verified direct `0`) wins; otherwise it falls back to the reported live
  packet hops (`node-list.js` guarded `hopsAway`, see that module). `null`
  when neither source is known.

- **`hops_fresh`** — `boolean`. True when the node is verified
  (`hops_verified != null`) **and** its traceroute is still within the passive
  auto-tracer's staleness window: `Date.now() - last_traceroute.ts <=
  (pasv_config.stale_sec ?? 1800) * 1000` (`ts` in ms). So `hops_fresh:false`
  on a verified node means "old enough that the auto-tracer would re-trace it".
  The UI renders the verified marker **green when fresh, amber when stale**;
  the age/threshold decision is made here, not in the browser.

The browser renders `hops_display` and styles it as verified when
`hops_verified != null` (green dot = `hops_fresh`, amber dot = stale) — no
source selection, age comparison, or fallback logic in the UI.

This reverses the earlier `tab-radar` invariant that forbade traceroute-derived
hops: with reliable traceroute data we prefer it. The backend `max_hops`
filter (`node-filter.js`) still keys off reported live hops — a deliberate
split (proximity filter vs. displayed distance).

## Device removal + ghost guard (task `device-remove-op`, 2026-07-16)

`lastDeviceState` was add-only: no code path ever deleted an entry, so a
device removed at the gw was re-broadcast in every `device_list` until
restart, and stray `device_state`/`device_data` events for unknown keys
created skeleton `{ addr }` entries — ghost devices with no name and no data.

- `pruneDevice(mac, nodeId?)` exported (closure-holder pattern, like
  `pokeDeviceList`): drops every `lastDeviceState` entry matching the MAC
  (case-insensitive) or the node_id (catches historic node_id-keyed
  duplicates), deletes `lastDeviceLora[MAC]` and the `_liveNodeIds` entry,
  then rebroadcasts `device_list`. Called by `device-remove.js`.
- Ghost guard in the STATE_EVENT_TYPES block: `evAddr` now resolves
  `ev.device` (a node_id) to its MAC via `getLiveMacByNodeId` before falling
  back, and only a MAC-shaped key may CREATE a new entry — events for
  unknown non-MAC keys are dropped instead of becoming ghost rows. Known
  keys update exactly as before; OFFLINE devices stay visible.

## Sent-message rebroadcast (task `message-tx-broadcast`, 2026-07-17)

A gateway radio never receives its own transmission, so a dash-sent message
generated no event: only the sending session (optimistic entry) ever saw it,
and every other connected browser was blind to it until a reload's
`message_history` replay. Peter-reported as "the feed only shows received
messages".

- The on-connect history block's enriched-rows construction is extracted to
  `buildMessageHistoryEvent()` (inside `attachWsRelay`): `_enrichMessages`
  over `queryMessages(HISTORY_DEPTH)` with `display_name` resolution,
  returning the `{type:'message_history', messages}` event.
- New module-level export `broadcastMessageHistory()` (closure-holder
  pattern, like `pokeDeviceList`): broadcasts a fresh
  `message_history` to ALL clients. Called by `messages-api` after
  persisting a sent message — the browser's wholesale
  `_applyMessageRows` replace makes delivery idempotent and threading
  authoritative (BROWSER_CONTRACT: order/threads precomputed here).
- `HISTORY_DEPTH` = 200 (was 50): with chatty bots the feed window churned
  in hours and sent messages vanished from view quickly.

## Device channels on the device_list (task `device-channels-on-list`, 2026-07-17)

The send form needs each radio's configured channels by NAME, and the
browser may hold zero gw knowledge — so channels ride the `device_list`
like `cfg`/`lora`/`auto_purge` (C2: page data is WS-only).

- `lastDeviceChannels` cache (MAC-keyed), mirror of `lastDeviceLora`:
  `refreshDeviceChannels(addr)` fetches the gw bulk `/{addr}/channels` on
  every READY transition (device_snapshot seed + live `device_state`), maps
  entries to `{index, name, role}` and keeps only `PRIMARY`/`SECONDARY`
  roles (disabled slots are omitted — that IS the "configured" set), then
  rebroadcasts the device list.
- `device_list` entries gain `channels: [{index, name, role}] | null`
  (null until first READY fetch).
- Known limitation: a channel edit refreshes the cache on the next READY
  transition, not instantly; role changes reboot the radio, so the common
  case self-refreshes.

## node_status RPC + live push (NODE_STATUS_RPC_SPEC)

Client→server RPC beside the geocode handler:

```js
{ type: 'node_status', num }
→ { type: 'node_status', num, found, header, sections: [...] }
```

Works for **any** node in the mesh, not a designated subset. `ws-relay` does no
composition — it calls `buildNodeStatus(num)` from `node-status.js` and sends the
result. A build failure is caught and answered as `{found:false, sections:[]}`
rather than dropping the client's request on the floor.

### `node_status_update` — hint only

On any bridge event carrying a node num (`ev.from_num`, else
`ev.data.packet.from`), the relay broadcasts:

```js
{ type: 'node_status_update', num }
```

**It carries only `num` — never a value.** The browser re-requests the RPC, so
there is exactly one code path producing displayed values and no chance of a
pushed value disagreeing with a fetched one.

Deliberately **format-blind and port-blind**: the hint does not inspect what
changed, so a new port, `type` or field never requires a change here.

Throttled per node to 1 hint/second (`_lastStatusHint`, capped at 2 000 entries)
so a burst of packets cannot storm connected browsers. The throttle is a
delivery concern, not a data decision — no datum is lost, since the browser
always re-reads current state.

### Focused-node header clock (`fix-node-status-live-refresh`)

`header.last_heard.ago` is server-formatted display text. A quiet node emits no
ingest event, so `node_status_update` does not fire and the text otherwise
freezes until reload even though the `/events` socket remains healthy.

After each successful `node_status` reply, the main `/events` connection retains
only that reply's focused `num`, `header.last_heard.raw`, and last emitted
`ago`. A one-second server timer recomputes `ago` with `format.js::fmtAgo`.
When the resulting string changes, it sends:

```js
{ type: 'node_status_age', num, raw, ago }
```

The browser applies this server-formatted string only when `num` and `raw`
still match the displayed node/header. The raw timestamp guard prevents a
delayed clock frame from overwriting a newer full `node_status` reply.

The timer:

- starts lazily after a successful reply containing `header.last_heard`;
- keeps no history rows and never calls `buildNodeStatus`;
- emits nothing while the formatted string is unchanged;
- replaces its retained state when the focused node changes;
- is cleared and discarded on WebSocket close.

This is deliberately a small clock event rather than a periodic full status
reply: histories and charts are not requeried or redrawn merely because a
relative-age string changed.

## Implementation scope (`fix-node-status-live-refresh`)

| File | Before | After |
|---|---|---|
| `src/ws-relay.js` | `node_status` replies are remembered nowhere; no server clock exists | retain the successful reply's last-heard state per main WS client; emit guarded `node_status_age` changes; clear timer on close |
| `public/app-ws.js` | dispatches `node_status` and `node_status_update` only | dispatch `node_status_age` to the node-status mixin |
| `public/app-node-status.js` | can replace only the complete status payload | add `applyNodeStatusAge(msg)` that replaces only server-formatted `ago` after tab, node and raw-timestamp guards |
| `docs/modules/ws-relay.md` | ingest-only freshness contract | specify the server-owned focused-node header clock |
| `docs/modules/app-ws.md` | no age-event dispatch contract | record `node_status_age` dispatch |
| `docs/modules/app-node-status.md` | explicitly says no liveness tick | record guarded application of server-generated age text |

Adjacent files explicitly not changed:

- `src/node-status.js`: its full payload builder and the user's current
  uncommitted chart/header work remain untouched.
- `public/partials/tab-node.html`: it already binds
  `nodeStatus.header.last_heard.ago` verbatim.
- `docs/BROWSER_CONTRACT.md`: the design complies without an exception; the
  browser formats nothing and page data remains WebSocket-only.
- `src/index.js`: no HTTP route or GET is added.
