---
module: persist
source: src/persist.js
source_hash: 202f34ede9c40da729146081907bf27ff799750b57fd3e505a481db58192110d
updated: 2026-07-26
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
| all others | silently ignored |

### `detectionsensor` — DETECTION_SENSOR_APP

A **standard registered portnum**, so it arrives as a typed event, not via
`private_app`. The registry name is `detectionsensor` (meshtastic/python
`__init__.py`), and the entry has **no `protobufFactory`**, so the payload is a
**string**.

`raw` is stored verbatim without application-specific parsing. It never throws:
one detection node must not break ingestion for every other node.

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
- **`_upsertCache` freshness gate (task `nodeinfo-replay-regression`,
  2026-07-25).** Signature is now `_upsertCache(num, nodeId, u, pos,
  lastHeard)` — every call site (`user` event, raw `packet` NODEINFO_APP, and
  `handleNodeInfo`'s replay path) passes the same `last_heard` value it just
  gave the sibling `upsertNode.run()` call. Before writing `nodeinfo`,
  `_upsertCache` reads the `nodes` row for that `num` (`stmts.getNodeByNum`)
  and skips the `nodeinfo` write entirely when `lastHeard` is older than the
  stored `nodes.last_heard` — `nodeinfo` has no `last_heard` column of its
  own to self-gate with (deliberately, see `db.md`'s `nodeinfo` note), so it
  borrows the sibling table's, which `upsertNode`'s own gate (see `db.md`)
  keeps authoritative. `upsertNode` itself gained the equivalent gate at the
  SQL level, so it needs no JS-side change here — this note covers only the
  `_upsertCache`/`nodeinfo` side of the same fix.
- **`handlePacket`'s `replay` parameter was previously unused for anything
  except the `TEXT_MESSAGE_APP` branch** (stamps `messages.replay`) — the
  NODEINFO_APP/POSITION_APP/TELEMETRY_APP branches never checked it before
  writing `nodes`/`nodeinfo`, so a replayed packet (mesh-gw's `_replay:true`,
  "seeded from REST on boot, not live radio" per this file's own event-shape
  doc above) could carry an old `rx_time` straight into `upsertNode`
  unguarded. Fixed at the `upsertNode` SQL layer (see `db.md`), not by
  branching on `replay` here — the monotonicity gate protects every caller
  uniformly regardless of which flag marked the data as non-live.

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

## Signal capture carries the receiving radio (task `signal-provenance-mixed-source`)

`_captureSignal` wrote `signal_history` with no record of WHICH gateway radio
made the measurement, and the `(num, packet_id)` dedup index meant the second
radio to report a shared broadcast was silently dropped. See
`docs/modules/db.md` for the storage-side reasoning.

`_captureSignal` gains an `rxDevice` parameter, threaded from the value each
call site already holds:

- `handleEvent` (persist.js:116) — passes `rxDevice`, computed at :110 as
  `event.__ble_addr ?? event.addr ?? event.device ?? null`.
- `handlePacket` (persist.js:263) — passes its own `device` parameter.

Both are MACs, matching `nodes.device` vocabulary (IDENTITY.md). A null
`rx_device` is permitted and means "radio not attributed" — it does not block
the insert, and with the new three-column dedup key a null attribution simply
dedups against other nulls.

No change to the `isDirect` gate, to which packets are captured, or to
`nodes.rssi`/`nodes.snr`. This task makes the stored measurement say where it
came from; it does not yet change what is displayed.
