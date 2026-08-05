---
module: traceroute
source: src/traceroute.js
source_hash: 68442d0857d342d39d049e40de146718e1c550daad357009025d02bb04f8c8b3
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

## Master switch — REMOVED (commit 8ddd4a0, 2026-08-04)

`tracerouteEnabled()` and the persisted `traceroute.enabled` key are gone, with
all four call sites. Automatic tracing is a property of the MODE, not a second
global owner of the same behaviour: with the switch off, DISC ran and attempted
nothing, visible only as one line in an idle reason.

This section previously documented the switch as live. `check_specs.py` compares
SOURCE HASHES, not prose, so a spec can describe deleted code and still validate —
it did here for one commit. Recorded so the next reader does not trust a green
validator as proof the prose is true.

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

---

## Aim provenance II — the radio was never a MAC (task `aim-provenance-requested-az`, 2026-08-04)

Shipping the rework produced 73 aimed rows in under two hours — the first aim
provenance this project has ever held. Reading it back the same evening showed
the aiming had not actually been happening.

### The fingerprint

15 rows with `tx_device = 'F4:12:FA:39:F7:B6'` (the YAGI, whose stored config is
`beam_deg: 35`) recorded `beam_deg = 360.0`, and every one of them recorded
`aim_mode = 'none'`. The 6 rows that *did* aim recorded 35 correctly.

```
tx_device            aim_mode  beam_deg   n
E9:B0:3F:17:27:91    none      360.0     53    OMNI — correct
F4:12:FA:39:F7:B6    door       35.0      6    YAGI, aimed — correct
F4:12:FA:39:F7:B6    none      360.0     15    YAGI, NOT AIMED — the defect
```

### The cause: two device vocabularies, compared directly

`transmitterForMode()` (dash-mode.js:224) returns `macToNodeId(mac)` — a **node_id**
once ws-relay has registered the live resolver. `getRotatorAddress()` returns a
**MAC**. `_resolveAim` then does both of these with the value it was handed:

```js
const beam_deg = beamwidthFor(device);          // getDeviceCfg(node_id) MISSES
...
if (!rot || !device || device.toUpperCase() !== rot.toUpperCase())
  return { mode: 'none', ..., note: 'radio is not on the rotator' };
```

`getDeviceCfg` keys on uppercase MAC, so a node_id misses every entry and returns
`{...DEFAULT}` — whose `beam_deg` is **360**. And the identity compare
`'!39F7B6' !== 'F4:12:FA:39:F7:B6'` is always true, so the function returns
*"radio is not on the rotator"* **about the rotator's own radio**.

Reproduced with the live resolver registered:

```
getRotatorAddress()          = F4:12:FA:39:F7:B6   (MAC)
transmitterForMode('actv')   = "!39f7b6"           (node_id)
   getDeviceCfg(tx).beam_deg = 360                 <- beamwidthFor() returns this
   tx === rotator (line 181) = false               <- so it is NEVER aimed
```

**Every `radio: 'auto'` dispatch is unaimed, in every mode.** That is
`mission-runner` (the entire discovery loop) and both `lifecycle.js` sites. The 6
rows that worked came in as `radio: 'yagi'`, which resolves via
`getRotatorAddress()` and is therefore already a MAC.

`beam_deg = 360` was the fingerprint, not the disease. The logged bug
`BUG-yagi-records-omni-beamwidth` under-rated it: a cosmetic column error was
actually the discovery loop silently never pointing the antenna.

### Fix: resolve to MAC at the point of comparison, not at the point of transmit

A single `toMac()` helper, applied in `beamwidthFor()` and to both sides of the
rotator identity compare.

Deliberately **not** applied to the `device` passed on to `dispatch()`. That value
goes to the bridge REST call, and changing what the transmit path receives is a
separate risk with no bearing on this defect. The aim logic is made
vocabulary-correct; the send path is left exactly as it was.

### The second hole: only failures carried aim provenance

`handlePacket()` builds the success `result` with no `aim_mode`, `aim_target` or
`beam_deg` at all — `node-list.setTraceroute` maps all three, and they were always
null because nothing populated them. It also re-sampled `rotator.status.az` at
REPLY time, which is the exact defect already fixed on the failure path
(`_recordFailure`, traceroute.js:357-374).

