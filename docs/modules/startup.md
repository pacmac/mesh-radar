---
module: startup
source: src/startup.js
source_hash: 2b80e2ab0ffd872bef842d7e1b4aa3efedfdc1658fda27cda78908922f1593a6
updated: 2026-07-03
---

# Module: startup

## Purpose

Registers `bridge.on('connected', ...)` and handles the node seed sequence.
Extracted from `index.js`. On each bridge (re)connection, loads all nodes from
mesh-gw and optionally persists named nodes into SQLite.

## Responsibilities

- Register `bridge.on('connected', handler)` on startup
- Fetch `/nodes` (all nodes) → `nodeList.seed`, `nodeList.restoreDeviceAttribution`
- Seed own-device entries: for each known device config, find the matching node and call `nodeList.seedOwnDevice`
- If `cfg.load_nodes_on_boot = true`: fetch `/nodes?named_only=true` → run each through `handleEvent` to persist into SQLite
- Log seed counts and errors without crashing

## Dependencies

- `bridge.js` — `bridge` (event source + `bridge.get`)
- `node-list.js` — `nodeList`
- `persist.js` — `handleEvent`
- `device-config.js` — `getPrimaryMac`, `getDeviceCfg`, `getAllDeviceCfgs`
- `db.js` — `stmts.getNodeDevices`

## Public interface

```js
export function registerStartupHandlers(bridge)  // call once at startup in index.js
```

## State

_N/A_

## Events emitted

_N/A_

## Invariants

- `bridge.on('connected')` fires on every reconnect — seed is re-run each time.
- `nodeList.seed(allNodes, null)` is always called even if `load_nodes_on_boot = false`.
- Device attribution (`stmts.getNodeDevices`) is restored after every seed to preserve which device last heard each node.
- The `seedOwnDevice` loop iterates MAC-keyed device configs (`key.includes(':')`), resolves each MAC to its node_id via the live registry (seeded from persisted `node_mac.*` at module load), and derives the node num from that. The old `startsWith('!')` guard matched nothing once configs became MAC-keyed — the loop was dead (identity-phase-a B10). `_device` is stamped with the MAC.
- Named-node persist uses `handleEvent({ type: 'node_update', data: n, device: null })` — same path as live events.
- Errors in either seed step are caught and logged; they do not prevent the other step from running.

## Test notes

- **Connected — load_nodes_on_boot=false**: `/nodes` fetched, `nodeList.seed` called, `/nodes?named_only` NOT fetched.
- **Connected — load_nodes_on_boot=true**: both endpoints fetched; `handleEvent` called for each named node.
- **Bridge error on /nodes**: logged; no crash; `/nodes?named_only` still attempted.
- **Reconnect**: seed sequence runs again from scratch.

## Out of scope

- Bridge connection management — `bridge.js` owns that.
- Scan state resume — `index.js` owns that (runs after `server.listen`, not on bridge connect).
- Alert poller startup — `index.js` calls `startAlertPoller` at listen time.
