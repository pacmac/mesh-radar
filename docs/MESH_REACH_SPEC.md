# mesh-reach — founding specification

**Status:** founding spec. Written in node-dash (task `mesh-reach-founding-spec`,
2026-08-01) from Peter's redirection of the project's goal. **Nothing is built.
One structural decision (§9) must be answered before any code is written**, and
it decides which repository this lives in.

**One sentence:** stop measuring how far we can *hear*, and start measuring how
far we can *reach* — then attack the difference.

---

## 1. The change of goal

Peter, 2026-08-01, verbatim:

> "so far I have focussed the design around the radar, my goal was to always try
> and get further nodes directly, when in reality that's unlikely to increase a
> great deal because of my geographic location. the goal really is to see how far
> out into the known mesh I can get, and then focus our attention on it… meaning
> that we would do things like repetitive traceroutes and public bc messages
> … so we can at least get a reply or a bc so we can confirm we hit it… look deep
> into the mesh, gather data, find the x number of most remote locations, test the
> mesh and verify as a hit or a miss, and that is repetitive, we keep trying, but
> not so much as to become a nuisance. in a few words how far can we get"

The old question was **reception**: what can this antenna, at this location, hear
directly. It is bounded by geography and Peter is right that it is near its
ceiling.

The new question is **reach**: how deep into the mesh can a packet of ours travel
and be *confirmed* to have arrived. That is bounded by the mesh's own topology,
not by our horizon, and it is a far larger space. It is also asymmetric — their
hop count to us is not our hop count to them, and the return path is a different
route from the outbound.

**The gap between the set we can hear and the set we can reach is the product.**
Everything in this document exists to measure that gap and then close it.

## 1a. The headline value is kilometres

Peter, 2026-08-01: *"at the end of all calculations the single important value
will be in km."*

Hops are a proxy and a poor one — a seven-hop chain around a valley may cover
less ground than a two-hop shot across it. **Every calculation in this system
resolves to one number: the furthest distance at which reach has been
verified.** Hop count, SNR, route and bearing are diagnostics that explain the
kilometres; they are not the answer.

**The current record, computed 2026-08-01 23:43 from `traceroute_history` joined
to stored node positions, great-circle from `home` (51.0263296, −3.1588352):**

| | |
|---|---|
| **furthest verified reach** | **189.1 km** |
| verified beyond 150 km | 8 targets |
| verified beyond 100 km | 13 targets |
| targets ever verified | 104 |
| …of those, with a known position | 84 |

The far cluster is real and identifiable: **Carbis Bay and St Ives** in Cornwall
at 187.7 km, and a group of **Guernsey** nodes at 177–182 km. Most carry a single
confirmed hit — these are rare, fragile paths, not standing links, which is
exactly §4's point about reach being probabilistic rather than binary.

### The record ladder

The frontier's history is already in `traceroute_history` and reads as a ladder —
every moment the verified maximum moved, computed 2026-08-01:

```
24 Jun 10:59     5.3 km   Preston~Bowyer
24 Jun 11:42    24.7 km   Tiverton N Repeater G4ZA
24 Jun 11:43    43.0 km   M7FJD~Base
24 Jun 11:44    67.5 km   G0MOH Solar
24 Jun 12:01    92.0 km   Mr B's number 2
24 Jun 19:06    95.2 km   MrBs portable mesh
25 Jun 05:23   181.6 km   GCM0004 St Peters Village, Guernsey   ← first past 100 km
 4 Jul 15:43   189.1 km   (unnamed node 3663958688)
```

Peter's phrase for the 25 June entry — *"our first hit over 100 km"* — is the
right framing, and the ladder is the product's narrative. Note what it shows:
**the entire climb happened in about eighteen hours, and the frontier has moved
7.5 km in the five weeks since.** A system that iterates without learning
plateaus, and this is what the plateau looks like.

**Milestones are first-crossings and must be stored as such** — the first
verified hit past each threshold, with its target, route and timestamp. They are
derived from the event log (§5), never recorded separately, so a corrected or
retracted hit re-derives the ladder rather than leaving a false record standing.

**The binding constraint on this metric is position coverage.** Only 84 of the
104 verified targets have a position, and only 122 of 211 known nodes do. For the
rest the reach is real but the kilometres are unknown, and the honest headline is
therefore *"≥ 189.1 km verified"* — never a claim about the maximum. Improving
position coverage is a legitimate way to improve the headline number without a
single new transmission.

## 2. This is NOT green field — the machine already exists and does not learn

Measured 2026-08-01 from `data/node-dash.db` and the live radios. Every figure
here is from this repo's own stored data, not an estimate:

**The inventory exists.** The YAGI's nodedb, read live at 23:43, holds **211
nodes heard by RF**, zero via MQTT — every one of them a real radio path. **122
have a known position**, so a bearing and a distance are computable today. Hop
distribution:

```
hops:  0:6   1:24   2:42   3:49   4:24   5:23   6:28   7:11
```

**62 nodes sit at 5 hops or deeper.** That is the frontier, and it needs nothing
built to enumerate.

*These nodedb counts drift — they moved from 210/121 to 211/122 within the hour
this spec was written, as nodes are heard and time out. Treat them as the shape
of the problem, not as constants; re-measure before relying on any of them. The
`traceroute_history` figures below are stored history and do not drift.*

