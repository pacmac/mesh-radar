---
module: doors
source: src/doors.js
source_hash: b4f091601b9cff9d23a8650523f31f5ab78950913580a095633a511dd34cdb84
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

### Resolving the byte to a node — candidates are AUDIBLE nodes, not past doors

`relay_node` is a **low byte**, so across all 946 known nodes it names 4.64
candidates on average. The candidate set must be narrowed, but narrowing it to
*nodes that have already been `route[0]`* was a **bootstrap circularity**: a
relay had to already be a door to qualify as a door, so a relay we had never
routed through could never become one. That is the same trap this module was
built to escape, reintroduced one level down. Peter caught it.

The correct test is **audibility**, because being audible is what makes a node
usable as a first hop. Candidates are therefore the union of:

| source | meaning | n |
|---|---|---|
| `signal_history` | heard directly | 36 |
| `relay_observation` with `relay_byte = 0` | arrived unrelayed | 24 |
| ever `route[0]` | already served as a door | 17 |
| **union** | | **55** |

**Widening costs almost nothing.** 55 candidates over 47 distinct bytes, 7 of
which collide. Of the **7 bytes we actually observe as relays** (`2 4 20 80 176
177 180`) only byte `4` is ambiguous — and it already was. Byte `176` resolves
uniquely to **S2** (`!10596db0`, 30.1 km, az 227°), which carries 213 packets
from 71 nodes and was permanently excluded under the old rule.

Tie-break order, strongest evidence first:

1. most times used as `route[0]` — a proven door beats a merely audible node,
   which keeps byte `4` resolving to `!2d4cd04` (2039 routes vs 10)
2. most direct receptions — better evidence we can actually reach it
3. most recently heard

No candidate for the byte → no `relay` source; fall through to `dominant`.

**Measured**: observed bytes resolvable went **6 of 7 → 7 of 7**; byte `176`
newly maps to `!10596db0` (S2) and the other six are byte-identical, so nothing
regressed.

**And it still changes no aim today.** No node has `176` as its *modal* relay
byte — all 71 that reach us via S2 reach us more often via bytes `2` or `4`
(3065 and 1814 packets against 213). S2 is now selectable and is never
selected. Modal choice buries a minority relay even when it is the more useful
door, which is a second, separate limiter recorded as **B73** — not fixed here.

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

## Role: a router is infrastructure, not a destination (2026-08-04)

Peter, 2026-08-04: *"repeaters are gold dust to us"*, then, when the first design
proposed targeting them harder:

> *"we should not waste time tring to get replies from touters, but we need to
> use them for what they are and not treat them as just another endpoint which
> they are not"*

A `ROUTER` / `ROUTER_LATE` / `ROUTER_CLIENT` / `REPEATER` exists to carry other
people's traffic. Whether it personally answers a traceroute is close to
irrelevant — and 31 such nodes sit within 250 km having **never once** been our
`route[0]`, while the attempt budget went to ordinary clients (`79fc`, a CLIENT,
tried 88 times; `JRSY`, a live ROUTER 29 km past the record, tried 4).

So role enters **here**, in door selection, and explicitly **not** in the target
ranking (`docs/modules/inferences.md` records that rejected design).

### Where role applies

- **Candidacy.** `doorsByByte()` admits any audible node. A relay-capable node is
  a *better* door candidate than an audible client, because relaying is its
  declared function rather than an accident.
- **Disambiguation.** When a low byte matches several candidates, a relay-capable
  node now outranks a non-relay one before the direct/heard tie-breaks.
- **`CLIENT_MUTE` is excluded outright.** It never rebroadcasts, by
  configuration, so it can never be a door however loud or close it is. Admitting
  one would guarantee aiming at a node that cannot carry us.

### Order of evidence, revised

1. times used as `route[0]` — measured fact beats declared intent
2. **relay-capable role** — declared function
3. direct receptions
4. most recently heard

Observation beats declaration deliberately: a node that has actually carried our
traffic is better evidence than a role field claiming it would. This keeps byte
`4` on `!2d4cd04` (2039 routes) regardless of anyone's role.

### Measured: routers carry 95% of everything

Every door that has ever carried one of our completed routes, 2026-08-04:

```
T4     2044 routes  ROUTER          TE 5   26  ROUTER
fir     764 routes  ROUTER          E1     12  ROUTER
TA2o     82 routes  CLIENT_BASE     RDEw   10  ROUTER
TA2m     35 routes  unset           TivN    9  ROUTER

6 declared routers  ->  2865 routes  (95.1%)
11 observed relays  ->   148 routes  ( 4.9%)   — 4 of the 11 are our own radios
```

The distinction Peter drew is the dominant fact about our routing, not a
taxonomy exercise: **declared routers carry 95.1% of our traffic**, and the
"relays" that make up the remainder are mostly our own units talking to each
other. Preferring a router when resolving a door is therefore backed by where the
traffic actually goes, not by the role field's promise.

`doorAim()` returns `role`, `kind` (`router` | `relay` | `never`) and
`is_router`, so a caller can treat infrastructure differently from a node that
happened to carry one packet.

**Beware `role` as a data source**: three nodes carry `role = "200.0"`, a float
in an enum column, including one of our own bench units (B77). Junk falls through
to `kind: 'relay'`, which is the safe direction — it can never promote a mute
node to usable — but that is luck rather than design.
