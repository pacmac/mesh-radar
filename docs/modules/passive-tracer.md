---
module: passive-tracer
source: src/passive-tracer.js
source_hash: dfde13d24ae7970078b9c6314ab8e9e575bc08525518ca189988fe02f3a61971
updated: 2026-06-30
---

# Module: passive-tracer

## Purpose

Automatic traceroute scheduling for PASV mode. Listens to bridge `packet` events and
triggers a traceroute for each new remote node seen, subject to concurrency and staleness
guards. Delegates dispatch, timeout, and decode to `traceroute.js` (V2 path).

Does not decide which mode is active — it checks `dashMode.value` and only acts in
PASV mode (value 0).

## Responsibilities

- Register once as a bridge event listener via `init()` (called once at startup)
- Filter inbound packets: PASV mode only, not busy, not own device, not rotator, not MQTT
- Check per-node staleness via `_attempted`/`_failed` Maps and `nodeList._cache.last_traceroute`
- Enforce single-trace concurrency (`_busy` flag)
- Dispatch via `traceroute.dispatch` (V2) and track outcome in `_attempted` / `_failed`
- Emit `'tracing'` and `'traced'` events for ws-relay to broadcast to the browser

## Dependencies

- `bridge.js` — `bridge.on('event', …)` for packet ingestion
- `node-list.js` — `nodeList._cache` (staleness check) and `ownDeviceNums` (via node-filter)
- `dash-mode.js` — `dashMode.value` gate
- `db.js` — `getConfig` for `pasv_config`
- `node-filter.js` — `ownDeviceNums`
- `device-config.js` — `getRotatorAddress`
- `feature-flags.js` — `FF.SSOT_TRACEROUTE` gate
- `traceroute.js` — `traceroute.dispatch` (V2 path only)

## Public interface

```js
export const passiveTracer  // singleton instance of PassiveTracer

passiveTracer.init()        // register bridge event listener — call once at startup
```

## State

### Module-level (persist across bridge reconnects, reset on process restart)

| Field | Type | Description |
|---|---|---|
| `_attempted` | Map\<num, ts\> | Timestamp (ms) of last SUCCESSFUL trace per node |
| `_failed` | Map\<num, ts\> | Timestamp (ms) of last FAILED or timed-out trace per node |

### Instance

| Field | Type | Description |
|---|---|---|
| `_busy` | boolean | True while a trace is in flight; blocks new traces |
| `_pendingFrom` | num\|null | Target node num (V1 path only; V2 uses Promise `.finally()`) |
| `_timeout` | Timer\|null | V1 timeout handle; cleared on response or release |

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'tracing'` | `{ from: num }` | Dispatch starts |
| `'traced'` | result or empty result | Trace completes (success or failure/timeout) |

`'traced'` always fires, even on failure. On failure: `{ from, route: [], route_back: [], snr_towards: [], snr_back: [], relay_positions: {}, ts }`.

## Config keys (`pasv_config` object from db)

| Field | Default | Meaning |
|---|---|---|
| `stale_sec` | 1800 (30 min) | Re-trace if last success older than this |
| `stale_fail_sec` | 600 (10 min) | Retry backoff after a failed trace |
| `timeout_sec` | 60 | Passed to `traceroute.dispatch` as `timeoutMs` |

## Guard conditions (`_onEvent`)

A packet triggers a trace only if ALL conditions pass:

1. `ev.type === 'packet'`
2. `dashMode.value === 0` (PASV mode)
3. `!this._busy` — no trace currently in flight
4. `pkt.from` is non-null
5. `rxDevice` (`ev.addr ?? ev.device`) is non-null
6. `pkt.decoded.portnum !== 'TRACEROUTE_APP'` — don't self-trigger on responses
7. `!ownDeviceNums().has(pkt.from)` — not a local BLE radio
8. `rxDevice !== getRotatorAddress()` — don't transmit via the YAGI
9. `!pkt.via_mqtt` — MQTT nodes return NO_ROUTE immediately
10. `needsTrace(pkt.from) === true` — not within stale or fail-backoff window

## `needsTrace` logic

Returns `false` (skip) if any of:
- Last failure for this node is within `stale_fail_ms`
- Last success for this node is within `stale_ms`
- `nodeList._cache.get(from_num)?.last_traceroute?.ts` is within `stale_ms`

Returns `true` otherwise.

## V2 trace flow (SSOT_TRACEROUTE=true — current active path)

```
_trace(from_num, device)
  → this._busy = true
  → emit 'tracing'
  → traceroute.dispatch({ to: from_num, device })
      .then(result)  → _attempted.set(from_num, now), emit 'traced' with result
      .catch(err)    → _failed.set(from_num, now), emit 'traced' with empty result
      .finally()     → this._busy = false, this._pendingFrom = null
```

## Invariants

- `init()` must be called exactly once at startup. Calling it twice registers duplicate listeners.
- Only one trace runs at a time (`_busy` flag). Subsequent packets during an in-flight trace are dropped — not queued.
- `'traced'` always fires after `'tracing'`, even on failure. ws-relay depends on this to clear the `passive_trace_start` UI state.
- `_attempted` and `_failed` are module-level Maps — they survive bridge reconnects but not process restarts. On restart, staleness falls back to `nodeList._cache.last_traceroute.ts` from the DB.
- **v1 defect**: `rxDevice = ev.addr ?? ev.device ?? null` uses the v1 `device` field. After bridge.js v2 alignment, this must become `ev.__ble_addr`.
- **Encapsulation leak**: `needsTrace` reads `nodeList._cache` directly (private Map). This should be replaced with a public `nodeList.getLastTraceroute(num)` accessor when node-list.js is refactored.

## Test notes

- **happy path**: `init()` → mock bridge emits packet in PASV mode → `'tracing'` fires → `traceroute.dispatch` resolves → `'traced'` fires with result; `_attempted` set
- **busy lock**: trace in flight → second packet → `'tracing'` fires only once; second dispatch not called
- **staleness skip — success**: `_attempted.set(num, now)` → next packet for same num → `needsTrace` returns false → no dispatch
- **staleness skip — failure**: `_failed.set(num, now)` → next packet within stale_fail_ms → skipped
- **failure path**: `traceroute.dispatch` rejects → `'traced'` fires with empty result; `_failed` set
- **guard conditions**: each of the 10 conditions can be tested in isolation; failing any one prevents dispatch
- **not PASV mode**: `dashMode.value = 1` → packet arrives → no trace initiated
- **TRACEROUTE_APP self-skip**: packet with `portnum = 'TRACEROUTE_APP'` → no dispatch (prevents re-triggering)
- **via_mqtt skip**: `pkt.via_mqtt = true` → no dispatch

## Out of scope

- Traceroute dispatch mechanics, timeout, and decode — `traceroute.js` owns those
- Mode selection — `dash-mode.js` owns that
- Broadcasting to browser — `ws-relay.js` listens to `'tracing'`/`'traced'` events
- Active scan traceroute — `active-tracker.js` / `index.js` own that
- V1 legacy path details — to be deleted when `SSOT_TRACEROUTE` flag is removed