**The prober exists too, and has been running for five weeks.**
`traceroute_history` holds **21,793 attempts against 439 targets** since
2026-06-24:

| outcome | count |
|---|---|
| `timeout` | 18,273 |
| `ok` | 3,334 |
| `send_failed` | 186 |

A **15.3%** success rate. 9,818 of those rows already carry the `rotator_az` the
antenna was pointing at — so the "aim, then ask" instrument is also already
built and recording.

**And here is the finding that justifies this whole document.** Grouped by
target:

| band | targets | attempts | hits |
|---|---|---|---|
| >60% reliable | 8 | 1,146 | 855 |
| 25–60% | 19 | 3,415 | 1,382 |
| 5–25% | 52 | 8,209 | 1,012 |
| <5% | 25 | 3,977 | 85 |
| **never reached, not once** | **335** | **5,046** | **0** |

**5,046 transmissions — 23% of everything ever sent — were spent on 335 targets
that have never once answered.** Meanwhile 8 targets answer more than 60% of the
time. The machine is not selecting; it is iterating. It has no memory that
changes its behaviour.

**Its rate control is equally absent.** Attempts per day over the last week:

```
25 Jul   13     26 Jul  1045     27 Jul   958     28 Jul    1
29 Jul    4     30 Jul     1     31 Jul     0      1 Aug     8
```

Two modes: idle, or a thousand transmissions a day — roughly one every ninety
seconds, sustained. Neither is a design. Peter's "not so much as to become a
nuisance" has no implementation.

**So the work is not building a prober. It is giving the existing one a memory,
a policy, and a budget.**

## 3. What counts as a hit

Three instruments, answering different questions. They are not
interchangeable and the model must never merge them into one "success" column.

| instrument | proves | needs a human | cost |
|---|---|---|---|
| **traceroute reply** | a packet reached the node and a reply came back, with the path | no | one round trip |
| **broadcast callout + reply** | end-to-end reach *and* that a person saw it | yes | one TX + social capital |
| **passive reception** | they reached *us* — the opposite direction | no | zero |

**Traceroute is the workhorse.** Machine-generated, works at 03:00, returns the
actual route and per-hop SNR, and is repeatable without annoying anyone.

**The broadcast callout is the confirmation, used sparingly.** Peter's framing —
`@XXXX Hi, do you hear me?`, `Hello, any pong for me?`, varied and witty — is
correct in tone: it must read as a person being friendly, never as a bot
harvesting. Rules: never the same wording twice to the same node, never more than
one in flight, and a per-target cooldown measured in days.

**Passive reception is free evidence and must be mined first.** Every node we
hear tells us the inbound path works. It is not proof of outbound reach, but it
is proof the node is alive and roughly where, which is what makes an attempt
worth spending.

## 4. A miss proves nothing — the censoring rule

**This is the single most important statistical constraint and the model must be
built around it.**

Silence has at least four causes and the wire cannot distinguish them: the node
never heard us; it heard us and did not answer; it was asleep; the reply was lost
on the way back. With a broadcast there is the additional case of a human who saw
it and could not be bothered.

Therefore:

- The stored fact is **`verified reach ≥ X`**, never `unreachable`.
- A target with 30 failed attempts is recorded as *not yet verified*, with 30
  samples. It is never recorded as out of range.
- Repetition is what converts silence into a confidence interval. That is the
  legitimate reason to keep trying — not stubbornness.
- Any UI that renders a miss as a red cross is lying. It renders as *unconfirmed*,
  with the sample count beside it.

This is the same censored-data problem already flagged in the `perf-honesty`
task for signal margins, and the two should share vocabulary.

## 5. Store atoms, not tables

Peter: *"all of the data for that hit is needed and will be filtered and
tabulated in other useful ways that I have yet to think about."*

That sentence is the requirement. **Every attempt is stored as a raw immutable
event, and every table, score and chart is derived from those events at read
time.** Summarising at write time makes the questions invented in three weeks
unanswerable against three weeks of history — and this project's entire value is
the longitudinal record.

Minimum per attempt: target, timestamp, instrument, our TX radio, rotator azimuth
at the moment of transmission, the exact wording if a broadcast, hop count and
route claimed, what came back, elapsed time, and the outcome vocabulary as a raw
string (open, never a closed enum — same rule services gave us for their transfer
outcomes).

Nothing is ever updated in place. A later reply is a new row referencing the
attempt, not a mutation of it.

**Where this lives is settled in §7f: this is the `observations` store**, fixed
columns and append-only. It is not a mesh-specific table — an attempt, a
reception and a decision are all observations, and the engine that holds them
knows nothing about what any of them mean.

### What we record today — audited, not assumed

Peter, 2026-08-01: *"the target increases, a fairly simple loop, but what is
crucial is the amount of data we have for that."* Correct, and the audit is
stark. Measured against `traceroute_history`, 2026-08-01:

**A successful hit is richly recorded — every field below at 100%:**

