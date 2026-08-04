---
module: traceroute
source: src/traceroute.js
source_hash: 272859d95a97e93cf2157f301151b1813fe3b24173e10d01908ba45405c8e4f0
updated: 2026-08-03
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

## Diagnosing a timeout

Task `timeout-diagnosis`.

In the 24 h to 2026-08-03 this module wrote **639 `timeout` rows and 1 `send_failed`**. A
duty-cycle drop, a CSMA defer, a collision and a genuine silence all landed identically,
so the leading explanation for the measured collapse in answer rate — 57.2% (3-8 Jul)
falling to 6.0% (23-27 Jul) at under 25 km — could not be tested at all.

Three columns are stamped on every row, success and failure alike:

| column | source | meaning |
|---|---|---|
| `rtt_ms` | `Date.now() - entry.startedAt` | dispatch to reply, or dispatch to timeout |
| `channel_util` | the TRANSMITTING radio's last telemetry | how busy that radio saw the channel |
| `air_util_tx` | same | how much of its own airtime budget it had spent |

### The transmitting radio's own figures, not the maximum

`ourChannelUtil()` already existed but takes the MAX across our radios. That is the right
number for a global brake and the wrong one here: the question is whether **this** radio
was throttled when **this** packet went out. A busy OMNI tells us nothing about a YAGI
dispatch.

### These are last-REPORTED values, not instantaneous readings

Device telemetry is periodic. `channel_util` and `air_util_tx` are whatever that radio
last told us, which may be minutes old. They must never be described as measurements taken
at the moment of transmission. `air_util_tx` is a rolling percentage whose exact window
the firmware does not publish, and this spec does not assert one.

### Where each path gets them

- **Success** — `handlePacket()` already holds `pendingEntry` before it calls
  `nodeList.setTraceroute()`, so RTT is available at the existing single persistence call
  site. The fields ride `result`, which `setTraceroute` already spreads into the insert.
- **Failure** — `_recordFailure()` is called from the timeout and send-error handlers,
  both of which have `entry` in scope. It gains a `startedAt` parameter.

An **overheard** result — a traceroute reply with no pending dispatch of ours — has no
start time and no transmitting radio. All three columns stay NULL. That is correct: we did
not send it, so there is nothing to diagnose.

### First measurements, 2026-08-03

```
ok       to 1127986616   rtt 26202ms  chan 12.1  airtx 3.35  3 hops  OMNI
timeout                  rtt 60001ms  chan 12.8  airtx 1.98          YAGI
timeout                  rtt 60002ms  chan 22.8  airtx 3.31          OMNI
```

Coverage since the change: **10 of 10 rows on both paths**.

Two things visible from the first ten rows:

- **Timeouts wait the full 60 s** (60001–60002 ms), so they are genuine silences rather
  than fast failures. That already rules out one class of explanation.
- **A 3-hop success took 26.2 s.** The passive timeout is 60 s (`pasv_config.timeout_sec`)
  and missions allow 90 s (`discovery.mission_timeout_sec`). If round-trip time scales
  anywhere near linearly with hops, a 6-hop path plausibly exceeds 60 s and would be
  recorded as a timeout while the reply was still in flight. **One sample is not a trend**
  and no conclusion is drawn here — but it is now measurable, which it was not before.

The two radios also report different `channel_util` at the same moment (12.8 vs 22.8),
which is why this is stamped per transmitting radio rather than taken as a global maximum.

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

---

## The rework: a function with args, not a radio command (task `traceroute-rework`, 2026-08-04)

Peter, 2026-08-04:

> the current logic of traceroute is wrong ... it needs to be able to do all of
> the things that we actually would do manually step by step

> Traceroute should be a function with args / opts, i.e radio/antenna to use,
> point at endpoint or known doors / routers

### The manual sequence IS the specification

Run by hand on 2026-08-04 against three targets. These are the steps, and three
of them exist nowhere in the code:

| step | today |
|---|---|
| 1. pick the target | callers do this |
| 2. resolve its **door** | `doorAim()` exists — **never executes**, see below |
| 3. choose the **radio** | implicit from dash-mode; not an argument |
| 4. **aim** at the door | computed then discarded |
| 5. **wait for the beam to settle** | **does not exist** — nothing waits |
| 6. dispatch | `dispatch({to, device})` |
| 7. await hops / timeout | exists |
| 8. **record what was aimed at** | **does not exist** — 56% have no azimuth at all |

Step 5 silently corrupts results: the first by-hand run probed while the rotator
was still slewing, at 170° instead of 219°, and that probe was void.

### Why door-aiming has never run

`mission-runner._aim()` computes `doorAim(target)` and then hits:

```js
if (!rotMac || !isTransmitterForMode(modeName(dashMode.value), rotMac))
  return { az: null, note: 'omni — not the rotator', wait: false };
```

Verified 2026-08-04: `isTransmitterForMode('disc', 'F4:12:FA:39:F7:B6')` is
**false** — DISC transmits on the OMNI, which is not on the rotator. The mission
runner is the only caller of `doorAim()`, and it only runs in DISC. So the door
bearing is computed and thrown away on every mission, and **aim-at-the-door has
never once executed.**

