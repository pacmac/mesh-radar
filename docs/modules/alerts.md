---
module: alerts
source: src/alerts.js
source_hash: cca04f4cf186d098588f7a05618c1606b39b529031194e20564aed346bc0a14c
updated: 2026-06-30
---

# Module: alerts

## Purpose

Alert evaluator. Combines a 60-second polling loop for threshold-based conditions
with event-driven hooks for bridge and packet events. All delivery is delegated
to `mailer.js`. Per-type cooldowns and enabled flags are stored in the DB alert
rules table.

## Responsibilities

- Poll every 60 s for node-offline and environmental threshold breaches
- React to `bridge_disconnected`, `tilt_update`, and `TEXT_MESSAGE_APP` packet events
- Enforce per-type cooldowns before sending
- Create reply tokens for DM and broadcast-direct alerts to enable email-reply-to-mesh
- Prune expired reply tokens daily
- Expose `ALERT_META` for the REST API to describe alert types to the UI

## Dependencies

- `db.js` — `getAlertRule`, `touchAlertLastSent`, `createReplyToken`, `pruneExpiredTokens`, `isPacketAlerted`, `markPacketAlerted`, `getTiltCal`; plus raw `db` export for `environment_history` query
- `mailer.js` — `sendAlert`
- `node:crypto` — `randomUUID` for reply tokens

## Exports

```js
export const ALERT_META      // object — static metadata for each alert type (label, unit, desc)
export function startAlertPoller(nodeList)  // start polling intervals — call once at startup
export function handleAlertEvent(ev)        // event-driven hook — call for every bridge event
```

## Alert types (`ALERT_META`)

| Type | Label | Unit | Trigger |
|---|---|---|---|
| `node_offline` | Node offline | min | Node not heard for N minutes (polling) |
| `ble_disconnect` | BLE disconnected | — | Bridge lost connection to gateway (`bridge_disconnected` event) |
| `temp_high` | High enclosure temp | °C | Environment temp ≥ threshold (polling) |
| `condensation` | Condensation risk | °C | Dew point within N°C of temperature (polling) |
| `dm_received` | Direct message | — | DM received on the gateway node (packet event) |
| `broadcast_direct` | 0-hop broadcast | — | Broadcast received with 0 hops (packet event) |
| `tilt_high` | Mast tilt | ° | Mast tilt exceeds threshold degrees (tilt_update event) |

## `startAlertPoller(nodeList)`

Starts two intervals:
- `setInterval(runPollingChecks, 60_000)` — calls `checkNodeOffline` and `checkTempAndCondensation`
- `setInterval(pruneExpiredTokens, 86_400_000)` — daily cleanup of expired reply tokens

`nodeList` is stored as `_nodeList` for use by `checkNodeOffline`. `db` is stored as `_db` for `checkTempAndCondensation`.

## Polling checks

### `checkNodeOffline`

Config: `alert_rules.node_offline` → `threshold` (minutes, default 30), `cooldown_minutes` (default 30).

Logic: filters `_nodeList.nodes` for nodes with `last_heard < (now - threshold*60)` and `user.short_name` set. If any found and cooldown passed, sends one alert listing up to 5 names.

### `checkTempAndCondensation`

Reads the most recent row from `environment_history` via `_db.prepare()`.

- **temp_high**: if `temperature >= threshold` (default 50°C) and cooldown passed → send alert
- **condensation**: computes `dewPoint = temp - (100 - rh) / 5`; if `(temp - dewPoint) <= threshold` (default 3°C) and cooldown passed → send alert

## `handleAlertEvent(ev)` — event-driven dispatch

Wraps `_dispatchAlertEvent` with a try/catch to prevent uncaught exceptions from killing the event loop.

### `bridge_disconnected`

Checks `ble_disconnect` rule. If enabled and cooldown passed → `sendAlert('ble_disconnect', ...)`.

### `tilt_update`