So aiming could never be evaluated: the only outcomes that matter — the successes —
recorded nothing about the aim. Fixed by stamping all four fields from the pending
entry's aim context, and taking `rotator_az` from `az_actual` rather than a live
re-sample.

### The third hole: the row says where we ARRIVED, never where we AIMED

All 6 door-aimed attempts named the same door (`aim_target = 3608510722`), so the
requested azimuth was identical every time. Recorded arrivals:

```
218.0   219.0   79.0   221.0   107.0   217.0
```

Two of six landed 111-139 degrees away. With a 35 degree beam the target was
outside the pattern entirely — worse than not aiming, because the gain is pointed
at nothing.

That cannot be diagnosed from the stored row, because the row holds only
`rotator_az` (arrival). "Aimed badly" and "aimed correctly, then something moved
it" are the same row. The candidate causes — the neighbouring app's 15-second
hold, a stale `done` handshake, the re-aim retry's own arrival — are separable
only by comparing REQUESTED against ACTUAL on the same row.

**New column `aim_az_req REAL`**: the azimuth `_resolveAim` asked the rotator for.
`rotator_az` keeps its meaning (where it reported arriving). The pair is the
measurement; neither alone is.

### Changes

| file | change |
|---|---|
| `src/traceroute.js` | `toMac()` helper; `beamwidthFor()` resolves via it; rotator identity compare resolves both sides; `aim_az_req` on the failure row; success `result` carries all four aim fields and `rotator_az` from `az_actual` |
| `src/db.js` | `aim_az_req REAL` column, migration guarded on `PRAGMA table_xinfo`; both insert statements |
| `src/node-list.js` | map `aim_az_req` through `setTraceroute` |

### Invariants

- `aim_az_req` is what we ASKED for; `rotator_az` is what the rotator SAID it
  reached. Neither is ever derived from the other, and neither is ever sampled
  from live status after the fact.
- `beam_deg` is null when the device's beamwidth is genuinely unknown — never a
  guessed default. A 360 on a device configured 35 is a bug, not an omni.
- The transmit path's device value is untouched by this change.

### The fourth hole: `nodeList.get()` does not exist

Found while verifying the fix above. `bearingToNode()` opened with:

```js
const n = nodeList.get?.(num) ?? null;
```

`NodeList` has getters `homePos`, `nodes` and `ownDeviceNodes`, and **no `get(num)`
method**. The optional call `?.()` swallowed that: it evaluated to `undefined`
every time, so `bearingToNode()` returned null on every call and `aim: 'endpoint'`
could never aim. Verified by dispatching on the yagi with `aim=endpoint` and
getting `aim_mode='none'` back on a fully-positioned target.

This also invalidates the claim written in `run()`'s own header — that
endpoint-aiming *"underperforms not aiming at all in every distance band"*. It was
never measured against anything, because it never ran. The comparison has to be
made again now that both modes actually execute.

Fixed by reading `stmts.getNodeByNum`, the same `nodes` table `doors.js` reads, so
the two aim modes cannot disagree about where a node is.

### Verified 2026-08-04, same request before and after

`POST /!8cee336b/traceroute {"via":"!fa39f7b4","aim":"endpoint"}` — the yagi
addressed by NODE_ID, which is exactly the condition the discovery loop produces:

| | aim_mode | aim_target | aim_az_req | rotator_az | beam_deg |
|---|---|---|---|---|---|
| before | `none` | null | null | 216.01 | **360** |
| after  | `endpoint` | 2364420971 | **121.0** | 122.0 | **35** |

Three aimed probes on three different bearings, requested vs arrived:

```
req 121.0  actual 122.0  err 1.0
req  59.0  actual  58.0  err 1.0
req 202.0  actual 201.0  err 1.0
```

1 degree on every one — the QMC5883's stated +/-1 accuracy, and nothing worse.
The 111-139 degree misses recorded earlier are therefore NOT a property of every
aim; they need the requested-vs-actual pair over a longer run to characterise,
which is now being collected.

