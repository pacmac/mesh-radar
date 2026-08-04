# mt-frontier / mt-miner — founding specification

**Status:** handoff document. Written inside node-dash (task
`split-readiness-audit`, 2026-08-04) to seed the new repository. A fresh session
working inside that repo builds from this spec; this file is copied there as
`SPEC.md` and becomes the repo's root contract. Same pattern as
`docs/RADAR_SCOPE_SPEC.md`.

Peter, 2026-08-04: *"I am talking about the entire app, everything to do with
observatory, mining, hooks, the UI into a new repo, not bits of it."*

**One sentence:** the instrument that mines a mesh's own traffic for what it
proves, and spends a strict airtime budget trying to reach further than it ever
has.

---

## Why it leaves

It has outgrown its host. Measured 2026-08-04: **~7,200 lines** across 13 backend
modules and 2 browser files, against a node-dash whose job is a gateway
connection, a store, and a dashboard.

More importantly it has a *different contract*. node-dash is a live view of a
mesh. This is an **experiment that transmits** — it holds a daily airtime budget,
a channel-utilisation brake, a record it is trying to beat, and a set of standing
analyses that must keep running whether anyone is looking or not.

## What moves

| module | lines | role |
|---|---|---|
| `inferences.js` | 1032 | candidate scoring, the class ladder, the reach model |
| `standing-tasks.js` | 961 | 14 workers — miners over the store |
| `mission-runner.js` | 750 | the discovery loop; owns dispatch and aim |
| `observatory-ws.js` | 624 | the WS feed for its own page |
| `observatory.js` | 358 | fact store, inference runner |
| `callout.js` + `callout-runner.js` | 439 | public callouts (ships disabled) |
| `passive-tracer.js` | 278 | opportunistic tracing |
| `doors.js` | 258 | where a packet actually leaves from |
| `hooks.js` | 190 | the emission taxonomy |
| `observations.js` | 141 | reception facts |
| `relay-observation.js` | 62 | per-packet relay capture |
| `snr.js` | 45 | quarter-dB decode, backend only |
| `public/app-observatory.js` | 1096 | its UI |
| `public/partials/tab-observatory.html` | 972 | its UI |

`_mockup-mission-control.html` (556) goes too — it is this app's design reference.

## What it needs from node-dash — the seam

Measured by import, not guessed:

```
db.js          x11   the store
utils.js       x3    haversine / bearing
node-filter    x3    ownDeviceNums
dash-mode      x3    which radio is TX / RX for the current mode
traceroute     x2    dispatch            <-- AIRTIME
node-label     x2    display labels
ws-relay       x1    registerWsWiring / registerConnectReplay
rotator        x1    aim                 <-- PHYSICAL
node-list      x1    the live node cache
mesh-send      x1    transmit text       <-- AIRTIME
device-config  x1    per-radio config
feature-flags  x1
```

**This is not a read-only consumer.** It transmits, it moves an antenna, and it
depends on mode state. The interface is therefore a *control* API, not a data
feed, and that is the single most important fact in this document.

## The boundary it must respect

Four capabilities cross the seam, and each carries a rule that already exists and
must survive the move:

1. **Storage.** 11 of the 22 imports. See "the database question" below.
2. **Transmit** — `traceroute.dispatch`, `mesh-send`. Carries the **daily airtime
   budget** (derived from the store so it survives restarts — B75), the
   **channel-utilisation brake**, and the **backoff for targets that never
   answer** (26.6% of 30 days of attempts bought nothing before it existed).
3. **Aim** — `rotator.point()` is a negotiation: *are you free, move now, maybe
   hold; if not, wait or tell me to try again in x ms*. It is a **shared**
   antenna — the alarm uses it too — so the new repo can never assume ownership.
4. **Mode** — `dash-mode` owns which radio transmits and which listens. The
   observatory asks; it does not decide. This rule was ignored once and hid
   passive tracing for 9.5 hours.

**PRIMARY transmission remains Peter's product decision, not the app's.** Callouts
ship disabled and stay that way until he says otherwise.

## The database question — decide this first

`db.js` is imported 11 times and is the hardest part of the split. Three options:

- **shared file** — simplest, and two processes writing one SQLite file needs WAL
  discipline and a clear owner per table. Cheap to start, easy to regret.
- **the observatory owns its own store** and node-dash feeds it receptions over
  the existing WS. Cleanest boundary; requires deciding who owns
  `traceroute_history`, which both currently write.
- **node-dash exposes a data API.** Most work, and it makes every query a round
  trip — bad for the miners, which sweep whole tables.

Recommendation: **own its own store, subscribe to receptions.** The tables that
would move are already this app's: `obs_fact`, `event_log`, `relay_observation`,
`message_status_event`, `callout_log`. The contested one is
`traceroute_history` — and since the observatory both *dispatches* traceroutes
and is their only serious consumer, it should move with it, leaving node-dash's
perf page to read it over the API or lose it.

## Rules the new repo inherits

These were learned expensively and must not be re-learned:

- **State that resets on restart is a bug.** The airtime budget, the passive
  tracer's cooldowns and the `ownDeviceNums` guard all failed this way. Derive
  from the store, never from an in-memory map.
- **A guard that fails open is worse than no guard**, because it reports
  compliance while exceeding.
- **The browser makes zero decisions.** Verdicts, classes, labels, colours and
  units are computed server-side. The wire format never crosses into the UI —
  see `src/snr.js` and why it is not in `utils.js`.
- **Finding nothing is a result.** Every worker reports its zero case explicitly;
  silence is indistinguishable from a broken worker.
- **A recording change looks exactly like a trend.** `signal_history` before
  2026-07-27 20:01 and `relay_observation` before 2026-08-03 both make earlier
  data look absent. Any new table needs an epoch consumers can filter on.
- **Test a model against a constant.** A bearing-matched door predictor scored
  32%; "always the busiest door" scored 63%.
- **Routers are not clients.** A declared `ROUTER` is infrastructure; 6 of them
  carry 95.1% of every route completed. `CLIENT_MUTE` can never be a door.

## Naming

`mt-frontier` if the record chase is the point; `mt-miner` if the analysis is.
The app does both, but only one of them transmits — and the transmitting half is
what carries the risk and the budget. **`mt-frontier`** is the more honest name
for what the repo owns.

## What node-dash keeps

Gateway connection, node tracking and storage, messaging, devices, rotator
driver, radar, perf, config. It stops knowing what a door, a mission, a
frontier or a worker is.

## First tasks in the new repo

1. Stand up the repo, copy this file to `SPEC.md`.
2. Decide the database question above — before any code moves.
3. Move the modules with their specs (`docs/modules/*.md` for each named module
   travels with it; they are the accumulated reasoning and are worth more than
   the code).
4. Define the control API for transmit / aim / mode as an explicit contract, with
   the airtime rules enforced on the calling side.
5. Only then move the UI.
