---
module: persist
source: src/persist.js
source_hash: 97fd5fee5e1a0338798d6179e02a092c78337e4b06ca1b71a28affc1cd38e5ec
updated: 2026-07-18
---

# Module: persist

## Purpose

Routes inbound gw events to SQLite writes. Owns the mapping from gw event type and
packet portnum to the correct db operation. Does not own storage (that is `db.js`),
does not own event delivery (that is `index.js`/`event-handler.js`), and does not
own business logic such as alerting or traceroute lifecycle.

## Responsibilities

- Receive a normalised gw event object and route it to the appropriate db write(s)
- Decode packet payloads by `portnum` and write to `nodes` and/or `nodeinfo`
- Write received text messages to `messages` with correct `message_key` and `_replay` flag
- Write telemetry (device_metrics, environment_metrics) to `nodes` and `environment_history`
- Write node identity (NODEINFO_APP, `user`, `node_info`, `node_update`) to both `nodes` (ephemeral) and `nodeinfo` (permanent)
- Write position updates to `nodes`
- Convert Meshtastic integer coordinates (`latitude_i / 1e7`, `longitude_i / 1e7`) to float degrees
- Call `syncAlertedAt` after writing a text message so pre-alerted packets get their `alerted_at` backfilled

## Dependencies

- `db.js` — `stmts`, `insertEnvHistory`, `syncAlertedAt`, `insertDeviceMetricsHistory`, `insertDetectionEvent`, `upsertNodeAppState`
- No network I/O, no EventEmitter, no timers

## Public interface

```js
export function handleEvent(event)  // → void
```

`event` is the raw object emitted by `bridge` (via index.js). Expected shape:

```js
{
  type:       string,        // gw event type
  data:       object|null,   // event payload
  __ble_addr: string|null,   // v2: authoritative device key (BLE MAC) — on every event
  addr:       string|null,   // v2: equals __ble_addr, kept for compatibility
  device:     string|null,   // v1 legacy fallback only
  node_id:    string|null,   // present on some event types — NOT a stable key (IDENTITY.md)
  from_num:   number|null,   // sender node_num (AppRouter-decoded events)
  rx_snr:     number|null,
  rx_rssi:    number|null,
  hops:       number|null,
  _replay:    boolean,       // true when seeded from REST on boot, not live radio
}
```

## State

_N/A_ — stateless. All state lives in `db.js`.

## Events emitted

_N/A_ — persist.js does not emit events.

## Event routing

| `event.type` | Action |
|---|---|
| `packet` | `handlePacket(data.packet, rxDevice, ts, _replay)` — routes by `portnum` |
| `node_info` | `handleNodeInfo(data, null)` — nodedb replay: never writes `nodes.device` |
| `nodeinfo` | `handleNodeInfo(data, null)` — alias |
| `node_update` | `handleNodeInfo(data, null)` — merged cache update from AppRouter |
| `telemetry` | `handleTelemetryEvent(event)` — AppRouter-decoded telemetry |
| `user` | `stmts.upsertNode` + `_upsertCache` — AppRouter-decoded NODEINFO_APP |
| `position` | `stmts.upsertNode` — AppRouter-decoded POSITION_APP |
| `detectionsensor` | `handleDetectionEvent(event, ts)` — AppRouter-decoded DETECTION_SENSOR_APP |
| `private_app` **and `portnum === 260`** | `handlePrivateAppState(event, ts)` — PAC_ALARM_APP latest-only cache |
| all others | silently ignored |

### `detectionsensor` — DETECTION_SENSOR_APP

A **standard registered portnum**, so it arrives as a typed event, not via
`private_app`. The registry name is `detectionsensor` (meshtastic/python
`__init__.py`), and the entry has **no `protobufFactory`**, so the payload is a
**string**.

`raw` is stored verbatim in every case. `JSON.parse` is attempted; on failure —
or on success without a string `type` — the row is written with all typed
columns null. **It never throws.** A stock Meshtastic detection module sends
plain text on this port by design, so one such node anywhere in the mesh must not
break ingestion for every other node. Unknown `type` values are stored as-is
rather than filtered (accept what the device sends).

### `private_app` portnum 260 — PAC_ALARM_APP

Routed by **numeric** `event.portnum === 260`, then by the payload's `type`
(`config`/`debug`/`calc`), into `node_app_state` keyed `(num, portnum, type)`.
The payload is stored **verbatim** — no interpretation here; formatting belongs
to the API layer (NODE_STATUS_SPEC iron rule 1).

The numeric check matters: `'PRIVATE_APP'` is a portnum-*range* label, not an app
identity — Meshtastic disambiguates private apps by portnum, not payload
(mt-transport API.md §7). Portnum 256 (tilt) is handled in `ws-relay.js` and is
never reached from here. Non-JSON payloads, or payloads without a string `type`,
are ignored silently: 260 is additive and node-dash must not assume it is the
only user.