Regression: OMNI dispatches in the same window still record `aim_mode='none'`,
`beam_deg=360`, no azimuth — correct, the OMNI is not on the rotator.

## One aim per mission (task `mission-runner-single-aim`, 2026-08-04)

`mission-runner._aim()` points and holds the beam. `run()` then calls
`_resolveAim()`, which points it again at the same azimuth. Two rotator commands
per mission where one is correct.

The comment introduced with the rework justified it as harmless — *"run()
re-resolves and waits — the rotator is idempotent on an azimuth it is already
at"*. Idempotent is not free:

- it is a second command and a second hold on a **shared** rotator, widening the
  window in which the neighbouring app can take the beam BETWEEN our aim and our
  transmit;
- the two resolvers can legitimately DISAGREE. `_aim()` declines to move when the
  door is inside omni reach (`door.needsBeam === false`) and returns
  `az: null, wait: false`; `_resolveAim()` with `aim:'door'` has no such rule and
  will point anyway. So the mission's own "the beam is theatre at 5.3 km"
  decision was being silently overridden.

**Currently dormant, not fixed speculatively.** It fires only when the DISC mode's
`tx` is `rotator`. As of 2026-08-04 19:xx `disc.tx = 'primary'`, so `_aim()`
returns early ("omni — not the rotator") and `run()` resolves to the OMNI too —
neither aims. It DID fire between 17:18 and 18:30 today, which is when the six
door-aimed rows were written.

### Fix: `opts.aimCtx` — the caller may supply an aim it has already performed

`run()` uses a caller-supplied aim context verbatim and does not point again.
`_resolveAim()` is skipped entirely, not called-and-ignored, so no second
`rotator.point()` is issued.

Deliberately a passthrough rather than deleting `mission-runner._aim()`: that
function owns mission POLICY the traceroute layer has no business knowing —
whether the door is close enough that the beam is theatre, and whether a held or
short-stopping rotator should make the mission yield (`wait: true`). Moving that
into `run()` would put mission scheduling inside a dispatch function.

The aim context supplied must carry the same shape `_resolveAim` returns —
`{ mode, target, az, az_actual, beam_deg, settled }` — so the row records identical
provenance either way, and a reader cannot tell which path produced it.

## What the v4 actually does, measured (2026-08-04)

Seven aimed traceroutes over deliberately long slews, plus six bare moves, read
from the rotator's own `started`/`done` handshakes rather than from sampled status.

### Aiming, end to end

```
target  1st attempt   err   re-issue   err   outcome
   22   az 120 fail    98   az  18      4    IN BEAM
  202   az 131 fail    71   az 200      2    IN BEAM
   62   az  62 ok       0   —           —    IN BEAM  (short arc)
  274   az 178 fail    96   az 276      2    IN BEAM
  119   az 121 ok       2   —           —    IN BEAM  (short arc)
  351   az 276 fail    75   az  59     68    OUTSIDE
  242   az 154 fail    88   az 242      0    IN BEAM
```

First attempt inside the 35 degree beam: **2/7 (29%)**. After one re-issue:
**6/7 (86%)**. The re-issue is not a refinement — it is what makes the yagi
usable at all.

### The limitation is ARC LENGTH, not the compass wrap

```
from   target   arc    arrived   err   ok
 274 ->   330    56       33      63   false
  33 ->   351   -42      340      11   false
 340 ->    10    30       16       6   false
  16 ->   351    25      349       2   TRUE
 349 ->    20    31       20       0   TRUE
  20 ->   200   180      129      71   false
```

Arc <= 31 degrees: 3 of 4 landed within 6 degrees. Arc >= 56 degrees: 0 of 3
landed, each stopping 63-71 degrees short.

**351 across north succeeded on a 25 degree approach.** The repeated failures to
reach 351 earlier were therefore NOT a 0/360 wrap defect, which was the obvious
theory and the wrong one. Every failure observed was a long arc, and the re-issue
works precisely because the second move is a short one.

This is why `discovery.aim_retries` exists and why its default is 2: a long arc
needs more than one correction, and each correction is itself a short arc, which
the v4 handles well.

### Two methodology notes, because both nearly produced false findings

