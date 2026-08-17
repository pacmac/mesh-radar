---
module: served-time
source:
  - src/served-time.js
  - src/ws-relay.js
source_hash: e8b237f841ae7a0b48ca841f130a82576ea1c074fdb6058f9d19814a5d65ab68
updated: 2026-08-17
---

# Module: served-time

## Purpose

Every "5m ago" and every countdown on the page, served as a finished string and
pushed **at the instant it changes** — so the browser never runs a timer and
never computes the passage of time.

Peter, 2026-08-13, having said it repeatedly before: **"NO TIMERS, NO POLLING
FULL STOP. WS OR NOTHING"**, then **"EVENT DRIVEN NOT POLLED"**.

## The two things this replaces, and why both were wrong

**In the browser — six timers deriving values.** `docs/BROWSER_CONTRACT.md` already
forbade this, and `src/coulomb.js:119` said so in the code, but the rule was read
as being about GET polling so the timers were classed as harmless UI ticks. They
are not: each one CALCULATES, which is the presentation-layer violation by a
different route.

| browser timer | what it derived |
|---|---|
| `public/app-range.js:19` | `remaining` from `endsAt - Date.now()` |
| `public/app-ws.js:320` | OTA countdown from `deadline - Date.now()` |
| `public/app.js:423` | `_sigTick++` @1 s, to re-age the yagi signal label |
| `public/app.js:424` | `_rangeTick++` @60 s, the same for range |
| `public/debug.html:403` | a wall clock @500 ms |
| `public/app-perf.js:82` | POSTs traceroutes on a browser clock — NOT this task, see Out of scope |

**On the server — two 1 s polls.** `nodeStatusAgeTimer` (`ws-relay.js:1042`) and
`coulombAgeTimer` (`:1079`) already pushed re-aged strings, which was the right
instinct and the wrong mechanism: they woke every second, recomputed, compared,
and discarded the result when nothing had changed. **A tick that compares and
discards is a poll**, wherever it runs. For a two-hour-old reading that is 3,600
wakes to produce one change.

## The mechanism — a scheduled transition, not a cadence

`fmtAgo` (`src/format.js:95-102`) changes its output at instants that are a pure
function of the timestamp:

```
s < 60      "Ns ago"    changes every    1 s
s < 3600    "Nm ago"    changes every   60 s
s < 86400   "Nh ago"    changes every 3600 s
otherwise   "Nd ago"    changes every 86400 s
```

So the next transition is **computable, not discoverable**. Schedule exactly one
timer for it; on firing, push the new string and schedule the next.

| age of the fact | polled @1 s | scheduled |
|---|---|---|
| 30 s | 30 wakes, 30 changes | 30 wakes, 30 changes |
| 2 hours | 3,600 wakes, 1 change | **1 wake, 1 change** |
| 3 days | 86,400 wakes, 1 change | **1 wake, 1 change** |

Zero wasted wakes at every age. That is the definition of event-driven being
applied: the event is "the rendered value changes", and we wake for it and
nothing else.

## Public interface

`src/served-time.js`

```
nextAgoTransition(ts, nowSec?) -> number      seconds until fmtAgo(ts) changes
nextUntilTransition(ts, nowSec?) -> number    the same for fmtUntil
scheduleAge(ts, onChange, fmt?) -> stop()     one timer, rescheduled per transition
```

`scheduleAge` never fires on an unchanged value; there is no comparison in the
caller because there is nothing to compare. `stop()` is idempotent and MUST be
wired to `ws.once('close', …)` — a socket that closes with a pending timer keeps
a closure alive per dead connection.

## Invariants

- **No fixed-cadence timer anywhere in this path.** If a future edit adds a
  `setInterval` here, the mechanism has been reverted, not extended.
- **The browser holds no timer and no timestamp arithmetic.** It renders the
  string it was handed. `public/` is Domain 2 and is NOT touched by this task —
  see the task order below.
- **Server-side is where time passes.** The browser may not compute elapsed time;
  the server must. That asymmetry is the contract, not an exemption.
- **A future instant uses `fmtUntil`, never `fmtAgo`** — `fmtAgo` clamps with
  `Math.max(0, …)` so a countdown would read "0s ago", i.e. "the unit is awake
  right now", the exact opposite of the truth (`format.js:104-114`).

## State

One timer per socket per aged value, cleared on `close`.

## Events emitted

`node_status_age` and `coulomb_age` keep their existing shape — same type names,
same fields — so no consumer changes. Added: `range_timer_age`, `signal_age`, and
`deadline_text` folded into the existing `ota_progress`.

## Test notes

`tests/test_served_time.mjs` — pure, no socket:

- `nextAgoTransition` at each boundary: 59 s → 1 s, 60 s → 60 s, 3599 s → 1 s,
  3600 s → 3600 s. The off-by-one at each edge is the whole point of the file.
- a scheduled chain over a faked clock produces exactly one push per change and
  never a duplicate string.

## Out of scope

- **`public/` — every browser timer stays until the Domain 2 task.** Deleting
  them before the server pushes would freeze every age and countdown on the page.
  Order is forced: this task, then the deletion.
- **`app-perf.js:82`** — a browser tab scheduling mesh TRANSMISSIONS. Closing the
  tab stops them; two tabs double them. It needs the discovery-runner treatment
  in its own Domain 1 task and is not an "age".
- `debug.html`'s wall clock — Domain 2, dies with the others.