This is why the aiming data reads badly: the 10,537 "aimed" yagi attempts were
aimed at ENDPOINTS from other paths. Endpoint-aiming underperforms not aiming
at all, matched by distance. Door-aiming is untested, not disproven.

### The function

```js
traceroute.run(target, {
  radio:    'auto' | 'omni' | 'yagi' | <mac>,   // default: the mode's transmitter
  aim:      'door' | 'endpoint' | 'none' | <az>, // default: the mode's aim
  hold_ms,                                       // hold the beam through the reply
  settle_ms,                                     // max wait for the rotator to stop
  timeoutMs, cooldownMs, cooldownKey, manual,
  reason,                                        // why, for the log and the row
})
```

`dispatch({to, device, ...})` stays as a thin wrapper so nothing breaks in one
step; the four call sites move to `run()` in this task.

### The event contract — the radar animation is the feature

Peter: *"the beauty and refinement of the radar is it actually animates the whole
traceroute — the antenna aiming, the target node, and an animated route when it
is actively tracerouting."*

Today the aiming animation is fed by `rotator.emit('point_target')`, emitted
**only** by `active-tracker` in ACTV. Any path that aims without going through
the tracker — which is every other path — animates nothing.

`run()` emits the whole sequence, so every caller animates identically:

```
aiming  { target, az, via, via_name, source }   before the rotator moves
aimed   { target, az, settled }                 beam in position
start   { to, device }                          existing
result  { ... }                                 existing
cancel  { to, device, reason, row }             existing
```

`aiming`/`aimed` are NEW. `point_target` stays for ACTV's own tracker so nothing
regresses; `run()` does not depend on it.

### Aim provenance — so the asset can prove itself

Peter: *"just because yagi pointing has not resulted in any benefits in the last
few days of testing, it should not be removed, it is an asset."*

Agreed, and the reason it cannot be judged today is that we do not record what we
did. Measured 2026-08-04: **24,101 attempts, 10,537 with an azimuth (44%)** — and
none record *what* was aimed at, or how wide the beam was.

Four columns on `traceroute_history`, so a 3-element and a 7-element yagi stay
separable when the antenna is upgraded:

| column | meaning |
|---|---|
| `aim_mode` | `door` / `endpoint` / `none` |
| `aim_target` | the door's node num, when there was one |
| `beam_deg` | the transmitting antenna's beamwidth at that moment |
| `rotator_az` | **existing**, now written on EVERY dispatch including omni |

Migration guards on `PRAGMA table_xinfo`, not `table_info` — `table_info` omits
generated columns and re-`ALTER`s every boot, which took node-dash and DEV1 down
in a crash loop once already.

### Configurable, per Peter's constraint

> I am open to the suggestion that pointing MIGHT not be the best at the moment,
> but this must be configurable. likely yagi will go from its current 3 elements
> to 5 elements and 7 elements

- **per device** — `gain_dbi` and `beam_deg` already exist in `device-config.js`.
  `BEAM_WORTH_IT_KM = 40`, hardcoded at `doors.js:64` and duplicated as a literal
  at `standing-tasks.js:762`, becomes derived from them: more gain, worth using
  at shorter range. An element upgrade then changes the behaviour by itself.
- **per mode** — `aim` and `radio` join `rx`/`tx` in the mode definition,
  including `disc`, which has no entry on the Modes page today.
- **per call** — the same opts, overriding the mode.

`aim: 'none'` is a first-class setting, not a fallback. On present evidence a
3-element yagi at 9 dBi may not be worth rotating for; at 7 elements it will be.

## Files this task changes (Domain 1 only)

| file | change |
|---|---|
| `src/traceroute.js` | `run(target, opts)`; radio + aim resolution; settle wait; `aiming`/`aimed` events; `dispatch()` becomes a wrapper |
| `src/db.js` | 3 new columns + `table_xinfo` guard; `rotator_az` always written |
| `src/doors.js` | `BEAM_WORTH_IT_KM` derived from `gain_dbi`/`beam_deg` |
| `src/dash-mode.js` | `aim` and `radio` per mode, `disc` included |
| `src/config-api.js` | accept/validate the two new mode keys |
| `src/mission-runner.js`, `src/passive-tracer.js`, `src/lifecycle.js` ×2, `src/traceroute-api.js` | move to `run()` with explicit opts |
| `src/ws-relay.js` | broadcast `aiming`/`aimed` |

## Explicitly NOT in this task

- **Domain 2** — deleting the header TRACE switch, adding `disc` to the Modes
  page, the radar consuming `aiming`/`aimed`. CLAUDE.md forbids one task
  spanning domains; raised separately.
- **Removing `traceroute.enabled`.** The switch is wrong and Peter has said so,
  but deleting it while the mode definitions that replace it are still being
  built would leave a window with no way to stop automatic tracing at all.
  It goes with the Domain 2 task, once `aim`/`radio` per mode exist.
- **Dual-radio probing.** `_pending` is keyed by `to_num`, so two radios cannot
  probe one target concurrently. `radio: 'auto'` picks ONE. Concurrent dual
  needs that key changed to `(to, device)` and is its own task.
- **Simplifying the miner** to work with the radar. Peter's direction, and a
  large separate piece.
- Cosmetic radar work (closer nodes dimmer). Deferred by Peter explicitly.
