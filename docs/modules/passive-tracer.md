---
module: passive-tracer
source: src/passive-tracer.js
source_hash: 84b4eccf565f7c20c866fa26cd8056380da0f3dbab57b9ca339ca7e9a339fdec
updated: 2026-08-04
---

# Module: passive-tracer

## Purpose

Automatic traceroute scheduling for the modes that permit it. Listens to bridge `packet`
events and triggers a traceroute for each new remote node seen, subject to concurrency and
staleness guards. Delegates dispatch, timeout, and decode to `traceroute.js` (V2 path).

Does not decide which mode is active, and **does not decide which modes it runs in** —
it asks `passiveTracingAllowed(dashMode.value)`. Today that is PASV and DISC.

Whatever the active mode, this module always uses **PASV's radio roles** and never moves
the rotator. It replies through the radio that heard the packet (`tx: 'rx'`).

It does **not** follow that it never touches the YAGI: the `pasv` `rx` default is
`'non-rotator'`, but the stored `mode_config` override on this host sets `pasv.rx = 'all'`
(verified 2026-08-02), so a packet heard by the YAGI is traced back out on the YAGI. See
`docs/modules/dash-mode.md` § `passive` and ledger **B60**.

## Responsibilities

- Register once as a bridge event listener via `init()` (called once at startup)
- Filter inbound packets: mode permits passive (PASV or DISC), not busy, not own device, not a non-listener radio, not MQTT, no mission packet in the air
- Check per-node staleness via `_attempted`/`_failed` Maps and `nodeList._cache.last_traceroute`
- Enforce single-trace concurrency (`_busy` flag)
- Dispatch via `traceroute.dispatch` (V2) and track outcome in `_attempted` / `_failed`
- Emit `'tracing'` and `'traced'` events for ws-relay to broadcast to the browser

## Dependencies

- `bridge.js` — `bridge.on('event', …)` for packet ingestion
- `node-list.js` — `nodeList._cache` (staleness check) and `ownDeviceNums` (via node-filter)
- `dash-mode.js` — `passiveTracingAllowed(dashMode.value)` gate; `isListenerForMode('pasv', rxDevice)` (reception gate); `transmitterForMode('pasv', {rxDevice})` for the dispatch radio. The two role lookups stay pinned to `'pasv'` **deliberately** — they are this prober's own radio contract, not the active mode's. Resolving them from the live mode would hand passive `tx: 'rotator'` in DISC and fire an unaimed trace down the beam.
- `db.js` — `getConfig` for `pasv_config`
- `node-filter.js` — `ownDeviceNums`
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
2. `passiveTracingAllowed(dashMode.value)` — PASV or DISC. **Was `dashMode.value === 0`**,
   which switched passive tracing off entirely whenever DISC was selected: 17.0 traces/h
   answering 3.8% became 1 trace in 9.5 h on 2026-08-02, while DISC returned 0 for 132.
   No log line reported it, because the return is silent and upstream of every counter.
3. `!this._busy` — no trace currently in flight
4. `pkt.from` is non-null
5. `rxDevice` (`ev.__ble_addr ?? ev.addr ?? ev.device`) is non-null. `__ble_addr` heads the chain to match `persist.js` ("V2: __ble_addr is the device key on every event"); added 2026-08-02. It was **not** the cause of the starvation, but it was not a guess either: the invariants below already carried it as an open v1 defect ("after bridge.js v2 alignment, this must become `ev.__ble_addr`"), now closed.
6. `pkt.decoded.portnum !== 'TRACEROUTE_APP'` — don't self-trigger on responses
7. `!ownDeviceNums().has(pkt.from)` — not a local BLE radio
8. `isListenerForMode('pasv', rxDevice)` — the receiving radio is a PASV listener. Default role `'non-rotator'` (any radio except the YAGI), but **the stored `mode_config` on this host overrides it to `'all'`** — see ledger B60.
9. `!pkt.via_mqtt` — MQTT nodes return NO_ROUTE immediately
9a. `!missionRunner.dispatching` — a discovery packet is in the air
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
// device arrives as ev.addr (MAC = the radio that HEARD the node). PASV's
// transmitter role is 'rx', so transmitterForMode('pasv', {rxDevice: device})
// resolves it to that radio's node_id — the mode-SSOT replacement for the old
// inline getLiveNodeIdByMac(device) conversion. tx_device attribution is
// unchanged (identity-phase-a; Phase B migrates the column to MAC).
  → this._busy = true
  → emit 'tracing'
  → traceroute.dispatch({ to: from_num, device: transmitterForMode('pasv', { rxDevice: device }) })
      .then(result)  → _attempted.set(from_num, now), emit 'traced' with result
      .catch(err)    → _failed.set(from_num, now), emit 'traced' with empty result
      .finally()     → this._busy = false, this._pendingFrom = null
