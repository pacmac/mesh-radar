---
module: auto-purge-api
source: src/auto-purge-api.js
source_hash: 892fa4c97c9bdb8090d13ebf74c4b0964cc8e669bfce58d338dd615b63c176b9
updated: 2026-06-30
---

# Module: auto-purge-api

## Purpose

Express Router, purge executor, and scheduler for per-device node-DB purge.
Extracted from `index.js`. Manages automatic scheduled purge of the Meshtastic
node database on bridge-connected devices and exposes manual purge endpoints.

## Responsibilities

- Serve `GET /auto-purge?device=` — read per-device purge config (enabled, time, last_run_ts)
- Serve `PUT /auto-purge` — write per-device purge config
- Serve `POST /purge-nodedb` — trigger immediate purge on a device via bridge
- Run `runAutoPurge(nodeId)` — POST to bridge `/:nodeId/purge_nodedb`, update last-run ts, broadcast result
- Run 60-second scheduler — check each enabled device's purge time against wall clock, fire at match, guard against same-day re-run
- Accept a `broadcastAll` callback injected at startup (to emit `auto_purge_complete` / `auto_purge_error` events)

## Dependencies

- `db.js` — `getConfig`, `setConfig`, `getConfigByPrefix`
- `bridge.js` — `bridge.post` (for purge call)

## Public interface

```js
export default router                         // Express Router — mounted at /auto-purge by index.js
export function startAutoPurgeScheduler(broadcastAll)  // call once at server startup
```

## State

The 60s `setInterval` handle is internal; no exported state.

## Events emitted

_N/A_ (broadcasts via injected `broadcastAll` callback)

| Broadcast type | When |
|---|---|
| `auto_purge_complete` | `{ device, ts, node_count }` — purge succeeded |
| `auto_purge_error` | `{ device, error }` — purge failed |

## Invariants

- Config keys are namespaced per device: `auto_purge_enabled_${nodeId}`, `auto_purge_time_${nodeId}`, `auto_purge_last_run_ts_${nodeId}`.
- `PUT /auto-purge`: `purge_time` only stored if it matches `^\d{2}:\d{2}$`.
- Scheduler guard: if `lastRunDate === today` (local wall-clock date string), skip — prevents double-fire within the same minute window.
- `POST /purge-nodedb`: updates `last_run_ts` and broadcasts regardless of `node_count` value.
- `broadcastAll` must be injected before the scheduler fires; undefined callback should no-op gracefully.

## Test notes

- **GET /auto-purge — unknown device**: returns defaults `{ enabled: false, purge_time: '02:00', last_run_ts: null }`.
- **PUT — invalid purge_time**: `'2:00'` (no leading zero) → not stored; existing value retained.
- **POST /purge-nodedb — bridge fails**: 500 + broadcast `auto_purge_error`.
- **Scheduler — already ran today**: no second call to `runAutoPurge`.
- **Scheduler — time mismatch**: no call fired.

## Out of scope

- Bridge connectivity — `bridge.js` owns that.
- Broadcast infrastructure — `index.js` owns `broadcastAll`; injected here.