Reads tilt calibration (`getTiltCal()`), subtracts zero offsets from `ev.data.pitch` and `ev.data.roll`, takes the max absolute value as the net tilt. If tilt ≥ `tilt_high.threshold` (default 10°) and cooldown passed → `sendAlert('tilt_high', ...)`.

### `packet` (TEXT_MESSAGE_APP)

Decodes `pkt.decoded.payload` from base64 UTF-8. Determines `isDm = (pkt.to >>> 0) !== 0xffffffff`. Computes `hops = hop_start - hop_limit`.

**dm_received** (isDm=true):
- Checks `dm_received` rule, cooldown, and `isPacketAlerted(pktId)` dedup
- Creates a reply token (`createReplyToken(token, ev.device, pkt.from, pktId, channel)`)
- Sends alert with `[reply:<token>]` in subject line
- Marks packet as alerted (`markPacketAlerted(pktId)`)

**broadcast_direct** (isDm=false, hops=0):
- Same flow as `dm_received` but for `broadcast_direct` rule

## `canSend(rule)` helper

Returns false if:
- `rule` is null/undefined
- `rule.enabled` is falsy
- `rule.last_sent` is set AND `(now - last_sent) < cooldown_minutes * 60`

## `dewPoint(tempC, rhPct)` helper

`dewPoint = tempC - (100 - rhPct) / 5` — Magnus approximation. Returns null if either input is null.

## Invariants

- `handleAlertEvent` swallows exceptions — a broken alert handler never kills the event loop.
- `dm_received` and `broadcast_direct` are packet-level deduped via `isPacketAlerted`/`markPacketAlerted` in addition to the type-level cooldown. A packet received by multiple radios only sends one alert.
- Reply tokens are UUID strings embedded in the email subject (`[reply:<uuid>]`). `imap-receiver.js` extracts them to route email replies back to the mesh.
- `_nodeList` is injected at startup; if `startAlertPoller` is not called, polling never runs and `handleAlertEvent` still works for event-driven alerts.
- **Code smell**: `checkTempAndCondensation` uses the raw `db` export and calls `db.prepare()` at polling time. This should be a named prepared statement in `db.js`.
- **v1 defect**: `ev.device` is used in `createReplyToken` (line 155) as the originating device identifier. After bridge.js v2 alignment this should be `ev.__ble_addr`.

## Test notes

- **canSend — disabled**: `rule.enabled = false` → false regardless of cooldown
- **canSend — cooldown active**: `last_sent` within cooldown window → false
- **canSend — no last_sent**: `last_sent = null` → true (first send always allowed)
- **node_offline**: inject `nodeList.nodes` with stale node → alert sent; same node within cooldown → not sent again
- **temp_high**: environment_history row with temp=55, threshold=50 → alert sent
- **condensation**: temp=20, rh=95 → dewPoint=15, gap=5; threshold=3 → no alert. rh=98 → dewPoint=17.6, gap=2.4 → alert
- **ble_disconnect**: `handleAlertEvent({ type: 'bridge_disconnected' })` → `sendAlert('ble_disconnect', ...)` called
- **tilt_high**: `ev.data = { pitch: 15, roll: 3 }`, cal.zero.pitch=0, threshold=10 → tilt=15 ≥ 10 → alert
- **dm_received**: TEXT_MESSAGE_APP to specific node → reply token created; same pktId again → deduped
- **broadcast_direct**: TEXT_MESSAGE_APP to 0xffffffff, hops=0 → alert; hops=1 → not triggered
- **exception safety**: `_dispatchAlertEvent` throws → `handleAlertEvent` catches, logs, does not rethrow

## Out of scope

- Email delivery — `mailer.js` owns SMTP transport
- Reply email parsing and mesh message sending — `imap-receiver.js` owns that
- Alert rule CRUD — `index.js` REST endpoints + `db.js` storage own that
- UI display of alert types — `index.js` serves `ALERT_META` via `GET /alerts/rules`

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Email reply tokens store `ev.node_id ?? ev.addr` as from_node_id (V2 removed `device` — tokens previously stored undefined, breaking email→mesh replies).
