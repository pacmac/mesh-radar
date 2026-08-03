---
module: doors
source: src/doors.js
source_hash: f8391fa27a811b991412deae6e3c001c4240127847eb8fdff231bb55c5124557
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

## Three ways to know a door

| source | evidence |
|---|---|
| `known` | this target answered before, so `route[0]` of that success literally carried it |
| `relay` | never answered, but its packets **reach us** through a relay — `MeshPacket.relay_node` |
| `dominant` | neither — use the relay that carries most of our traffic |

## `relay` — the byte we were already storing and never read

`relay_observation.relay_byte` is `MeshPacket` field 19, written on **every**
received packet including from nodes that have never answered a traceroute. It
had 18,670 rows and its own index, and nothing read it. `doors.js` inferred
doors from `traceroute_history.route` instead — which is populated **only on
success**, so it can only ever describe targets that already answered.

That is the circularity trap in `/mesh-trends`, and this module was in it.

**Measured, no leakage** — for each completed traceroute only relay observations
strictly *before* it may form the prediction, and both predictors are scored
identically on the same rows:

| | micro (n=53) | macro (23 nodes) |
|---|---|---|
| inbound relay byte → `route[0]` | **83.0%** | **71.7%** |
| always the dominant door | 49.1% | 41.3% |

Not comparable to the 63% above — that is exact-node scoring on a different set.
Within this test, like for like, the byte wins by ~30 points.

### Resolving the byte to a node

`relay_node` is a **low byte**, so it names 4.64 candidate nodes on average
across all 946 known nodes. Constraining candidates to nodes that have **ever
been `route[0]`** collapses that: 17 doors over 16 distinct bytes, with exactly
one collision (byte `4`: 2039 routes vs 10) broken by usage count.

A door is therefore resolved as: modal non-zero `relay_byte` for this target →
the known door sharing that byte → most-used on a tie. No match, no `relay`
source; fall through to `dominant`.

### Measured effect on aiming: NONE, today

Applied to all 200 otherwise-unmodellable nodes, the door actually chosen is:

| door | km | nodes |
|---|---|---|
| `fir` | 13.1 | 167 |
| `T4` | 5.3 | 32 |
| `TA2o` | 0.5 | 1 |

**`needsBeam` is true for 0 of 200.** Every resolved door is inside the omni's
proven reach, so `mission-runner.js:588` returns `az: null` and does not rotate —
exactly as before. The prediction is better; the behaviour is identical.

The hope that motivated this — that a distant node would resolve to one of the
far doors (`E1` 48.4 km, `EX4E` 43.8, `RDEw` 42.2) and finally give the yagi
something to do — **did not survive contact with the data**. Those far doors
serve nodes that already answer, and are reached by `known`, not `relay`.

What is banked: the door is now right 83% of the time instead of 49%, a wrong
constant is gone, and the moment a target does resolve to a far door the beam
engages on evidence rather than on a guess. What is not banked: any change to
where we point today.

### What this is NOT

`relay_byte` records who relayed **to** us. The door we aim at is **outbound**,
and routing is 62% asymmetric, so this is evidence and not proof. It was also
validated only on nodes that *did* answer, and is applied to 200 that never
have — those may differ systematically. `source: 'relay'` is carried in the
return so a caller (and the log) can tell inferred from observed.

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
