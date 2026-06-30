---
module: range-test-api
source: src/range-test-api.js
source_hash: 338789eefdb1433dbb39ebbcb52f5d53e0538c8ec05b71eb4496673eb2f1ee1c
updated: 2026-06-30
---

# Module: range-test-api

## Purpose

Express Router and timer state machine for range test control. Extracted from
`index.js`. Manages the range test enable/disable lifecycle on the bridge device,
exposes the timer state to the browser, and serves the persistent range test log.

## Responsibilities

- Maintain `_rangeTimer` state: `{ active, endsAt, nodeId }`
- Serve `GET /range_test/timer` — current timer state with `remaining` seconds
- Serve `POST /range_test/start` — enable range test on bridge device, start countdown
- Serve `POST /range_test/stop` — disable range test on bridge device, clear timer
- Serve `GET /range_test/log` — query stored range test log with name resolution
- Serve `DELETE /range_test/log` — clear range test log
- Export `getRangeTimer()` for use by index.js (passed to `attachWsRelay` for on-connect replay)
- Call bridge `PUT /:nodeId/config/range_test` to enable/disable (via `_bridgePutRangeTest`)

## Dependencies

- `db.js` — `queryRangeTestLog`, `clearRangeTestLog`
- `node-label.js` — `resolveNodeLabel`, `resolveDeviceLabel`
- `process.env.BRIDGE_URL` — `'http://localhost:8001'` default; read at module load

## Public interface

```js
export default router       // Express Router — mounted at /range_test by index.js
export function getRangeTimer()  // { active, endsAt, nodeId, remaining }
```

## State

```js
_rangeTimer       = { active: false, endsAt: null, nodeId: null }
_rangeTimerHandle = null  // setTimeout handle for auto-disable
```

## Events emitted

_N/A_

## Invariants

- `POST /range_test/start`: `duration` clamped to `Math.max(1, durationMin)`. Previous timer is cleared before starting a new one.
- Auto-disable fires after `duration * 60 * 1000` ms: calls `_bridgePutRangeTest(nodeId, false)`. Failure is logged but does not crash.
- `POST /range_test/stop`: uses `_rangeTimer.nodeId` if available, else `req.body.nodeId`. Timer cleared regardless of bridge call result.
- `GET /range_test/log`: `limit` defaults to 500 (`parseInt(req.query.limit) || 500`); no hard cap.
- `getRangeTimer()` always returns `remaining` as a non-negative integer or null.

## Test notes

- **POST start**: bridge enabled, timer set, `_rangeTimer.active = true`.
- **POST start — bridge fails**: 502; timer NOT set.
- **POST stop — no nodeId**: timer cleared; no bridge call.
- **Auto-disable**: timer fires → bridge disabled → `_rangeTimer` reset.
- **GET timer**: `remaining` decreases over time; null when not active.

## Out of scope

- Range test packet ingestion — `bridge-events.js` handles `rangetest` typed events.
- Range test DB insertion — `db.js` `insertRangeTestEntry` owns that.