```

## It yields while a discovery is in progress

Peter, 2026-08-02: *"the traceroute should be used by us, when a discovery is in
progress."*

`if (missionRunner.dispatching) return;` — one line, before the staleness gate.

Spending the instrument on whatever happened to arrive is the reactive behaviour
that put **5,046 attempts into 335 targets that have never answered** (we keep
hearing them, so it kept asking) while **213 positioned nodes went untried**. A
reactive tracer can only ever confirm the shape of what already reaches the
antenna; it cannot pursue.

This module is not obsolete — between missions it still records the mesh as it
arrives, which is free evidence (spec §3). It is subordinate to a chosen target
rather than competing with one.

### `dispatching`, not `busy` — and why "subordinate" nearly meant "off"

The gate was written as `missionRunner.busy`, which is true for the **whole**
mission cycle: aim, hold, dispatch, timeout, and the ~18 minutes one target is
held across six attempts. That is not "a discovery is in progress", it is "a
discovery is queued", and it leaves almost no window.

`dispatching` is true only between the packet leaving and its reply or timeout.
That is the interval where sharing the air would actually cost something.

**This was not, however, what starved the tracer.** The `busy` gate was too wide
and is fixed here, but the measured collapse to zero came from the mode gate
above (guard 1) — `busy` never got the chance to block anything, because DISC had
already switched the module off wholesale. Recorded plainly because the wrong
cause was believed first, and the metrics in this spec were nearly attributed to
it.

## It declares the modes it runs in

Task `hooks-per-mode-scope`. This module is why the `per-mode` scope exists: its rule was a
bare `dashMode.value !== 0` buried in the consumer, and selecting DISC switched passive
tracing off wholesale for 9.5 hours with no log line and no consequence on screen.

```js
defineHook({
  name: 'passive-trace', scope: 'per-mode',
  modes: () => modesAllowingPassive(),      // lazy — see below
  purpose: 'traces a node on hearing it, in the modes that permit passive tracing',
})
```

The list comes from `modesAllowingPassive()` rather than being restated here. **Two lists
that can disagree is the same bug one level up.**

**It speaks when it skips**, latched on the mode so a quiet mode reports once rather than
once per packet (~20/min). Verified 2026-08-03 by switching DISC → PASV → DISC:

```
11:14:36  passive-trace    tracing in PASV
11:16:12  discovery-idle   not probing — mode is pasv, discovery only runs in DISC
11:19:12  discovery-idle   probing resumed (was: mode is pasv, discovery only runs in DISC)
11:19:13  passive-trace    tracing in DISC
```

### The modes list is LAZY, and that is not decoration

`modes` is a thunk. Passing `modesAllowingPassive()` directly evaluated it during module
load — this file imports `dash-mode`, which was still initialising — and threw
`Cannot access 'MODE_KEYS' before initialization`, **taking the whole service down on
2026-08-03**. `defineHook` now accepts a function and resolves it on first read, and
`modesAllowingPassive()` derives from `MODE_DEFAULTS` (top of file) rather than `MODE_KEYS`
(further down). Either fix alone would have worked; both are in place because the failure
mode is a hard outage rather than a wrong value.

## Invariants

- `init()` must be called exactly once at startup. Calling it twice registers duplicate listeners.
- Only one trace runs at a time (`_busy` flag). Subsequent packets during an in-flight trace are dropped — not queued.
- `'traced'` always fires after `'tracing'`, even on failure. ws-relay depends on this to clear the `passive_trace_start` UI state.
- `_attempted` and `_failed` are module-level Maps — they survive bridge reconnects but not process restarts. On restart, staleness falls back to `nodeList._cache.last_traceroute.ts` from the DB.
- ~~**v1 defect**: `rxDevice = ev.addr ?? ev.device ?? null` uses the v1 `device` field. After bridge.js v2 alignment, this must become `ev.__ble_addr`.~~ **CLOSED 2026-08-02** — the chain is now `ev.__ble_addr ?? ev.addr ?? ev.device ?? null`, matching `persist.js`. The v1 fields are kept as fallbacks rather than removed, because no measurement was taken of whether any live event still arrives without `__ble_addr`.
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

## Master-switch early return (task `traceroute-manual-enable`)

`tracerouteEnabled()` is checked alongside the existing `dashMode.value !== 0`
gate, before dispatching.

This is NOT redundant with the gate inside `traceroute.dispatch()`. The catch
attached to the dispatch promise records `_failed.set(from_num, ...)` and emits
a `traced` event with an empty route. If "disabled" arrived as a rejection,
every skipped node would be recorded as a FAILED traceroute and bogus empty
routes would be pushed to the browser. Returning early avoids that.

The two `lifecycle.js` dispatch sites need no equivalent: they use
`.catch(() => {})` and discard the rejection harmlessly.

## Backing off targets that have never answered (task `back-off-dead-targets`, 2026-08-04)

### The waste

`needsTrace()` gated on **time alone** — `stale_fail_ms` (600 s) since the last
failure, `stale_ms` (1800 s) since the last success. There was no notion of a
target that simply never replies, so any node we keep hearing was re-traced every
ten minutes indefinitely.

Measured over 30 days, split by dispatcher and by whether the target has *ever*
answered:

```
mission  has answered     8207 attempts   1429 ok   (17.4%)
passive  has answered     7301            1088      (14.9%)
passive  NEVER answered   3422               0
mission  NEVER answered   2185               0
```

**5,607 of 21,115 attempts — 26.6% — bought nothing**, and the passive tracer is
the larger half of it. One node absorbed **415** attempts; `79fc` took 88, of
which 66 were passive.

### Why a hard cap is the wrong fix

Attempt number at which a node *first* answered, across the 113 that ever have:

```
p50 1 · p75 6 · p90 16 · p95 24 · p99 70 · max 94
```

Half answer immediately, but the tail is long. A cap of 10 saves 3553 attempts
and **loses first contact with 16 of 113 nodes (14.2%)**; even a cap of 30 still
loses 6. Those are real contacts, and one of them took 94 attempts to arrive.

### Back off instead

After `pasv.dead_after_attempts` (default **10**) attempts with **zero** lifetime
successes, the retry interval becomes `pasv.dead_retry_hours` (default **12**)
instead of ten minutes. Nothing is ever abandoned: a node needing 70 attempts
still gets them, over weeks rather than hours, and the moment it answers once it
returns to the normal cadence permanently.

### Attempts come from the store

Counted from `traceroute_history`, not from the in-memory `_attempted` / `_failed`
maps — those reset on every restart, so a redeploy silently returned every dead
target to the fast cadence. Exactly the failure that made the airtime budget
meaningless (B75), and it was compounding here unseen.

### Projected effect

Applied to the last 30 days: **2810 passive attempts (13.3% of all traceroute
traffic)** were aimed at targets that would now be in the slow lane. At a 12-hour
retry instead of ~10 minutes those become roughly **39** — about **2771 attempts
of airtime reclaimed, with nothing abandoned**.

Verified discrimination on live data:

```
79fc   88 attempts,   0 ok  ->  SLOW LANE (12h)
STV2  137 attempts,   0 ok  ->  SLOW LANE (12h)
fir    23 attempts,  21 ok  ->  normal cadence
```

`lifetime()` reads the store and **logs loudly on failure**. Returning zeros means
"never back off", so a swallowed error would silently restore the entire waste —
the failed-permissive pattern that already produced B74 and B75. The `db` default
import was missing on the first pass and the catch would have hidden it.
