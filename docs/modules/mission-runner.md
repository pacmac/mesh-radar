---
module: mission-runner
source: src/mission-runner.js
source_hash: 8bf0058a3d421c3e57e5b53a2709053e233625e3d059721363ad7c2613a9fb3d
updated: 2026-08-02
---

# Module: mission-runner

## Purpose

Runs one discovery mission at a time and **owns the traceroute while it does**.

Peter, 2026-08-02: *"the traceroute should be used by us, when a discovery is in
progress"* and *"if a traceroute was last done 4 days ago, then our entire page is
dead and old data. traceroute is our primary tool, we dont just use the
historical stats, when we are targeting a discovery / node we need traceroute!"*

## Why it exists

Every panel on the Observatory derives from `traceroute_history`. That table's
last real activity was **27 July** — `traceroute.enabled` was set false and the
attempt rate fell from ~1,000/day to 1. The board was reporting a five-day-old
mesh as though it were current.

And the prober it replaces was **reactive**: `passive-tracer` traces whatever it
has just heard. That is why 5,046 attempts went to 335 targets that have never
answered — we keep hearing them, so it keeps asking — while 213 positioned nodes
were never tried once. A reactive prober can only ever confirm the shape of what
already arrives. It cannot *pursue*.

## A traceroute is a survey, not a ping

This is the reason discovery gets the instrument. Measured 2026-08-02:

| | |
|---|---|
| relays we depend on | 79 |
| …never heard directly — **the route is the only evidence they exist** | 69 |
| …appearing **only on return legs** | 23 |
| …with no position | 21 |
| …absent from the `nodes` table entirely | 2 |

Plus per-hop SNR in **both** directions, on segments we can never measure
ourselves. One reply can name a relay, place it, draw two links and move the
record. That is what the activity table reports — not hit/miss.

## One owner at a time

`mission-runner` takes a lock for the duration of a mission. While it is held:

- `passive-tracer` yields — it must not spend the instrument on whatever
  happened to arrive while a chosen target is being pursued.
- A second mission does not start. Serial by design: two traceroutes in flight
  make the SNR attribution ambiguous and double the airtime for no extra
  information.

A **manual** traceroute is never blocked. `traceroute.dispatch({manual:true})`
bypasses the master switch already, and a person asking is always more important
than the schedule.

## It aims before it fires

The first version did not, and it showed: a 234 km attempt went out on the omni
with `rotator_az` null on the stored row. A directional antenna pointed at
nothing is a *worse* antenna than an omni, not a better one.

`reach.mission` now carries the target's `bearing` (already computed by
`reach.target`, simply not forwarded). Before dispatch the runner calls
`rotator.point(bearing)` and **waits for the device's own `done` event** — no
polling, no tolerance loop, no reimplementation of a point function the firmware
already has. See `docs/modules/rotator.md`.

`busy/held` puts the mission **back on the queue**. The YAGI is shared with the
garage alarm, which points it and holds it; firing an unaimed shot at a 234 km
target would spend the airtime and prove nothing.

A mission with no bearing does not aim and says so — it still goes out, because a
route to an unplaced node is exactly how we learn where it is.

Verified live: `WIST 234.2 km, bearing 11 → aimed 11°`, stored as
`tx F4:12:FA:39:F7:B6, rotator_az 10`. The YAGI, on the beam, at the frontier.

## Only in DISC mode

Mode owns every per-mode behaviour including which radio transmits (Peter's
standing rule), so the runner reads `dashMode` and idles in every other mode. See
`docs/modules/dash-mode.md`.

## Rate

One attempt every **180 s** (config `mission_runner.interval_sec`), ≈ 480/day
against the old ~1,000/day in bursts. Peter's *"not so much as to become a
nuisance"* (§1) with a number attached, and steady rather than bursty so the
mesh sees a constant trickle instead of a flood and then silence.

Per-target cooldown is the selector's, not this module's
(`docs/modules/inferences.md`).

## Boundary

**It does not import `observatory.js`.** That would be a fourth importer and the
boundary test permits three. `observatory-ws.js` — already an allowed importer —
feeds the shortlist in via `setQueue()` and broadcasts the activity events out.
The runner is a dumb executor: it is handed a list and it works it.

## Interface

```js
setQueue(missions)   // the shortlist, highest priority first
state()              // { enabled, running, current, recent[], discovered }
events: 'activity'   // emitted on every state change
```

## Invariants

- Never more than one mission in flight.
- A mission never dispatches while `traceroute.enabled` is false.
- Discovery counts describe what a route *revealed*, and are computed from
  stored state before the route is folded in — never after, or everything looks
  already-known.
- A failure is recorded and shown. §4: a miss is data.

## Out of scope

- Selection — that is `reach.mission` in the catalogue.
- The broadcast callout. Still unbuilt, still the contested instrument (§9).
- Anything the rotator does. A mission uses the mode's transmitter and does not
  aim; the antenna is shared with the garage alarm.