| field | coverage on the 3,334 hits |
|---|---|
| forward route | 3,334 |
| **return route** | 3,334 |
| per-hop SNR outbound | 3,334 |
| per-hop SNR back | 3,334 |
| relay positions | 3,334 |
| TX / RX radio | 3,286 / 3,334 |
| rotator azimuth | **1,407 (42%)** |

Both directions of both path and SNR are already there, which means route
asymmetry — the thing that makes reach different from reception — is studyable
from existing history with no new transmissions.

**A failure records almost nothing.** Of the 18,459 non-`ok` attempts: route 0,
SNR 0, azimuth 8,411 (46%), TX radio 18,459. Timestamp, target, radio, sometimes
a bearing. That is the whole record of 85% of everything ever attempted.

**THIS IS THE CENTRAL DATA DEFECT AND THE REASON FIVE WEEKS TAUGHT THE SYSTEM
NOTHING.** All learning here is comparative — why did *this* attempt succeed when
*that* one did not — and a miss with no conditions attached cannot be compared to
a hit. The successes are over-documented relative to the failures by roughly two
orders of magnitude, and the failures are where the information is, because there
are five times as many of them.

**Requirement: a failed attempt is recorded as fully as a successful one.**
Everything knowable at transmit time is knowable whether or not a reply arrives —
antenna azimuth (and elevation/tilt if the rotator reports it), TX radio and
power, channel utilisation and air-time at that moment, the target's last-heard
age and last-known SNR, hop depth, and the §6 decision context. None of it
depends on the outcome, and none of it can be reconstructed afterwards.

## 6. Log the decision, not just the outcome

**This is what makes Peter's "hook my session in and analyse it in real time"
worth anything, and it is free on day one and impossible to retrofit.**

An outcome log says *"tried node X at 22:10, no reply."* Nothing can be learned
from that which is not already obvious.

A decision log says *"at 22:10 the candidate set was 47 nodes; these 12 were
excluded by cooldown; these 9 by the daily budget; the top 5 by score were …;
X won at 0.83 because it has been reached once, six days ago, via a relay that
answered 20 minutes ago; the antenna was turned to 118°."*

That second form makes the counterfactual inspectable. An analyst — Peter, or a
Claude session watching live — can then say *"you passed over a better target"*
or *"your scoring is over-weighting recency"*, which is exactly the collaboration
Peter described. Without it, an observer can only watch results scroll past.

**Requirement: every attempt row carries the decision that produced it — the
candidates considered, the exclusions applied and why, the scores, and the
winner's margin.**

A decision is itself an observation (§7f), not a special case: append-only,
immutable, and readable by any later inference that wants to ask why the
scheduler behaved as it did.

## 6a. The unit of work is a MISSION, not a target

Peter, 2026-08-01: *"so each target would effectively be a mission."* Correct, and
it is a better object than a row because it owns things a row cannot.

A mission has an **objective**, a **dossier** (every attempt with its route, door,
bearing and conditions), a **state**, a **cadence**, and — the part that matters
most — a **retirement condition**.

**The retirement condition is the fix for the worst number in this document.**
The 335 targets that consumed 5,046 transmissions and never once answered (§2)
are precisely what missions look like with no end condition: nothing was tracking
them *as* anything, so nothing could ever stand them down. A mission that has
failed forty times across six weeks, with no reception from that node in between,
goes dormant and stops spending airtime — and reopens automatically when the node
is next heard. That is not giving up; it is the difference between a campaign and
a stuck loop.

Mission types, because one undifferentiated queue is what produced §2:

- **Identify** — reached or heard, but unplaceable. The objective is a position,
  not contact. Costs little or no airtime. See §7c.
- **Confirm** — never reached. The only type that can move the record.
- **Re-confirm** — reached once, long ago. *Is 189 km still true?* Cheap, high
  value, and currently nobody's job.
- **Hold** — reached reliably. Sampled rarely, only to keep the reach map honest.
- **Door** — the objective is not the node but what lies behind it. Succeeds when
  something *new* becomes reachable through it (§7a).

A mission is also the UI's unit: it is what you click, and its dossier is the
whole story — every attempt, which door it went through, what the antenna was
doing, and why it was chosen that night (§6).

**The budget sits ABOVE the mission layer.** An operator will want to pin a
favourite and keep hammering it; a pinned mission must compete for airtime like
any other, never be exempt from it (§8).

## 7. Choose by expected information gain

A node hit five times this week teaches almost nothing. A node never reached,
whose neighbouring relay answered twenty minutes ago, teaches a great deal
either way.

The scheduler's question is therefore not *"whose turn is it"* but **"which
attempt would most change what we believe?"** Inputs available today: attempts
and hits per target, time since last attempt, time since last *success*, whether
a relay on its last known route is currently live, hop depth, distance and
bearing from `home.lat`/`home.lon` (51.0263296, -3.1588352), and whether the
antenna is already pointed near it.

The specific scoring function is deliberately **not** fixed here. It is the
research question, it will be wrong at first, and §6's decision log is what makes
tuning it possible. What this spec fixes is that a scoring function *exists* and
that its inputs and output are recorded on every attempt.

**Distance is the objective the score serves (§1a).** An attempt that could
extend the verified frontier in kilometres is worth more than one that confirms
ground already held — which means a node at 180 km with one stale hit outranks a
reliable neighbour at 12 km, and a node with *no known position* is a partial
unknown: reaching it proves reach but cannot move the headline until a position
arrives. That tension is real and the scoring function must take a deliberate
position on it rather than leaving it to fall out of the arithmetic.

