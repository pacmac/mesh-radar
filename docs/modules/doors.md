---
module: doors
source: src/doors.js
source_hash: 2889ae11d3f34f862d89901f3f8e654bae387b545fa2cf6fe454140f1cb1d835
updated: 2026-08-03
---

# Module: doors

## Purpose

Where the packet **actually leaves from**, as opposed to where the target is.

Peter, 2026-08-03: *"whatever happens I dont think we should be targeting remote
nodes directly. that is pointless (pun intended)."* Then: *"we are now aiming at
DOORS or, if all doors are comfortably in sight of OMNI using OMNI?"*

Both correct. Aiming at the target's own bearing puts the real first hop
**outside the 35° beam ~87% of the time**, in every distance band — 0–50 km 84%,
50–100 km 100%, 100–150 km 100%, 150 km+ 93%.

Measured on the live shortlist the moment this shipped: four targets at bearings
**34°, 226°, 227° and 35°** — and every one of them routes through the same door
at **274°**. Aiming at the target was not merely imprecise, it was pointing the
opposite way.

## Two ways to know a door

| source | evidence |
|---|---|
| `known` | this target answered before, so `route[0]` of that success literally carried it |
| `dominant` | no route for this target — use the relay that carries most of our traffic |

`dominantDoor()` is a **constant, not a model**, and that is deliberate. Measured
on a 70/30 time split: the busiest door predicts the actual first hop **63%**
exact, a bearing-matched relay **32%**, and aiming at the target **~13%**. The
clever model lost to the simple one; most traffic genuinely does leave the same
way. Live figure: `T4` carries **68%** of 2,029 completed routes.

## And the sting: the door needs no beam

`T4` is **5.3 km away**. A 9 dBi yagi buys nothing at 5.3 km that the omni does
not already have, so for most missions the beam is irrelevant wherever it points.

`needsBeam` is false below **40 km** — anchored to the furthest DIRECT contact
either radio has ever made (omni 43.0 km), so it is a measured threshold rather
than a chosen one. When it is false the runner does not rotate at all, which also
returns up to `aim_timeout_sec` to the mission.

## It returns null rather than falling back

When no door can be placed, `doorAim()` returns **null** and the caller must not
fall back to the target's bearing — that is precisely the behaviour being
replaced.

## Out of scope

- Which radio transmits — `dash-mode` owns that (`transmitterForMode`)
- Changing the shortlist — this only changes where the beam points
