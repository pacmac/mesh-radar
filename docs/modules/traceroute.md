---
module: traceroute
source: src/traceroute.js
source_hash: f0ae3f4dc24920081d4160ef17c03cd04dedf59be48d4745811c1bed8c729a8f
updated: 2026-06-30
---

# Module: traceroute

## Purpose

Single owner of the entire traceroute lifecycle. Dispatches requests via bridge REST,
decodes responses, enriches relay positions from nodeinfo, persists results, and
broadcasts events. Mode logic (which node to trace, when, from which device) stays
entirely in the caller — this module is mode-agnostic.

Active only when `FF.SSOT_TRACEROUTE === true`.

## Responsibilities

- Send a traceroute request to the gw via `bridge.post('/{device}/traceroute', { to })`
- Deduplicate concurrent dispatches to the same node (share one pending entry)
- Enforce per-key cooldowns supplied by the caller
- Time out pending dispatches after a configurable timeout (default: `pasv_config.timeout_sec * 1000`)
- Decode `TRACEROUTE_APP` packets and extract `route_discovery` fields
- Extract `relay_positions` from `nodeinfo` for each relay num in the route (SSOT — previously duplicated in index.js and passive-tracer.js)
- Persist results via `nodeList.setTraceroute`
- Emit `'start'`, `'result'`, `'cancel'` events for all subscribers

## Dependencies

- `bridge.js` — `bridge.post` for sending the traceroute request
- `node-list.js` — `nodeList.setTraceroute` for persistence + in-memory patch
- `db.js` — `stmts.getNodeinfoByNum` for relay position lookup; `getConfig` for timeout

## Public interface

### Singleton

```js
export const traceroute  // instance of TracerouteManager
```

### Methods

```js
// Dispatch a traceroute request. Returns a Promise that resolves with the result
// or rejects on timeout or send error.
traceroute.dispatch({ to, device, timeoutMs?, cooldownMs?, cooldownKey? })
// → Promise<result>

// to         – target node num (required)
// device     – BLE MAC of the dispatching radio (required)
// timeoutMs  – override; default from config 'pasv_config.timeout_sec' * 1000 (fallback 60000)
// cooldownMs – reject immediately if cooldownKey was dispatched within this window
// cooldownKey – opaque key for cooldown tracking; typically the target node num

// Feed an inbound packet to the traceroute handler.
// Ignores non-TRACEROUTE_APP packets. Called by index.js for every bridge packet.
traceroute.handlePacket(pkt, rxDevice)
```

### Result shape

```js
{
  from:            number,    // sender node_num
  route:           number[],  // relay nums towards target
  route_back:      number[],  // relay nums on return path
  snr_towards:     number[],  // SNR readings on forward path
  snr_back:        number[],  // SNR readings on return path
  relay_positions: object,    // { [num]: { latitude_i, longitude_i } } — nodeinfo lookup
  ts:              number,    // Date.now() at decode time (ms)
}
```

## State

| Field | Type | Description |
|---|---|---|
| `_pending` | Map\<to_num, entry\> | In-flight dispatches. `entry = { callbacks: [{resolve, reject}], timer }` |
| `_cooldowns` | Map\<cooldownKey, number\> | Timestamp of last dispatch per cooldown key |

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'start'` | `{ to, device }` | A new dispatch begins (not fired when joining an existing pending entry) |
| `'result'` | result object | Every completed traceroute — fired for all subscribers regardless of which mode triggered it |
| `'cancel'` | `{ to }` | Dispatch times out or `bridge.post` rejects |

## Invariants

- **Deduplication**: multiple concurrent `dispatch` calls for the same `to` share one pending entry. Only the first caller sends the request; all callers resolve/reject together when the response arrives or the timer fires. `'start'` fires only once per node per pending cycle.
- **Cooldown**: if `cooldownKey` was dispatched within `cooldownMs`, `dispatch` rejects immediately with `Error('cooldown: <key>')` without sending a request or adding to `_pending`. The cooldown timestamp is recorded at dispatch time, not at response time.
- **Timeout default**: falls back to `getConfig('pasv_config.timeout_sec', 60) * 1000` if `timeoutMs` is not passed.
- **Response keyed by `pkt.from`**: `handlePacket` resolves the pending entry for `pkt.from` (the responding node), not `pkt.to`. A response from an unexpected node has no pending entry and is still persisted and broadcast.
- **relay_positions SSOT**: `extractRelayPositions` is the single call site for converting route node nums to lat/lon pairs. It reads from `nodeinfo` at decode time and stores null for nodes without known positions.
- **No mode logic**: callers decide which node to trace, from which device, and with what cooldown. This module does not distinguish ACTV, PASV, SCAN, or manual API calls.
- **Storage always happens**: `nodeList.setTraceroute` is called for every valid TRACEROUTE_APP response, even if no `dispatch` was pending for that node.

## Test notes

- **happy path**: `dispatch({ to, device })` → mock bridge responds → `'result'` fires → Promise resolves with correct result; `nodeList.setTraceroute` called
- **deduplication**: two concurrent `dispatch({ to })` calls → one bridge.post sent → both Promises resolve with same result; `'start'` fires once
- **timeout**: dispatch with `timeoutMs: 50` → no response → after 50 ms `'cancel'` fires → Promise rejects with timeout error; entry removed from `_pending`
- **cooldown**: dispatch with `cooldownMs: 1000, cooldownKey: 'x'` twice in quick succession → second call rejects immediately; bridge.post called once
- **send failure**: `bridge.post` rejects → `'cancel'` fires → Promise rejects with same error; pending entry cleaned up
- **handlePacket non-traceroute**: packet with different portnum → returns immediately, no state change
- **handlePacket no pending**: response arrives for node with no pending dispatch → `nodeList.setTraceroute` still called; `'result'` still fires; no error
- **relay_positions**: route contains nums with known nodeinfo lat/lon → `relay_positions` populated; nums without nodeinfo → omitted

## Out of scope

- Deciding which node to trace — callers own that (active-tracker.js, passive-tracer.js, index.js API handler)
- Scan contact confirmation — scanner.js / index.js own that
- Broadcasting to browser — ws-relay.js listens to `'result'`/`'start'`/`'cancel'` and broadcasts
- The V1 legacy traceroute path — that is the `if (!FF.SSOT_TRACEROUTE)` blocks in index.js and passive-tracer.js, to be deleted once V2 is proven
