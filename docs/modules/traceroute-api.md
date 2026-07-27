---
module: traceroute-api
source: src/traceroute-api.js
source_hash: 819d527f60da306ca1274a7b801d01a6a790002cb5a91fecfb8f060b56d6e29e
updated: 2026-07-27
---

# Module: traceroute-api

## Purpose

Express Router for traceroute initiation and history. Extracted from `index.js`.
Dispatches a traceroute to a target node from an explicit `via` radio, or — when
none is given — from the current mode's transmitter (`transmitterForMode`), and
exposes the stored traceroute history from SQLite.

## Responsibilities

- Serve `POST /:nodeId/traceroute` — dispatch traceroute from primary device to target
- Serve `GET /traceroute_history` — query stored traceroute results with JSON-parsed arrays
- Resolve target nodeId hex string to integer `num`
- Resolve the dispatch radio: `via ?? transmitterForMode(dashMode.value)` — an
  explicit `via` wins, else the active mode's transmitter (ACTV→YAGI, PASV→primary)
- Gate on `FF.SSOT_TRACEROUTE`: V1 calls `bridge.post` directly; V2 calls `traceroute.dispatch`

## Dependencies

- `traceroute.js` — `traceroute.dispatch` (V2 path)
- `bridge.js` — `bridge.post` (V1 legacy path)
- `db.js` — `stmts.queryTracerouteHistory`
- `dash-mode.js` — `dashMode`, `transmitterForMode` (mode's dispatch radio when no `via`)
- `feature-flags.js` — `FF.SSOT_TRACEROUTE`

## Public interface

```js
export default router  // Express Router — registered on app by index.js
```

## State

_N/A_

## Events emitted

_N/A_

## Invariants

- `POST /:nodeId/traceroute` parses `targetNum` as `parseInt(nodeId.replace('!',''), 16)`; returns 400 if result is falsy.
- Returns 503 if the dispatch radio is unresolvable (`via ?? transmitterForMode(dashMode.value)` returns null — e.g. no primary/rotator configured).
- `GET /traceroute_history`: `limit` is capped at 1000; `to_num` filter is applied if query param present.
- History arrays (`route`, `route_back`, `snr_towards`, `snr_back`, `relay_positions`) are stored as JSON strings and parsed before returning.

## Test notes

- **POST — bad nodeId**: 400 `{ error: 'invalid nodeId' }`.
- **POST — no primary**: 503 `{ error: 'no primary device configured' }`.
- **POST — bridge error**: 502 with error message.
- **GET /traceroute_history — limit cap**: `?limit=5000` → 1000 results max.
- **GET — JSON arrays**: `route` is an array not a string in response.

## Out of scope

- Traceroute decode and storage — `traceroute.js` and `persist.js` own that.
- Auto-traceroute on ACTV/SCAN contact — `lifecycle.js` and `scanner.js` own that.

## Per-device dispatch + scoped history (task `perf-per-device`)

`POST /:nodeId/traceroute` accepts optional `{ via: '!hex' }` — dispatch
through a specific radio so its RF chain is measured (default: primary).
`GET /traceroute_history?device=!hex` returns rows scoped by `tx_device`.

## Identity Phase B

`via` accepts a BLE MAC (`AA:BB:…`) or a `!hex` node id. The perf page
sends MACs from Phase B on; `!hex` stays valid for manual/legacy callers.

## Phase C1

`GET /traceroute_history` is in `WS_ONLY_ROUTES` — browser fetches get
410; curl/server-side reads still work (debug tool, not page transport).

## Manual dispatch bypasses the master switch (task `traceroute-manual-enable`)

`POST /:nodeId/traceroute` passes `manual: true` to `traceroute.dispatch()`.
The `traceroute.enabled` switch gates AUTOMATIC dispatch only — a user asking
for a traceroute is always honoured, whatever the switch says.
