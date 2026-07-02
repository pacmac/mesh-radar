---
module: active-tracker
source: src/active-tracker.js
source_hash: 979d78dcf0e6cb1af77da8ab1453ed9bc1d06714ce6c03e3917e18f17da790f4
updated: 2026-06-30
---

# Module: active-tracker

## Purpose

ACTV mode controller. Selects nodes from the live radar, points the YAGI rotator
toward each in turn, records signal contact, and advances to the next target on a
configurable dwell timer. Supports user-initiated manual override via `targetNum`.

Does not own traceroute dispatch — callers (index.js) decide when to trace a
scan contact.

## Responsibilities

- Build a prioritised visit schedule from `nodeList.nodes` (positioned nodes only), sorted by least-recently targeted
- Command the rotator to each target azimuth via `rotator.move`
- Record targeting events in `nodeinfo` via `recordYagiTargeted`
- Record signal contact (RSSI/SNR) per packet received from the targeted node
- Advance to the next target after dwell time; retry if no nodes available
- Expose `targetNum(num)` for manual override from the API

## Dependencies

- `rotator.js` — `rotator.move`, `rotator.emit`
- `dash-mode.js` — `dashMode.value` (included in `point_target` payload)
- `device-config.js` — `getRotatorAddress`
- `db.js` — `stmts.getNodeinfoByNum`, `getConfig`, `insertRangeTestEntry`, `recordYagiTargeted`, `recordYagiContact`
- `node-list.js` — `nodeList.nodes` (filtered live nodes)
- `utils.js` — `bearing`

## Public interface

```js
export const activeTracker = {
  start()                // begin ACTV cycle — call when entering ACTV mode
  stop()                 // stop cycle, clear all state — call when leaving ACTV mode
  handlePacket(ev)       // feed a bridge packet event — call for every 'event' from bridge
  targetNum(num)         // → boolean — manually point at a node; false if not found or no homePos
}
```

## State (module-level)

| Field | Type | Description |
|---|---|---|
| `_holdTimer` | Timer\|null | Pending `advance()` call after dwell expires |
| `_firedNum` | num\|null | Node num currently being targeted |
| `_firedAt` | number\|null | `Date.now()` when current targeting began |
| `_lastRssi` | number\|null | Last RSSI received from the currently targeted node |
| `_lastSnr` | number\|null | Last SNR received from the currently targeted node |

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `actv_config.dwell_sec` | 90 | Hold time per target before advancing (ms: × 1000) |
| `actv_config.retry_sec` | 30 | Retry delay when no nodes are in radar (ms: × 1000) |
| `home.lat` / `home.lon` | null | Required for azimuth calculation; no home → empty schedule |

## Events emitted (via rotator)

| Event | Emitter | Payload | When |
|---|---|---|---|
| `'point_target'` | `rotator` | `{ point_target, az, _mode, yagi_target_count, yagi_contact_count, yagi_last_contact, yagi_best_rssi, yagi_best_snr }` | On every `pointAt()` call |
| `'signal_update'` | `rotator` | `{ signal_num, rssi, snr, ts }` | On each packet from the targeted node |

## Schedule build and cycle flow

```
advance()
  → buildSchedule()
      → nodeList.nodes filtered to positioned nodes
      → compute az = bearing(home, node)
      → fetch yagi_last_targeted from nodeinfo
      → sort: null yagi_last_targeted first (never targeted), then ascending timestamp
  → if empty → retry after actv_config.retry_sec
  → pointAt(schedule[0])
      → _firedNum = node.num, _firedAt = now, _lastRssi/Snr = null
      → rotator.move(az)
      → recordYagiTargeted(num)
      → rotator.emit('point_target', {...})
      → _holdTimer = setTimeout(advance, actv_config.dwell_sec * 1000)
```

## `handlePacket` filter

Accepts only packets where:
1. `rotatorId` is configured
2. `ev.device === rotatorId` — packet received via the YAGI radio (v1; post-v2 use `ev.__ble_addr`)
3. `pkt.from === _firedNum` — from the currently targeted node

On match: updates `_lastRssi`/`_lastSnr`, emits `rotator.signal_update`, calls `recordYagiContact` and `insertRangeTestEntry`.

## Invariants

- `start()` calls `advance()` immediately — the first target is selected on the calling tick.
- `stop()` clears `_holdTimer` and resets all module-level state to null. Calling `stop()` while idle is safe.
- `targetNum(num)` clears the current `_holdTimer` before calling `pointAt`, so dwell resets to a full period for the manual target.
- `buildSchedule()` reads `nodeList.nodes` fresh on every call — no caching. Schedule reflects filter and config changes immediately.
- Nodes without `position.latitude_i` or `position.longitude_i` are excluded from the schedule.
- If `home.lat`/`home.lon` is not configured, `buildSchedule()` returns `[]` and `advance()` retries indefinitely.
- **v1 defect (handlePacket)**: `ev.device !== rotatorId` uses the v1 `device` field. After bridge.js v2 alignment, this must become `ev.__ble_addr`.
- `activeTracker` is a plain object — it is not an EventEmitter. It uses `rotator` as a proxy for event emission.

## Test notes

- **schedule sort**: two nodes, A never targeted, B targeted 1h ago → A first in schedule
- **schedule empty**: no positioned nodes → `advance()` → `_holdTimer` set to retry_sec; no `pointAt`
- **full dwell cycle**: `start()` → `pointAt(A)` → wait dwell_sec → `advance()` → `pointAt(B)`
- **`targetNum` interrupt**: `start()` → `pointAt(A)` with long dwell → `targetNum(B)` → `pointAt(B)` immediately; dwell resets
- **`targetNum` unknown node**: node not in `nodeList.nodes` → returns `false`
- **`handlePacket` filter**: packet from wrong device → ignored; packet from non-targeted node → ignored; packet from `_firedNum` via rotator → `recordYagiContact` called
- **`stop()`**: clears timer, all state null; subsequent `handlePacket` calls are no-ops
- **no homePos**: `getConfig('home.lat', null)` returns null → `buildSchedule()` returns [] → `advance()` retries

## Out of scope

- Traceroute dispatch — index.js calls `traceroute.dispatch` on `scan_contact` events; active-tracker.js does not
- Scanner sweep — `scanner.js` owns the SCAN mode BLE sweep; active-tracker.js owns only ACTV targeting
- Mode transitions — index.js starts/stops `activeTracker` in the `dashMode.on('change', …)` handler
- Rotator hardware control — `rotator.js` owns serial/network communication

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Rotator packet matching compares `ev.addr` (BLE MAC) — V2 removed the `device` field; the old comparison made ACTV signal confirmation impossible.
