---
module: traceroute
source: src/traceroute.js
source_hash: c6006a2c89e587e8ce1293f7ae33fed6586fb634ffe273bf51bc8c222f68d5d3
updated: 2026-07-27
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
| `'cancel'` | `{ to, device, reason }` | Dispatch times out (`reason: 'timeout'`) or `bridge.post` rejects (`reason: 'send_failed'`) |

## Invariants

- **Deduplication**: multiple concurrent `dispatch` calls for the same `to` share one pending entry. Only the first caller sends the request; all callers resolve/reject together when the response arrives or the timer fires. `'start'` fires only once per node per pending cycle.
- **Cooldown**: if `cooldownKey` was dispatched within `cooldownMs`, `dispatch` rejects immediately with `Error('cooldown: <key>')` without sending a request or adding to `_pending`. The cooldown timestamp is recorded at dispatch time, not at response time.
- **Timeout default**: falls back to `getConfig('pasv_config.timeout_sec', 60) * 1000` if `timeoutMs` is not passed.
- **Response keyed by `pkt.from`**: `handlePacket` resolves the pending entry for `pkt.from` (the responding node), not `pkt.to`. A response from an unexpected node has no pending entry and is still persisted and broadcast.
- **relay_positions SSOT**: `extractRelayPositions` is the single call site for converting route node nums to lat/lon pairs. It reads from `nodeinfo` at decode time and stores null for nodes without known positions.
- **No mode logic**: callers decide which node to trace, from which device, and with what cooldown. This module does not distinguish ACTV, PASV, SCAN, or manual API calls.
- **Storage always happens**: `nodeList.setTraceroute` is called for every valid TRACEROUTE_APP response, even if no `dispatch` was pending for that node.
- **Failures are recorded** (task `perf-honesty`, step 2): both dispatch
  failure exits (timeout, send error) insert a `traceroute_history` row via
  `insertTracerouteFailure` — `status` = `'timeout'`/`'send_failed'`,
  `from_num` = dispatcher node num (parsed from the `!hex` device id),
  `to_num` = target, `tx_device` = dispatching device, `rotator_az` stamped
  when the dispatcher is the rotator (same rule as results), payload columns
  NULL. One pending entry = one failure row regardless of joined callers.
  Success rows carry `status = 'ok'`. Without this, timeouts are invisible
  and every stat is survivorship-biased (the PCB-antenna incident).

## Test notes

- **happy path**: `dispatch({ to, device })` → mock bridge responds → `'result'` fires → Promise resolves with correct result; `nodeList.setTraceroute` called
- **deduplication**: two concurrent `dispatch({ to })` calls → one bridge.post sent → both Promises resolve with same result; `'start'` fires once
- **timeout**: dispatch with `timeoutMs: 50` → no response → after 50 ms `'cancel'` fires → Promise rejects with timeout error; entry removed from `_pending`; failure row inserted with `status='timeout'`, correct `tx_device`
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

## Per-device attribution (task `perf-per-device`)

Results are stamped with `tx_device` (the dispatching radio, from the
pending entry — marginTx/snrRx measure ITS TX/RX chain) and `rotator_az`
(live azimuth when the dispatcher is the rotator). Overheard results with
no pending dispatch stay unattributed (null).

## Identity rules (task `identity-phase-a`, per docs/IDENTITY.md)

- **gw addressing by MAC**: the dispatch URL path resolves
  `getLiveMacByNodeId(device) ?? device` — MAC is always valid; a bare
  node_id 404s pre-sync (`Unknown device`). The `device` PARAM keeps
  node-id vocabulary: it is the `tx_device` attribution key the perf page
  queries by, until Phase B migrates that column.
- **Rotator comparison in MAC space**: `getLiveMacByNodeId(device) ??
  device` compared against `getRotatorAddress()` (MAC) — the old
  node_id-side compare could never match a MAC-vocabulary device, so
  `rotator_az` was never stamped on PASV dispatches.
- **Failure `from_num`**: derived only from a `!hex` id (resolving a MAC
  through the registry first); never `parseInt` a MAC (yields 233). If
  unresolvable, 0 — honest unknown, not garbage.

## Identity Phase B — tx_device speaks MAC

`tx_device` is stamped as the dispatching radio's **BLE MAC** at the source
(result stamp and failure rows): the dispatch `device` param (node-id or
MAC) is resolved through the live registry once, and that MAC flows to
storage, the `route_discovered` WS event and REST. Unresolvable ids are
stored as given (never guessed).

## Phase C1 — events carry row identity

`'cancel'` payload is `{ to, device, reason, row }` where `row` is the
recorded failure row (with DB `id`). Results carry `id` (the history row
id returned by `nodeList.setTraceroute`) so WS consumers key live rows
exactly like replayed ones.

## Master switch — `traceroute.enabled` (task `traceroute-manual-enable`)

Before this, there was no mode in which automatic traceroute was off. Each mode
had its own dispatcher, so switching mode swapped the trigger rather than
stopping it:

| mode | dispatch site | trigger |
|---|---|---|
| PASV | `passive-tracer.js` | every qualifying heard packet |
| ACTV | `lifecycle.js` | `rotator.on('point_target')` |
| SCAN | `lifecycle.js` | `scanner.on('contact')` |

Measured while enabled: 8 dispatches in 10 minutes, 25 in 30 minutes.

`tracerouteEnabled()` reads the persisted config key `traceroute.enabled`
(declared in `config-api.js` DEFAULTS, so it survives restart and is broadcast
to the browser on the settings WS). Default `true` — shipping this changes no
behaviour until it is switched off.

### Gated at `dispatch()`, deliberately

`dispatch()` is the one chokepoint every caller passes through, so the gate
lives there rather than at each call site: a future caller cannot accidentally
bypass it. That is the failure mode that let `imap-receiver` and `op-manager`
post around `mesh-send`'s "single send path" — same shape, avoided here.

Checked BEFORE the cooldown guard. A gated dispatch must not consume the
cooldown slot, or re-enabling would silently skip the next attempt for that key.

### `manual: true` is never gated

A user-initiated request (`traceroute-api.js`) passes `manual: true`. Turning
automatic traceroute off must not disable *asking* for one. Verified live with
the switch off: the manual route returned `timeout !987ab80f`, i.e. it reached
dispatch and transmitted, rather than `traceroute disabled`.

### Known NOT covered

The `[V1] LEGACY` paths behind `FF.SSOT_TRACEROUTE` in `passive-tracer.js` and
`lifecycle.js` post to the bridge directly and bypass `dispatch()` entirely, so
they bypass this gate too. Dormant — `FF.SSOT_TRACEROUTE` is `true`. Recorded in
the bug ledger; removing them is a separate task.