No packet-id dedup — `private_app` does not carry `packet_id`. The latest-only
upsert is idempotent, so repeat deliveries from N radios are harmless.

### Packet portnum routing (inside `handlePacket`)

| `portnum` | Action |
|---|---|
| `TEXT_MESSAGE_APP` | `stmts.insertRxMessage` (if packet_id present) or `stmts.insertMessage` (legacy); then `syncAlertedAt` |
| `TELEMETRY_APP` → `device_metrics` | `stmts.upsertNode` + `insertDeviceMetricsHistory` |
| `TELEMETRY_APP` → `environment_metrics` | `stmts.upsertNodeEnvMetrics` + `insertEnvHistory` |
| `NODEINFO_APP` | `stmts.upsertNode` + `_upsertCache` |
| `POSITION_APP` | `stmts.upsertNode` |
| all others | silently ignored |

## Invariants

- `handleEvent` is the sole export and the only entry point. All routing is internal.
- Packets without `decoded` are silently dropped (`handlePacket` returns immediately if `!packet?.decoded`).
- Text messages with a `packet_id` use `stmts.insertRxMessage` (dedup key `'r-{pktId}'`). Text messages without a `packet_id` use the legacy `stmts.insertMessage` (no dedup).
- `_replay` events (seeded from REST on boot) are written with `replay = 1`. They do not trigger alerts.
- `_upsertCache` writes to `nodeinfo` (permanent). `stmts.upsertNode` writes to `nodes` (ephemeral). Both are called together whenever node identity is known.
- A node identity write to `nodeinfo` is skipped if `short_name` and `long_name` are both absent (`_upsertCache` guard).
- Coordinates are integer millidegrees divided by `1e7`. Coordinates outside `[-90,90]` lat or `[-180,180]` lon are stored as null (`_validCoord` guard).
- **Device key vocabulary (task `node-source-attribution`):**
  `rxDevice = __ble_addr ?? addr ?? device` — BLE MAC only: `device` is the
  V1 legacy field (also a MAC); `node_id` was removed from the chain
  (identity-phase-a B9) — it is not a device key and a fallback to it could
  reintroduce mixed vocabulary into `nodes.device`. `rxDevice` is what every db write stores as `device`. Before
  this fix `rxDevice = node_id || device` wrote unstable `!hex` values into
  `nodes.device`, giving the table a mixed MAC/`!hex` vocabulary that could
  never match the rotator MAC in the `node_source` filter.
- **`nodes.device` means "heard by":** `handleNodeInfo` passes
  `device: null` — `node_info`/`node_update` are nodedb replays, not
  reception evidence; `upsertNode`'s COALESCE keeps the last packet-derived
  value. Only real received packets (`packet`, `user`, `position`,
  `telemetry` branches) stamp `rxDevice`.
- `traceroute`, `range_test`, `text` (plain), `device_snapshot`, `device_data`, `device_state`, and `hello` event types are **not** handled here. They belong to other modules.

## Test notes

All tests use an in-memory SQLite DB (`:memory:`) with the same schema as `db.js`.

- **TEXT_MESSAGE_APP with packet_id**: event → row in `messages` with `message_key = 'r-{pktId}'`, correct `hops`, `is_dm`, `replay=0`
- **TEXT_MESSAGE_APP replay**: `_replay: true` → `replay = 1` in DB row
- **TEXT_MESSAGE_APP no packet_id**: uses legacy `insertMessage` stmt, `message_key` is null
- **TELEMETRY_APP device_metrics**: `upsertNode` called with battery/voltage/channel_util/uptime
- **TELEMETRY_APP environment_metrics**: `upsertNodeEnvMetrics` + row in `environment_history`
- **NODEINFO_APP**: `upsertNode` + `nodeinfo` row with correct identity fields
- **POSITION_APP**: `upsertNode` with lat/lon converted from integer millidegrees; invalid coords → null stored
- **`node_update` event**: `handleNodeInfo` writes both `nodes` and `nodeinfo`
- **`user` event**: `upsertNode` + `_upsertCache`; no `nodeinfo` write if both names absent
- **Unknown portnum**: no DB write, no error thrown
- **Unknown event type**: no DB write, no error thrown
- **`_validCoord` edge cases**: lat=91 → null; lon=181 → null; lat=0, lon=0 → stored (valid zero)
- **`syncAlertedAt` called**: after text message insert, `messages.alerted_at` backfilled if packet pre-alerted this session

## Out of scope

- Alerting logic — `alerts.js` owns that
- Traceroute writes — `traceroute.js` owns those
- Range test writes — `index.js` (to be extracted to `range-test.js`)
- Tilt writes — `ws-relay.js` (leaked concern, to be moved in ws-relay refactor task)
- Event delivery / bridge listener wiring — `index.js` / future `event-handler.js`
- Browser WebSocket broadcast — `ws-relay.js`