The 5,046 wasted transmissions in §2 are what a scheduler without this looks
like.

## 7a. Clusters and doors — and it has to be visualised

Peter, 2026-08-01: *"that will grow to identifying and mapping & displaying
clusters, they are also opportunities into other clusters, but it has to be
visualised."*

**The cluster structure is already in the data and it is stark.** Every
successful hit stored its full relay chain, and `relay_positions` is populated on
100% of them — so the graph can be built *and drawn* with no new transmissions.
Parsed from all 3,334 successful routes, 2026-08-01:

**57 distinct relay nodes carry every route we have ever completed.** And a
handful dominate:

| relay | times used | targets behind it | furthest target |
|---|---|---|---|
| `T4` | 2,139 | 79 | 188 km |
| `fir` | 1,243 | 77 | 189 km |
| `TE 5` | 971 | 63 | 188 km |
| `S2` | 500 | 42 | 180 km |
| `TivN` | 216 | 35 | 182 km |
| `MDor` | 163 | 25 | 182 km |

**Our reach is not a radius. It is a tree with a few load-bearing doors.** 104
verified targets sit behind 57 relays, and three or four of those relays carry
almost everything. That reframes targeting completely:

- **A door is worth more than a target.** Reaching a node 180 km away that opens
  onto twelve unreached nodes is worth far more than confirming a thirteenth node
  behind a door we already hold. This is §7's information gain expressed
  topologically, and it should probably dominate the scoring.
- **Fragility is measurable and worth displaying.** If `T4` goes off air, 79
  targets go with it. A single relay failure can erase most of the frontier, and
  a record set through one door is more precarious than the number suggests.
- **The next frontier is the next door.** The productive question stops being
  "which distant node shall we try" and becomes "which reachable relay has the
  most unexplored mesh behind it".

**Visualisation is a requirement, not a nice-to-have, and Peter is explicit.**
Two views, and they answer different questions:

1. **The graph** — us, the doors, the clusters behind them. Shows structure,
   dependency and fragility. This is where "these two clusters are only joined by
   one relay" becomes visible, and it cannot be read off a table.
2. **The map** — the same thing laid on geography, using `relay_positions`.
   Shows *where* the doors are and therefore where to point the antenna, which is
   the direct input to §7's bearing choice.

Both are Domain 2 and neither may compute anything: cluster membership, door
ranking and fragility are server-computed per BROWSER_CONTRACT, and the browser
places what it is told. This is also the one place the existing radar work
carries over — a polar view of doors by bearing and distance is a natural fit for
`radar-scope`, if that is where it ends up.

**Not established:** what a "cluster" is, formally. The relay graph above is
evidence that clusters exist, not a definition of one. Whether they are best
derived from shared relay paths, geography, or both is a design question this
spec deliberately leaves open — and it should be answered against the graph
rather than by picking an algorithm first.

## 7b. The return path is free reconnaissance

Peter, 2026-08-01, on seeing that a route out and its route home did not match:
*"in/out routes dont match, do we know who his relay is? if not lets find him."*

**A traceroute reply carries the path the mesh chose to come back by, and nobody
had to hear it for us to learn it.** That is intelligence we did not gather; the
far side volunteered it.

Measured across all 3,334 successful routes, 2026-08-01:

| | |
|---|---|
| relays on outbound paths | 57 |
| relays on return paths | **69** |
| **return-only — never on a path we sent** | **23** |

**23 relays announced themselves by carrying our traffic home.** Nothing chose
them and no attempt was spent finding them.

The worked example is the 187.7 km record to St Ives on 17 July:

```
OUT   us → T4 → fir → TE 5 → L5-3 → Ives
BACK  Ives → PENS → L5-3 → TE 5 → fir → T4 → us
```

`PENS` is on the way home and on no outbound path we have ever sent. It is
`!a7df87aa`, *Pendoggett_Duel_Core_Solar* — north Cornwall — heard at −121 dBm,
3 hops, and **it has no position**, so it is absent from every map and every
distance calculation while being load-bearing on the return leg of our record.

**This softens, but does not overturn, §12's "we cannot see past our reception
horizon".** Route fields name nodes we never had to hear — so the horizon is not
absolute. The honest measurement today is that it rescues almost nobody: of every
relay appearing in any route, **zero** are known-but-never-heard, and only 3 have
no node record at all (`0xda576110`, `0x74d5f6f5`, and `0xffffffff` — the last is
the broadcast address appearing in a route field, which is a question about our
own parsing, not a node). The *mechanism* is real and grows in value as reach
extends: the further out we get, the more the returning packets describe
territory we cannot hear.

**Requirement:** relays are harvested from `route_back` as first-class discoveries,
recorded with the fact that they were found on a return path, and ranked as
candidate doors (§7a) exactly like outbound relays.

## 7c. Identify missions — a name with no place on the map

Reaching a node is not the only worthwhile objective. **Some nodes we already
reach are holes in the map**: they carry our traffic, we hear them, and we cannot
say where they are. They cannot enter a km calculation, cannot be drawn, and
cannot inform a bearing.

