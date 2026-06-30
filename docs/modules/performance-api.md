---
module: performance-api
source: src/performance-api.js
source_hash: a18a8784305984c670caaa8946c5678780bc1f848d71b5adaad68863c0beb323
updated: 2026-06-30
---

# Module: performance-api

## Purpose

Express Router factory for performance and telemetry history endpoints. Extracted
from `index.js`. Serves tilt history, environment history, and tilt calibration
read/write — the data backing the `/performance` browser tab.

## Responsibilities

- Serve `GET /tilt_history` — tilt sensor records for a node over a time window
- Serve `POST /tilt_history/ncal` — mark records around a calibration event as NCAL
- Serve `GET /env_history` — environment metrics (temp, humidity, pressure, etc.) for a node
- Serve `GET /tilt_cal` — read the current tilt calibration (zero, north_angle)
- Serve `PUT /tilt_cal` — write tilt calibration fields and broadcast `tilt_cal` WS event

## Routes

Mounted without prefix by `index.js` (`app.use(createPerformanceRouter(broadcastAll))`).

| Method | Path | Action |
|---|---|---|
| GET | `/tilt_history` | `?node_id=&hours=4` → `queryTiltHistory(node_id, since)` |
| POST | `/tilt_history/ncal` | `{ node_id, ts, window_sec=90 }` → `markTiltNcal(node_id, ts±window)` |
| GET | `/env_history` | `?num=&hours=24` → `queryEnvHistory(num, since)` |
| GET | `/tilt_cal` | `getTiltCal()` |
| PUT | `/tilt_cal` | `saveTiltCal({zero, north_angle})` then `broadcastAll({type:'tilt_cal',...})` |

## Dependencies

- `db.js` — `queryTiltHistory`, `markTiltNcal`, `queryEnvHistory`, `getTiltCal`, `saveTiltCal`
- `broadcastAll` — injected at factory call time; sends `tilt_cal` WS event to all clients

## Public interface

```js
export function createPerformanceRouter(broadcastAll)  // → Express Router
```

## State

_N/A_

## Events emitted

- `{ type: 'tilt_cal', zero, north_angle }` — broadcast to all WS clients on `PUT /tilt_cal`

## Invariants

- `GET /tilt_history`: `hours` defaults to 4; `since` computed as `now - hours * 3600`.
- `POST /tilt_history/ncal`: requires `node_id` and `ts`; returns 400 if missing. `window_sec` defaults to 90. Marks records in `[ts - window_sec, ts + window_sec]`.
- `GET /env_history`: `hours` defaults to 24; `num` parsed as int (0 if absent).
- `PUT /tilt_cal`: only fields present in the body are updated (`'zero' in body` check). Null is a valid value (clears calibration). Broadcasts full `tilt_cal` object after save.

## Test notes

- **GET /tilt_history**: `?hours=2` → `since = now - 7200`.
- **POST /tilt_history/ncal — missing fields**: 400 `{ error: 'node_id and ts required' }`.
- **POST /tilt_history/ncal — custom window**: `window_sec=60` → marks `[ts-60, ts+60]`.
- **PUT /tilt_cal — partial update**: body `{ zero: 0 }` only updates `zero`, leaves `north_angle` unchanged.
- **PUT /tilt_cal**: broadcasts `{ type: 'tilt_cal', zero, north_angle }` after save.

## Out of scope

- Tilt sensor ingestion — `ws-relay.js` owns `insertTilt` on incoming events.
- Environment metrics ingestion — bridge events handler in `index.js` owns `insertEnvHistory`.
- Traceroute performance data — `traceroute-api.js` owns that.
