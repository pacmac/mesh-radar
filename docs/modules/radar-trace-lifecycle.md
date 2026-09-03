---
module: radar-trace-lifecycle
source:
  - public/app-radar.js
  - public/app-ws.js
  - public/app.js
source_hash: aaca8289abf08c9ca5d48faf41db05bd4a25342d2ce5c5cac268dc8bd6956068
updated: 2026-09-03
---

# A trace's visual lifecycle, and a UI timer that is in scope

## The problem Peter hit

> "there's no way to distinguish a traceroute in progress with one that succeeded"

And the cause, which was mine:

> "if the traceroute ends as soon as it is heard [that] would mean that the radar
> would never show a successful trace, but what it can do is to persist until the
> timeout is reached. that way the radar trace would go green until the timeout
> expires?"

A traceroute STOPS the instant the reply arrives — `traceroute.js:668` clears the
timer and resolves. So a trace answering in 12 s of a 45 s budget was drawn as
successful for the length of one redraw and then sat there indistinguishable from
everything else. The success state had no duration.

Three faults in what I had written, all mine:

1. **Green on a green radar.** The rings, nodes, labels and sweep are all green;
   "answered" vanished into the furniture.
2. **Success was DIMMER than in-progress** — opacity 0.55 against 0.95. The most
   interesting state was the faintest.
3. **The only strong signal was the dots stopping**, which is invisible unless you
   are watching at that instant.

## The lifecycle

```
dispatched   amber, dots animating          in flight
answered     BRIGHT GREEN, hop count        until deadline_ts
retired      quiet green                    stays as the last known path
timeout      quiet orange                   (ends AT the deadline anyway)
aim_failed   quiet orange, immediately      nothing was transmitted
```

`retired` is a BROWSER-SIDE visual state, not a feed phase. Nothing is removed —
Peter: *"should a finished trace disappear on its own - no, because then I can see
the last traceroute."* It only stops shouting.

## Why a `setTimeout` is legitimate here

Peter, 2026-08-18, scoping the standing rule after I over-applied it:

> "NO TIMERS, NO POLLING FULL STOP - that is related to DATA polling, of course
> the browser can have timers for exactly this reason. BUT any such timer cannot
> be a trigger or event that is outside the scope of the UI."

The test is what the timer TOUCHES, not that it exists:

- **Forbidden** — a timer that fetches, or that DERIVES a value the server owns
  (an age, a countdown, a "remaining"). `_sigTick++` re-aging a "5s ago" label and
  the OTA countdown from `deadline - Date.now()` are both this.
- **Allowed** — a timer whose whole effect is a presentation transition on data
  already served, and which triggers nothing outside the UI.

The instructive case is the `_passiveTraceTimer` deleted on 2026-08-17: 30 s, then
clear a highlight. It LOOKED cosmetic. It was the browser deciding when a
measurement had gone stale, using a number nobody served it — a data judgement in
a UI costume.

This one is the opposite shape. **The deadline is `timing.deadline_ts`, served on
every event and derived from Peter's own `traceroute.timeout_sec`.** The server
decides when; the timer only executes it. That is also why there is no
persistence constant in `public/` — inventing one would put the judgement back in
the browser, and Peter has ruled on invented timings before: *"stop setting
arbitrary timings and stop hard coding timings ... what is the basis for your 5
second calculation."*

## Implementation notes

- One timer per run, keyed by the feed's `id`, cleared and replaced if that run
  emits again. Cleared on tab-leave so nothing fires against a torn-down radar.
- Scheduled from `deadline_ts - now`, clamped at 0 — if the answer arrives after
  the deadline (clock skew, a late reply), it retires immediately rather than
  scheduling into the past.
- ONLY `answered` schedules one. A timeout already ends at the deadline, and a
  failure has no window to represent.

## Test notes

1. A trace answering early stays BRIGHT until `deadline_ts`, then goes quiet.
2. The bright state is brighter than in-flight, not dimmer.
3. Nothing is removed at any point — the path persists after retiring.
4. No timer is left behind when the run is superseded or the tab is left.
5. `grep` finds no hard-coded persistence duration in `public/`.
