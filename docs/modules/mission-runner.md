---
module: mission-runner
source: src/mission-runner.js
source_hash: bcff25c7ccb68633bac55e8202e8c7872a5120839764592971f5ba165f54441b
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

### The v4 does not always reach its target, and says so

```
started {"evt":"started","cmd":"seek2az","target":30}
done    {"evt":"done","cmd":"seek2az","az":7,"ok":false}
```

It accepted the command, moved, stopped **23° short** and reported the failure
honestly. (The v5 on `.195` is closed-loop on an encoder to 0.5° and would not
do this — it is currently unreachable.)

Treating `ok:false` as fatal meant **every mission deferred forever and the queue
never drained** — a full queue, zero attempts, and nothing anywhere saying why.

So a near miss is **accepted and named**. A 23° miss on a 35° beam still puts the
target inside the main lobe, and transmitting slightly off-boresight is
enormously better than not transmitting at all:

| miss | outcome |
|---|---|
| ≤ half beam | `aimed 31°` |
| ≤ full beam | `aimed 31° — 12° off, inside the 35° beam` |
| > full beam | deferred; the shot would prove nothing about the target |

One re-issue before judging — the v4 often lands closer on a second, shorter
move (measured: 7° on the first attempt, 30° on the second). A third would be
stubbornness.

**The azimuth recorded on the attempt is the one achieved, never the one asked
for.** Anything later reading `rotator_az` gets where the beam actually was.

### The feed survives a restart

`_recent` is in-memory and pm2 watches `src/`, so every edit emptied the table
and the panel announced *"no attempt has completed yet this session"* while the
runner was mid-stride. That reads as **nothing is happening** — precisely the
impression this panel exists to prevent, and precisely the complaint that led
here.

The attempts were never lost; they are rows in `traceroute_history`.
`observatory-ws` replays the 25 most recent **aimed** dispatches
(`db.recentAimedTraceroutes` — `rotator_az IS NOT NULL` is what distinguishes a
mission from a passive trace of whatever happened to arrive) so the feed opens
populated.

Seeded rows carry `seeded: true` and do **not** claim what they revealed. The
discovery counters are session state, and re-deriving them from storage would be
inventing history. They say what happened and when, and nothing more.

### A deferral leaves a trace

`[mission] deferred ?5C3: move failed: unknown` — without it the runner sat with
a full queue and zero attempts and there was nothing to explain it, because a
deferred mission never reaches `recent`. An invisible skip is indistinguishable
from a dead loop.

## Only in DISC mode

Mode owns every per-mode behaviour including which radio transmits (Peter's
standing rule), so the runner reads `dashMode` and idles in every other mode. See
`docs/modules/dash-mode.md`.

## Scheduling — rescheduled in a `finally`, and nowhere else

The first version called `_schedule()` on each of the five return paths inside
`_tick()`, and the timer ran `this._tick().catch(() => {})`. Any throw anywhere
in a tick was therefore swallowed **and** skipped every one of those calls: the
runner died permanently, silently, with a full queue. It managed exactly one
mission before stopping.

Peter, 2026-08-02: *"you see WIST is hard coded, it has made one attempt and
failed, but we have a whole list of targets dont we?"* — not hardcoded, but he
was right that it was stuck. Measured at the time: **queue 18, attempts 1, seven
minutes idle** with the rotator free.

A loop whose continuation depends on remembering to reschedule on every branch is
a loop that will stop. Now there is one `_schedule()` call, in a `finally`, and
failures are logged rather than discarded.

### It sticks with a target until the budget is spent

`attempts_per_target` was shipped in `67b45a9` and did **nothing**. Measured
2026-08-02 14:44: the previous 90 minutes were **22 targets, 22 attempts** —
exactly one each, the behaviour the setting was introduced to replace.

The cause was a bare `_queue.shift()`. The shortlist is only refreshed on the
15-minute recompute, and by then the target just attempted is inside its
30-minute cooldown and excluded, so a fresh set of ~15 different candidates
replaced it. The budget could never be spent.

The runner now **holds** a mission and its remaining shots, re-attempting the
same target each tick until either it answers or the budget runs out. The
cooldown still governs re-selection much later; it simply no longer governs the
burst, which is what it was accidentally doing.

**A reply ends the run early.** The budget exists to find out whether a path is
there; once it has answered there is nothing more to learn from hitting it
again, and the airtime is better spent on the next target.

**A deferral does not spend a shot.** If the beam was unavailable the target
stays in hand — nothing was tested, so nothing is charged.

Verified: node `1519572419` (191.4 km, +3.6 km step) received **six consecutive
attempts** between 14:51 and 15:06, against one-each before.

### Cadence is measured from the START of a tick

A mission can take three minutes of its own — up to 90 s aiming the beam, 90 s
waiting for a reply that never comes. Rescheduling from the *end* would silently
halve the configured rate. The next tick is scheduled at
`interval − elapsed`, with a 5 s floor so a long mission cannot immediately
trigger the next one.

## Settings come from the `discovery` key

`interval_sec` and `enabled` are read from `discovery`
(`docs/DISCOVERY_STRATEGY.md`) on **every tick**, so a change from the dashboard
takes effect on the next mission with no restart.

`aim_timeout_sec`, `timeout_sec` and `recent` stay in this module's own
`DEFAULTS` and are deliberately not exposed. They are protocol timing, not
policy — a setting nobody should be turning is not a setting.

## The beam is held while the shot goes out

`rotator.hold(hold_sec × 1000)` immediately after the aim lands, before dispatch.
Default 15 s — sized to the real reply window (a measured manual round trip took
**2.9 s**) rather than to the 90 s timeout, which would monopolise an antenna the
garage alarm also needs. `0` disables it.

**An off-beam shot is not charged to the target.** The azimuth is re-read at
dispatch, not trusted from the `done` event, and if the beam has moved outside
the beamwidth the mission is deferred without spending one of its attempts — it
tested nothing about the target, so charging it would be a lie. (B58.)

### The setting existed and did nothing, briefly

`cfg()` whitelisted only `interval_sec` and `enabled` from the `discovery` key,
so `hold_sec` read as `undefined` and no hold was ever sent — while the UI showed
the control and the config stored the value. Caught by watching the rotator's own
frames rather than trusting that the code path ran. The whitelist is now explicit
and complete for what this module reads.

Verified live: `ROTATOR held=true holdMs=14984 az=241` during a real mission.

### The off-beam guard reads the landing, not a status re-read

`aim.az` — the azimuth the rotator reported in its `done` event — is preferred
over `rotator.status.az`. The status frame is asynchronous and can lag a move;
the `done` event is the device's own statement of where it stopped.

Reading status instead cost eleven minutes of blocked missions: the guard saw a
mid-travel 141° against a wanted 219° that the rotator had already reached, and
deferred every attempt. A guard against firing off-beam is worthless if its own
input is stale.

## Rate## Rate

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
