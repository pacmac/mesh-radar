---
module: lifecycle
source: src/lifecycle.js
source_hash: 859563b7c14458d9e1c42adeaa57b926f511ce947cc56d8d0eea7dd1556166fc
updated: 2026-06-30
---

# Module: lifecycle

## Purpose

Wires all cross-module event handlers that manage operational mode transitions.
Extracted from `index.js`. Connects scanner, dashMode, rotator, activeTracker,
passiveTracer, and traceroute into a coherent lifecycle without any of those
modules knowing about each other.

## Responsibilities

- Register `scanner.on('start')` — stop activeTracker, set dashMode=2 (SCAN), call `nodeList.setScanActive(true)`
- Register `scanner.on('contact')` — call `nodeList.confirmScanContact`; if `FF.SSOT_TRACEROUTE`, dispatch auto-traceroute
- Register `scanner.on('end')` — restore pre-scan dashMode, call `nodeList.setScanActive(false)`
- Register `dashMode.on('change')` — start/stop activeTracker on mode transitions
- Resume ACTV mode on startup if `dashMode.value === 1` at module load
- Register `rotator.on('point_target')` — dispatch auto-traceroute on new ACTV target (V1 inline or V2 via traceroute.js)
- Call `passiveTracer.init()` after bridge event handler is registered (ordering constraint)
- Export `initLifecycle(broadcastAll)` to be called once at startup

## Dependencies

- `scanner.js` — `scanner`
- `dash-mode.js` — `dashMode`
- `rotator.js` — `rotator`
- `active-tracker.js` — `activeTracker`
- `node-list.js` — `nodeList`
- `passive-tracer.js` — `passiveTracer`
- `traceroute.js` — `traceroute`
- `feature-flags.js` — `FF`
- `device-config.js` — `getRotatorAddress`, `resolvePrimaryNodeId`

## Public interface

```js
export function initLifecycle()  // call once after server.listen and bridge-events registration
```

## State

```js
TRACE_COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes — cooldown between auto-traceroutes
```

## Events emitted

_N/A_ (responds to events from scanner/dashMode/rotator; does not emit its own)

## Invariants

- ACTV and SCAN are mutually exclusive: `scanner.on('start')` always stops activeTracker.
- `dashMode.on('change')` ignores mode=1 (ACTV) if `scanner.active` — SCAN takes precedence.
- `passiveTracer.init()` must be called AFTER `bridge.on('event')` is registered so `nodeList.setTraceroute` runs before the `traced` emit.
- Auto-traceroute on `rotator.on('point_target')` is V1 inline (per-call cooldown state on `rotator._lastTracedNum/_lastTracedAt`) or V2 via `traceroute.dispatch` with `cooldownMs`.
- Auto-traceroute on `scanner.on('contact')` only fires if `FF.SSOT_TRACEROUTE` and `sender` is resolvable.

## Test notes

- **scanner start → dashMode=2**: `dashMode.value` is 2 after scan start.
- **dashMode change → mode=1 with scan active**: `activeTracker.start` NOT called.
- **point_target — V2 cooldown**: second call within 5 min → rejected silently.
- **passiveTracer.init timing**: must not be called before bridge event listener registered.

## Out of scope

- Scanner sweep logic — `scanner.js` owns that.
- Traceroute dispatch and storage — `traceroute.js` owns that.
- `bridge.on('event')` dispatch — `bridge-events.js` owns that.
- `bridge.on('connected')` seed — `startup.js` owns that.