Six of the 23 return-only relays are in this state, measured 2026-08-01 — all
live, all close, all carrying traffic, none placeable:

```
Sn#2   Sion#2            3 hops  -106 dBm   heard 2.3 h ago
A-NL   A-NET Lily        2 hops  -111 dBm   heard 6.7 h ago
1a8c   IRIS              2 hops  -113 dBm   heard 18.9 h ago
J3BA   James3D-Base      1 hop   -120 dBm   heard 23.3 h ago
c3b0   Meshtastic c3b0   2 hops  -117 dBm   heard 154.6 h ago
ht01   Mesh_EX15 HT1     2 hops  -116 dBm   heard 309.3 h ago
```

**An identify mission costs little or no airtime.** Its objective is a position,
and the routes to it are: watch for a position broadcast we may already be
receiving and discarding; look for the node under another identity; or — for a
node whose operator is on the public channel — ask them, as a person. It is the
one mission type whose success does not require reaching anything.

## 7d. Places, not coordinates — and map *and* radar

Peter: *"we already have location street, town, city in a location func or
module… the possibility of not just radar at the top, but map and radar."*

**The geocoder already exists** — `src/geocode.js`, a queued Nominatim reverse
lookup at 1.1 s intervals, cached in `nodeinfo.address`. **194 of 596 positioned
nodes are already named**, so a third of the map is legible today and the rest is
a backfill, not a build.

It changes what a route *means*. The same record path, with addresses attached:

```
us → T4    Wiveliscombe Road, Milverton, Somerset
   → fir   Nicholashayne Lane, Wellington, Devon
   → TE 5  Ash Lane, Winsford, Somerset          ← on Exmoor
   → L5-3  (no position)
   → Ives  The Burrows, St. Ives, Cornwall
```

The corridor becomes a sentence: out through Milverton, down to Wellington, **up
onto Exmoor**, then the long jump to the Cornish coast. The door that carries the
record is a node on high ground — which a hop count can never show and a map
makes obvious.

**Elevation is not in our data and probably should be.** It is the likeliest
physical explanation for why a given relay is a door, and without it the map shows
*where* the corridors are while staying silent about *why*.

**Both views are required, because they answer different questions:**

- **Radar** — bearing and range from us. Egocentric. Directly drives where the
  antenna points (§7).
- **Map** — the mesh's own geography. Allocentric. Shows corridors, clusters and
  which doors sit on high ground.

Neither replaces the other, and a mission reads as a *place*: "St Ives, Cornwall
— 187.7 km, bearing 242°, through Exmoor", not "187.7 km @ 242°".

## 7e. The web — every route is a set of LINKS, and the end of it is a mesh map

Peter, 2026-08-02: *"when we have found a node that is relaying, we can see which
node was relayed to it and therefore its location, so we also know for any node
where it is and how far away it is, to stretch the 'spiderweb' overlay on a
map… we will end up with the data for a mesh map."*

**A route is not a list of endpoints, it is a chain of edges**, and we have been
storing them since June without reading them that way. `us → T4 → fir → TE 5 →
L5-3 → Ives` is five observed links, each one a node-to-node hop that some radio
actually made.

Extracted from every successful route, both directions, 2026-08-02:

| | |
|---|---|
| distinct node-to-node links observed | **359** |
| of those, both ends placed and drawable | **211** |
| total hop observations behind them | **18,826** |

That is a survey of the mesh's own topology, gathered as a by-product of asking
other questions.

### A second record, and a different one

Link lengths are computable wherever both ends are placed. The longest single
hops we have ever witnessed:

```
309.2 km   c21f — HELT      seen once
307.2 km   5d78 — HELT      seen once
202.0 km   fir  — (unnamed) seen 2x
199.4 km   TE 5 — c21f      seen 2x
178.6 km   c21f — TivN      seen 5x
```

**This is not our reach — it is the longest link the mesh made while we were
watching.** Both belong on the board, and they must never be added together or
confused: one is what *we* achieved, the other is what we *observed*. The two
300 km hops involve Guernsey nodes over a sea path, are single observations, and
fall squarely under the position-trust caveat in §12 — record them, flag them,
do not publish them as records.

### Constraining the unplaceable

**Peter's inference is right and needs one qualification.** A node that relayed
to a placed node must have been in radio range of it, so its neighbours bound
where it can be. Measured: **32 unplaced nodes have at least one placed
neighbour**, and some have many —

```
(unnamed)  24 placed neighbours
MDor       16   ← one of our own doors, currently "no position"
exw1       10
A2-B        9
031c        7
```

`MDor` carries traffic for 25 targets and cannot be drawn. With sixteen placed
neighbours it can be *estimated*.

**The qualification: this yields a REGION, not a point.** Radio range is not a
constant — the same mesh shows 3 km links and 300 km links — so one neighbour
constrains almost nothing and the estimate only tightens with several. Therefore:

- An estimated position is **an inferred fact** (§7f) — it lives in the facts
  bag, never written into the position a node reported for itself. Reported
  position is a fixed column; inferred position is a bag key. The separation is
  structural, not a matter of care.
- It carries its **error region** and the neighbour count it was derived from —
  as provenance, which §7f makes mandatory rather than optional.
