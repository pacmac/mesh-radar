---
module: traceroute-status-feed
source:
  - src/traceroute.js
  - src/ws-relay.js
source_hash: d6ac3cf71a90a8fb619216b789971884dfefb3e6be045a9bd8eed32a182dfe8e
updated: 2026-09-03
---

# `traceroute_status` — the whole state of a traceroute, over WS

## His words, 2026-08-18

> "traceroute needs a ws status feed that can be subscribed to, i.e by the radar"

> "it needs more than that, it needs the aim angle, radio being used, if it is
> via a bearing or node, the remaining secs / ms to timeout, we have a lot of
> known data no point in keeping it a secret!"

> "if s/ms to timeout is tricky then a timestamp instead"

> "we know everything about what its doing, what radio it is using etc etc.
> whether or not all of it will be consumed is irrelevant."

**The governing rule for this payload: emit everything known.** Not what a
consumer currently reads — what the process actually knows at that instant. A
field left out because "nothing uses it yet" is the reason a defect takes a
database query to diagnose.

## Not a subscription

`ws-relay` broadcasts every feed to every client; there is no subscribe
mechanism. Peter, on that: *"if we are not using subscriptions, then that is
another issue."* Recorded separately as `park-ws-has-no-subscription-mechanism`
and NOT solved here. This emits; consumers listen for the type.

## Phases

```
resolved → aiming → aimed → dispatched → answered
              ↘ aim_failed                  ↘ timeout | send_failed
```

An omni skips `aiming`/`aimed` entirely and goes `resolved → dispatched`.

**`aim_failed` is terminal and means NOTHING WAS TRANSMITTED.** It is the state
that did not exist before 2026-08-18, because a failed aim used to be recorded
and ignored — which is how 303 YAGI attempts went out across 246 distinct
azimuths spanning 0.85–359.98°. A consumer showing "aim refused, rotator held by
another user" is the single most useful thing in this feed.

## The payload

```jsonc
{
  "type": "traceroute_status",
  "id": 7,                       // correlates the phases of ONE run
  "phase": "aimed",
  "ts": 1787033000,

  "target":  { "num": 80054436, "label": "GZG", "bearing_deg": 202, "km": 41.2 },
  "radio":   { "label": "YAGI", "node_id": "!39f7b6", "mac": "F4:12:…",
               "beam_deg": 35, "directional": true, "steerable": true,
               "rotator_id": "F4:12:…" },
  "aim":     { "mode": "relay",            // node | relay | via | bearing | none
               "source": "derived",        // derived | via_node | via_bearing
               "target_num": 3608510722,   // null for a bearing
               "target_label": "T4",
               "az_requested": 219, "az_arrived": 217,
               "settled": true, "note": null },
  "timing":  { "started_ts": 1787032998, "timeout_ms": 45000,
               "deadline_ts": 1787033043 },
  "rotator": { "az": 217, "busy": false, "held": true },

  "result":  { … },              // answered only
  "error":   { "reason": "…" }   // failure phases only
}
```

### Every field already exists at emit time

| block | where it comes from |
|---|---|
| `radio` | the bundle `resolveRadio()` already returns |
| `aim` | what `decideAim()` returns, plus `az_arrived`/`settled` from `aimAt()` |
| `timing` | `entry.startedAt` and the effective timeout, both already held by `dispatch()` |
| `rotator` | `rotator.status`, already read for `rotator_az` on stored rows |
| `result` | the result object `handlePacket()` already builds |

Nothing here needs a computation that is not already done. This is a **reporting**
change, not a behavioural one.

### `deadline_ts`, not a ticking countdown

Peter offered the timestamp himself when asked, and it is the better primitive:
one value, emitted once per phase, and **no browser timer**. A live countdown
would otherwise be derived in the browser — forbidden, *"NO TIMERS, NO POLLING
FULL STOP"* — or pushed once per second from `served-time.js`, which is real work
for a nicety.

Both `timeout_ms` (the budget) and `deadline_ts` (the instant) are served, so a
consumer can render either a static deadline or a proportion without deriving
anything over time. Adding served per-second updates later is additive and does
not change this shape.

### `aim.source` is separate from `aim.mode`

`mode` says WHAT it aimed at; `source` says WHO chose it. Collapsing them loses
the ability to tell an operator override from the rule firing, which is precisely
the question asked when a run looks wrong. `via_bearing` also answers Peter's
"if it is via a bearing or node" directly, without inspecting `target_num`.

## What it must NOT do

- **Not ride `radar_context.focus_node`.** That field carries the ROTATOR's
  target and was renamed on 2026-08-17 for exactly the reason it must not be
  overloaded again.
- **Not double as the history feed.** History is `GET /traceroute_history`.
  `route_discovered` previously served both the radar animation and the perf
  table, and drifted.
- **Not be radar-shaped.** Peter: *"consumed by the browser and maybe others."*

## Replay on connect

A client connecting mid-trace must not be blind until the next transition, so the
current status of everything in `_pending` is replayed on connect, exactly as
ws-relay already does for other state. Nothing in flight means nothing sent.

## Test notes

1. Every phase emits exactly once per run, in order, sharing one `id`.
2. An omni run emits `resolved → dispatched → …` with no aim phases.
3. A refused aim emits `aim_failed` and NO `dispatched`.
4. `deadline_ts - started_ts` equals `timeout_ms`.
5. `aim.source` is `via_bearing` when `via_bearing` was given, `derived` when not.
6. Live: subscribe to `/events` and watch a real traceroute's phases arrive.