- `/rotator/move` is fire-and-forget. Polling `busy` after it returns reads the
  azimuth BEFORE the move starts, which produced a set of nonsense errors
  (a "175 degree miss" on a move that had not begun). The `done` handshake is the
  only trustworthy source, and it carries the arrived azimuth.
- The re-issue count read `getConfig('discovery')` directly, which returns only
  the STORED object — `aim_retries` was absent, so it evaluated to 0 and silently
  disabled re-aiming entirely, worse than the unconditional single retry it
  replaced. Fixed by `discoveryConfig()`; see below.

## `discoveryConfig()` — DEFAULTS were never the SSOT

Seven call sites read `getConfig('discovery', {})` raw, each carrying its own
literal fallback (`|| 15`, `|| 14`, `|| 180`). A key added to the DEFAULTS block
but never written by the settings form is ABSENT from the stored object, so the
engine could not see it until someone saved the form — and each consumer's private
literal could disagree with the declared default.

`discoveryConfig()` merges DEFAULTS under the stored value. All seven converted
except `db.js:1254`, which is left alone deliberately: `config-api` imports `db`,
so importing back would be circular. Recorded rather than worked around.

## The aim DECISION rule (task `finish-pending-phases` Phase 1, 2026-08-05)

Peter: *"right now traceroute still points at eps"*.

He was right, and it is the substance of the rework rather than a detail. Until
this, `_resolveAim` was a **flat switch on a static per-mode setting** — whatever
the config said, every time, regardless of what we know about the target. The
earlier work shipped the *instrumentation* (provenance columns, the MAC fix that
made aiming possible at all) and skipped the *intelligence*.

### Why aiming at the endpoint is wrong

Measured over **2,726** completed traces:

| | |
|---|---|
| first hop inside the endpoint's 35° beam | **12.9%** |
| first hop more than 135° away — behind the antenna | **53.4%** |
| mean separation, endpoint bearing vs first-hop bearing | **102.6°** |

We transmit to the **door**, not to the destination. The destination's bearing is
the wrong thing to point at.

### The rule — `aim: 'auto'`

```
1. known route, door FAR        -> aim at the DOOR
2. known route, door CLOSE      -> aim at HOP 2, if we provably reach it directly
                                   AND it is better aligned than the door
3. known route, close, no bypass-> DO NOT ROTATE. The beam is theatre.
4. no known route               -> aim at the ENDPOINT — not to follow a route,
                                   there isn't one, but as a bet on DIRECT
                                   contact, the only thing that creates a door.
```

Branch 2 is the one with a payoff: **155 cases** where hop1 points >90° away from
the endpoint, hop2 is better aligned, and we provably reach hop2 directly. PJ1
alone has 44 — endpoint 62°/3 km, hop1 T4 at 274°, hop2 WLCD at 62°/3 km.

The bypass may only target a relay in `provenDoors()` — one we have actually
transmitted to. Aiming at a relay we merely know about would be a guess dressed
as evidence.

Each branch records its own `aim_mode` (`door` / `bypass` / `endpoint` / `none`),
so the stored row says which rule fired.

### `'auto'` is now the default for ACTV and DISC

ACTV was `aim: 'endpoint'` — the measurably wrong strategy, in the mode most
likely to be pointing. Both now default to `auto`; the static modes remain as
explicit overrides for experiments.

### Verified 2026-08-05

| target | route | decision |
|---|---|---|
| RAK1 11 km | known, door close | `none` |
| WLCD 3 km | known, door close | `none` |
| GZG 47 km | known, door close | `none` |
| GARG 2.5 km | **none** | `endpoint`, az 121 |

Most outcomes are `none`, and that is correct: T4 (5.3 km) and fir (13.1 km) carry
89.7% of our traffic and both sit well inside `beamWorthItKm()`. The rule now
declines to spend the beam instead of pointing it at destinations.

**Still not observable in production:** DISC transmits on `primary` (the OMNI), so
`_resolveAim` returns "radio is not on the rotator" and the yagi never moves —
last 200 attempts, `aim_mode = none` 199 times. Branches 1–3 change nothing
visible until `disc.tx = 'rotator'`. That is an operator decision, not a code one.