- **It never enters the km headline** (§1a). A record must rest on a position the
  node claimed, not one we inferred — otherwise the frontier becomes a function
  of our own arithmetic.
- It is fine for drawing, for bearings, and for deciding where to point.

### What this becomes

The endpoint is not a reach dashboard with a map on it. It is **a survey of the
mesh**: which nodes relay and which are leaves, which links exist, how long each
one is, which are load-bearing, and which clusters are joined by a single hop.

Nobody had to be asked for any of it, and it accumulates on its own every time a
traceroute completes.

## 7f. The engine — observations, facts, inferences (a dedicated module)

Peter, 2026-08-02: *"we need to know everything about a node, including things it
does not tell us but we infer… as we uncover new pieces of valuable data, each
one would mean a schema change which is messy"*, *"we will continue to discover
new ones that need their own code to calculate… some kind of hooks design, so we
can add new functions to it rather than scattering them all over the code"*, and
*"this needs to be a dedicated new nodejs module… I dont want this code scattered
all over core, it has a distinct function / role."*

**Provisional name: `observatory`.** Not settled.

### The boundary — first, because it is the part that gets broken

**The module must not know what a node, a bearing, a packet or a mesh is.** It is
a generic engine over entities, observations and facts. Every piece of domain
knowledge lives in the inference modules node-dash registers with it. Get this
wrong and there are two places where mesh logic lives, and they will disagree.

The payoff for that discipline is that it is testable without a radio: feed it
synthetic observations, assert the facts that fall out.

Enforced, not merely stated — **this repo has broken exactly this rule before**:

1. **One import, in the composition root.** `index.js` wires it; nothing else in
   `src/` names it.
2. **One-way dependency: core emits, the engine consumes.** Core never imports an
   inference, never queries the engine mid-flow, never branches on its presence.
   If core needs to *ask* it something, the boundary has already leaked.
3. **A test that fails on violation** — assert the reference count in core is one.
   `check_specs` cannot catch this; only a test can. Precedent: task
   `ws-relay-plugin-boundary` Phase 6 exists because the rule was stated and
   broken, and `PLUGIN_BOUNDARY_SPEC.md` exists because it was broken again.
   Verified 2026-08-02: ws-relay's couplings *are* now gone (one comment
   remains), but `index.js` still carries six alarm references while
   `docs/modules/index.md` claims there are three — B48, open. The rule holds
   only where something checks it.

### Three stores, split by shape rather than by certainty

| store | shape | why |
|---|---|---|
| **observations** | append-only, immutable, **fixed columns** | high volume, every row identical in shape. A key/value bag here would be millions of rows of the string `"rssi"`. |
| **facts** | per entity: fixed columns for what the device states, plus a **growable key/value bag** for what we infer | the inferred set is open-ended and unknown in advance — exactly where a fixed schema is wrong |
| **inferences** | a registry of pure functions | new derivations arrive as modules, not as edits scattered through core |

Fixed columns hold what the device tells us. The bag holds what we work out.

### Rules that make it survive

- **Provenance is a column, not a convention.** Every inferred value carries what
  produced it, when, from how much evidence, and how wrong it might be. Without
  that, an inference is indistinguishable from a fact — which is exactly how an
  estimated position would come to set a distance record (§1a, §7e).
- **Append, never overwrite.** Store observations of a fact and *derive* the
  current best. A bag you `UPDATE` destroys the history that made it credible.
- **`null` is a real answer.** "Not enough evidence yet" is first-class, never a
  zero and never an exception.
- **The bag is a nursery, not a home.** SQLite's `json_extract` plus a generated
  column promotes a hot key to a real indexed column with no data migration — so
  anything that proves stable graduates. Guard that migration with
  `PRAGMA table_xinfo`, **not** `table_info`, which omits generated columns and
  once took node-dash down in a boot loop.
- **Declare the keys somewhere**, however loosely, or `az`, `azimuth` and
  `bearing` will mean the same thing within a month.

### Why the hooks design pays off

Because observations are immutable atoms, **every inference is a pure function
over them, and therefore retroactive.** Write the bearing estimator in October and
it computes over July's data. Get it wrong, fix it, recompute — nothing stored is
authoritative except the raw observations. That is the return on §5's "store
atoms, not tables", and it is what makes a registry worth building rather than
merely tidy.

Each inference declares: the key it produces, what it feeds on, when it runs, and
a pure function `evidence → {value, confidence, evidence_count} | null`.
Provenance is stamped by the runner, never by the author.

Three things that bite if not designed in: **inferences consuming other
inferences** (declared dependencies, topological order, hard refusal on cycles);
**cost** (each hook declares incremental or batch — recomputing everything per
packet does not scale); and **`null` as a first-class result**.

### The database is shared — DECIDED

Peter, 2026-08-02: *"we share the node-dash database, we add tables to it. no
point in more than 1 db and a LOT of the data is already in those tables."*

So the engine is a **library that is handed a database handle**, never a service
and never a second store. Three consequences worth stating, because the second
one is the reason this is the right call:

1. **The engine owns its own tables and their migrations**, namespaced so
   ownership is legible at a glance. Core never writes them directly — core
   emits, the engine writes. The boundary is unchanged by sharing a file.
