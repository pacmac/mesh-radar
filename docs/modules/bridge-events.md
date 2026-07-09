---
module: bridge-events
source: src/bridge-events.js
source_hash: f66406f5d8cc2f6830ca53da0cc2f17b42a44c0fe3cd0abf1a078102e309a397
updated: 2026-07-09
---

# Module: bridge-events

## Purpose

Registers and handles the `bridge.on('event', ...)` listener. Extracted from
`index.js`. Routes each incoming gw event to the correct backend module. This is
the single dispatch point for all live mesh-gw events entering the backend.

## Responsibilities

- Register `bridge.on('event', handler)` on startup
- For `node_update`: call `handleEvent`, `nodeList.handleNodeUpdate`, and conditionally insert environment metrics (own devices, >60s dedup)
- For `packet`: call `handleEvent`, `activeTracker.handlePacket`, `scanner.handlePacket`, `nodeList.touchLastHeard` + `nodeList.setHopsAway(pkt.from, hopsAway(pkt.hop_start, pkt.hop_limit))` (both under the rotator/yagi-only guard), and traceroute dispatch (V1 inline or V2 via `traceroute.js`)
- For `traceroute` typed event: route to traceroute.js (V2) or inline `nodeList.setTraceroute` (V1)
- For `rangetest` typed event: call `insertRangeTestEntry`
- Accept injected dependencies (bridge instance, broadcastAll, nodeList, etc.) to avoid circular imports

## Dependencies

- `bridge.js` — `bridge` (event source)
- `persist.js` — `handleEvent`
- `node-list.js` — `nodeList`, `hopsAway` (guarded hops-away helper)
- `active-tracker.js` — `activeTracker`
- `scanner.js` — `scanner`
- `traceroute.js` — `traceroute` (FF.SSOT_TRACEROUTE path)
- `db.js` — `stmts`, `insertRangeTestEntry`, `insertEnvHistory`
- `node-filter.js` — `ownDeviceNums`
- `dash-mode.js` — `isListenerForMode('scan', …)` (scan-time last-heard guard)
- `feature-flags.js` — `FF`

## Public interface

```js
export function registerBridgeEvents(bridge)  // call once at startup in index.js
```

## State

```js
_lastEnvTs = new Map()  // num → last inserted ts (env metrics dedup, >60s gate)
```

## Events emitted

_N/A_ (consumes events from bridge; other modules emit downstream)

## Invariants

- `rxDevice = ev.addr || ev.device || null` — v1/v2 compatibility shim.
- Env metrics: only inserted for own devices (`ownDeviceNums().has(node.num)`) and only when `now - last > 60s`.
- Scan-time listener guard: during scan, `yagiOnly = scanner.active && !isListenerForMode('scan', rxDevice)` — packets received by a radio that is NOT a SCAN listener are excluded from `touchLastHeard` and `setHopsAway`. Default SCAN listener is the rotator, so this is the historic yagi-only behaviour; `mode_config` can widen it.
- Hops-away is computed here from the raw packet (`pkt.hop_start`/`pkt.hop_limit`) — the only per-reception source that carries the hop fields and reaches `nodeList`. The gw's aggregate `node_info.hops` is unguarded and stripped in `node-list.js`; see its "Hops-away ownership" section.
- `FF.SSOT_TRACEROUTE` governs both raw-packet and typed-event traceroute paths — they must stay in sync.
- `traceroute` typed event path is additive (parallel to raw packet) in V1; V2 routes both to `traceroute.handlePacket`.

## Test notes

- **node_update — env metrics**: own device with temp → `insertEnvHistory` called once; second call within 60s → skipped.
- **packet — yagi-only**: scanner active, packet from non-rotator device → `touchLastHeard` NOT called.
- **rangetest**: `insertRangeTestEntry` called with correct fields extracted from typed event.
- **traceroute V2**: `traceroute.handlePacket` called for both raw TRACEROUTE_APP packet and typed event.
- **packet — hops-away**: packet with `hop_start:3, hop_limit:1` → `setHopsAway(from, 2)`; `hop_start:0` → `setHopsAway(from, null)` (prior value preserved); scanner active + non-rotator device → `setHopsAway` NOT called.

## Out of scope

- `bridge.on('connected')` — `startup.js` owns that.
- Scanner/dashMode/rotator event wiring — `lifecycle.js` owns that.
- WS broadcast to browser — `ws-relay.js` owns that (it has its own `bridge.on('event')` listener).

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Range-test DB persistence listens for the V2 `range_test` event name (was `rangetest`).

## V2 node_info routing (task `node-filter-fix`)

Live node updates route to `nodeList.handleNodeUpdate` on the V2 event name
`node_info` (plus legacy `node_update`). Previously only `node_update` was
wired, so live rssi/snr/hops/via_mqtt/device_metrics never reached the node
cache — six of nine node filters matched no field and the node-card signal
bars were blank.