2. **Existing tables become observation SOURCES, not things to migrate.**
   `traceroute_history`, `signal_history`, `messages` and `nodes` stay where they
   are and are read through adapters. Nothing is copied, nothing is reshaped, and
   21,793 attempts plus 18,826 hop observations are available to inferences
   immediately. **This is what makes §7f's retroactive property real on day one
   rather than after a migration** — a new inference written next month runs over
   five weeks of history that already exists.
3. **Still testable without a radio.** A library given a handle can be given a
   temporary database in tests; that property came from the boundary, not from
   owning a file.

The open question this leaves is narrower and belongs to the implementing task:
whether the engine's migrations run through `db.js`'s existing mechanism or its
own. Either way, guarded with `PRAGMA table_xinfo`.

**Three mechanisms are available for getting data in, and the choice is per
source, at implementation time.** Peter, 2026-08-02, on triggers: *"I'm not
saying they are needed but they are also a tool in our toolbox."* Recorded as
options, not as a decision:

| need | mechanism | note |
|---|---|---|
| existing data, in the observations shape | **view** | no copy, no drift, no second source of truth |
| capture at write time, from data already in the row | **trigger** | one declaration in the engine's migration; core is not touched at all, which is stronger isolation than a call site |
| enrich with runtime state — azimuth, channel load | **JS at ingest** | nothing else can reach it |

The trigger's strength is that core does not even know it is being observed. Its
cost is invisibility: someone reading `persist.js` sees no reason a row appeared
elsewhere. Acceptable if the engine's schema documents every trigger it installs
and the boundary test knows to look for them — otherwise it is how a mystery
table is born.

### Open decisions

1. **The name.**
2. **Whether it becomes a sibling repo**, as `radar-scope` did — now a smaller
   question than it was, since a shared database means it stays a library either
   way. If it does move, this section is its seed and goes wholesale. Noted
   against a real risk:
   `MESSAGING_SERVICE_SPEC.md` was specced as task 750 in July and **still does
   not exist** — which is why this is a section here rather than a fourth
   standalone document.

**First consumer:** the bearing capture (task
`record-antenna-bearing-on-reception`). Phase 1 there found that
`signal_history` records only *direct* packets — 17 nodes in 7 days — so it
cannot host the bearing for the distant, relayed nodes that need locating. The
observations store is the right home, and that task waits on this one.

## 8. The budget is enforced in code, not configuration

An unattended process transmitting on a public channel shared with strangers is
the one failure here that a commit cannot undo. Reputation on a local mesh is not
recoverable.

- A hard ceiling on transmissions per day, enforced in the transmit path itself,
  which a config edit cannot raise to infinity and a bug cannot bypass.
- A per-target cooldown in days for broadcasts, hours for traceroutes.
- Automatic back-off: consecutive silence lengthens the interval for that target.
- Never two callouts in flight at once.
- A kill switch that stops transmission without stopping observation.
- The firmware's own traceroute rate limit must be established before assuming
  any rate is available. **Not yet checked — do not assume.**

The 26–27 July burst of ~1,000 attempts/day happened with none of these in place.

## 9. THE BLOCKING DECISION: who owns the transmitter

**This must be answered before design, because it decides the repository, the
API, and who owns the airtime budget.** An autonomous prober is a mesh *actor*,
not a dashboard.

Two facts currently contradict each other:

- `src/mesh-send.js` POSTs to mesh-gw and is how Peter's broadcasts went out
  tonight. node-dash transmits today, and `CLAUDE.md` describes node-dash as a
  consumer of mesh-gw.
- The standing rule recorded from earlier sessions is that **mesh ownership is
  services'** — that node-dash never sends to mesh-gw and never reads its
  streams.

Three defensible answers:

1. **Brain here, arm borrowed.** node-dash owns targets, scoring, history and UI;
   services expose a transmit primitive and own the airtime budget.
2. **All of it in services.** node-dash renders what services decided. Consistent
   with the standing rule; puts the interesting logic outside the repo that holds
   the data.
3. **node-dash's send path is blessed.** Simplest, fastest, and requires
   `CLAUDE.md` and the standing rule to be corrected rather than quietly ignored.

**No preference is expressed here.** It is Peter's call, and it is the first
question to settle. Raise it with services on the xsession board once he decides,
rather than presenting them with a built thing.

## 10. Non-goals

- **Not a chatbot.** The callouts are a measurement instrument that happens to be
  polite. No conversation handling, no auto-reply to anything.
- **Not a DM tool.** Broadcasts only, per Peter — a DM proves a route, not reach
  into the public mesh, and consumes the same airtime with a smaller audience.
- **No claim of unreachability, ever.** See §4.
- **No new radar work.** The radar and rotator are not the goal any more; the
  rotator becomes a servant of §7 (turn to the bearing, then ask). No display
  work is in scope until the model exists.
- **No test traffic on PRIMARY by any agent session.** Standing rule, unchanged:
  ch0 is the public mesh, and a live send is Peter's to make. An autonomous
  prober transmitting on PRIMARY is a *product decision Peter has taken*, and is
  not licence for a session to send by hand.

## 11. Phasing

Each phase is its own `/idiot` task with its own spec, and each respects the
domain split — model and scoring are Domain 1, rendering is Domain 2, never both
in one task.

1. **Settle §9.** No code until it is answered.
2. **The engine (§7f).** Observations, facts and the inference registry, as a
   dedicated module with its boundary test. Everything below stores into it, so
   it comes first — retrofitting a store under three consumers is how the
   scattering this was meant to prevent happens anyway.
3. **The reach model (Domain 1).** Attempts as observations per §5, decision
   fields per §6, backfilled from the 21,793 traceroute rows we already have —
   that backfill alone yields a first reach map with zero new transmissions.
4. **The relay graph (Domain 1).** Doors, clusters behind them, fragility, and
   the link set of §7e — derived from the 3,334 routes already stored, so it can
   be built and be correct before any new attempt is made.
5. **Geocode backfill (Domain 1, no airtime).** 194 of 596 positioned nodes are
   named; the module and its rate limit already exist. Turns coordinates into
   places for every mission dossier.
6. **The budget and kill switch (Domain 1).** Before the scheduler, not after.
   It is easier to prove a ceiling holds when nothing is yet trying to breach it.
7. **The scheduler (Domain 1).** Scoring per §7, decision log mandatory.
8. **The callout instrument (Domain 1).** Wording variation, cooldowns, one in
   flight.
9. **Mission Control (Domain 2).** The board. Two columns: radar and map on one
   side (§7d), missions, doors and the attempt log on the other. Reach vs
   hearing, per §4's honesty rules. Nothing computed in the browser.

   **The approved design reference is `public/_mockup-mission-control.html`**,
   served at `http://192.168.10.205:8000/_mockup-mission-control.html` — static,
   unwired, every figure real, built and signed off 2026-08-02.

   Peter, twice: *"keep the static page as a reference, do not delete it"* and
   *"this page must stay… it is a reference and is stand alone."* It keeps that
   URL. The live Mission Control page gets its own route and its own files; this
   one is never repointed, renamed, or replaced by it.

   **The live page is built by copying it, never by editing it.** Peter:
   *"the new dynamic page can use this page and insert data, but the page must be
   saved to file and not overwritten."* So its markup and CSS are the starting
   point for the real partial and mixin; the mockup itself is **frozen** — never
   wired to data, never re-pointed, never overwritten by what is derived from it.

   That freeze is the entire value. An untouched original is what lets the
   shipped page be diffed against the agreed design; a reference that gets edited
   alongside the code has stopped being a reference.

Phases 3, 4 and 5 run entirely on existing history and transmit nothing. They
are where the first real answers come from, and they are the right place to start
once §9 is settled and the engine exists.

## 12. What is not established

Stated so nobody builds on it as if it were:

- **The firmware's traceroute rate limit.** Not checked. §8 depends on it.
- **Whether `status='timeout'` in the existing 18,273 rows means one thing.** It
  is this repo's own label; whether it distinguishes "no reply" from "never
  sent" has not been verified, and the backfill in phase 2 must establish it
  before those rows are treated as evidence of anything.
- **Whether the 335 never-reached targets are reachable at all.** By §4 they are
  unconfirmed, not unreachable — but some fraction are certainly stale nodedb
  entries for nodes that no longer exist, and no method for telling those apart
  has been designed.
- **How much of the mesh we cannot see at all.** Everything here is scoped to
  nodes that have reached *us*. The mesh beyond our reception horizon is, by
  construction, invisible to this design — and may be most of it.
- **Whether the 189.1 km record is trustworthy at the metre level.** It rests on
  a position the far node broadcast about itself, at whatever precision its owner
  configured — and `position_precision` is a per-channel setting that deliberately
  fuzzes location. The kilometre figure is sound; a claim to a hundred metres is
  not, and the model should carry the precision alongside the distance rather
  than quietly dropping it.

### A self-reported position can be wrong, and a km headline will launder it

**This threatens the headline metric directly and needs a guard before any
scoring uses distance.** Querying the furthest nodes we have *never* verified
produced, among others:

```
Millbridge        1681 km    heard 1 Aug
EA1HTF_ 8af4      1003 km    heard 23 Jul, RSSI -44 dBm
Repeater Laraxe    924 km    heard 21 Jul
whisper_*          428 km    heard late Jul
```

**EA1HTF arrived at −44 dBm** — a near-neighbour signal strength from a node
claiming to be in Spain. Whatever that packet is, it is not a thousand-kilometre
RF path. The positions are self-reported and some are stale, defaulted, spoofed,
or belong to a node that has since moved; others may be MQTT-injected into local
RF and re-broadcast.

The Cornwall (187.7 km) and Guernsey (177–182 km) figures are credible — sea
paths, plausible relay chains, sane per-hop SNR. The 400 km+ entries are not.

**A km-based objective will happily convert a bad position into a new record.**
Before distance drives anything, the model needs a plausibility test — and this
spec deliberately does not invent one, because it should be designed against the
data rather than guessed at here. Candidate signals worth examining: received
signal strength against claimed distance, hop count against claimed distance,
whether the position has ever changed, and whether any known MQTT bridge sits on
the route. **Until such a test exists, distances above roughly 200 km are
suspect and must not be published as records.**
