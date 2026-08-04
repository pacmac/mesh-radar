---
module: standing-tasks
source: src/standing-tasks.js
source_hash: f6f595b2e12b7bb18ccdb6be8acd4e1476c54e1798bb464c776daa9a9cba111f
updated: 2026-08-03
---

# Module: standing-tasks

Task: `hooks-standing-tasks`. Peter, 2026-08-03: *"those hooks should be assigned to tasks,
i.e search the node data for unknown nodes, search the node for nodes that show a different
reply path than the send, search the nodes for nodes mentioned in a traceroute but not
anywhere in our radar."*

## What these are

`store`-scope hooks: triggered by a cadence rather than by a probe, producing **findings**
rather than probe steps. They cost **no airtime** — every answer is already in the database,
unread.

**Finding nothing is also a result.** `all 81 relays seen in routes are known to us` is
evidence the mesh is mapped; silence is indistinguishable from the hook being broken, which
is exactly how the passive tracer failed for 9.5 hours.

## The three

### `unknown-nodes`

"Unknown" had to be pinned before a hook could honestly claim to implement it. Measured
2026-08-03 across 940 nodes:

| reading | count |
|---|---|
| no position | 330 |
| no nodeinfo row | 250 |
| never traced | 460 |
| never heard directly | 905 |
| **placed, heard within `max_silence_days`, never traced** | **58** |

Four different populations, four different actions. Vague terms are what made `from_num`
cost three wrong readings in a single day, so this hook implements the **actionable** one:
we know where it is, it is alive, and we have never asked.

### `ghost-relays`

Relays that carried our traffic and appear in no node table. They demonstrably relayed for
us, so they exist and are reachable, and we hold nothing about them.

**`0xFFFFFFFF` (4294967295) is the BROADCAST address, not a node** — without excluding it
the hook reports a phantom that cannot exist. It was 1 of the 3 "unknown" relays in the
first hand-run. Real answer: **2 of 81**.

### `asymmetric-paths`

How often a reply returns by a different path than the send went out. **62% (1,752 of
2,822)** on 2026-08-03.

Not a curiosity: `route_back` describes relays the outbound path never touched, so it
roughly doubles the relay information already stored. It also means "aim at the first hop"
must specify the **outbound** first hop, and any model treating a path as a stable corridor
is wrong two thirds of the time. See `aim-at-the-first-hop`.

## Cadence

`standing_tasks.every_min`, default **60**, clamped 5–1440. These read history rather than
the wire and gain nothing from running often. One run fires a minute after boot so a fresh
start has findings without waiting an hour.

Each task is isolated: one throwing must not stop the others — a broken analysis should
cost its own finding, never the rest.

## First live run, 2026-08-03

```
unknown-nodes      notice   58 nodes are placed and were heard within 14 days but have never been traced
ghost-relays       notice   2 of 81 relays seen in routes are not in our node table  [3663159568, 1960179445]
asymmetric-paths   info     1752 of 2822 answered routes return by a different path (62%)
```

## Invariants

- Every task emits, including when it finds nothing.
- The broadcast address is never reported as a node.
- No task spends airtime; all read stored history.
- One task failing never prevents the others running.


## `stranded-positions` — positions we already hold and never used

Task `position-the-unpositioned`. Peter, 2026-08-03: *"isn't this an exact task
for a hook?"* — it is, and it is the kind he specified when the contract was
written: search the store for something we could already know.

`nodeinfo` and `nodes` are two tables in one database and they **disagree**. On
2026-08-03, **11** recently-heard nodes had a lat/lon in `nodeinfo` and nothing
in `nodes`. Finding that took a hand-run query, which is precisely the manual
work a standing task exists to remove.

It **reports and does not repair**. Why the two tables diverge is not yet known,
and a hook that quietly copied the rows across would destroy the evidence needed
to find out. Fixing the ingest path is a separate task.

## `anchorable-nodes` — a bound is not a position

**331 nodes have no position, and they never enter the candidate pool at all.**

Correcting a claim made earlier in this task and in its first commit: the
funnel's "127 no position" segment does **not** mean what its label says. It is
`skipped_suspect`, which counts `km > CEILING_KM` (250) — nodes whose *computed*
distance is implausible and therefore unverifiable. **Every one of those 127 has
a position.** The label in `public/app-observatory.js:512` is simply wrong.

The genuinely unpositioned are excluded one level higher, by the evidence query
itself (`WHERE n.lat IS NOT NULL AND n.lon IS NOT NULL AND n.lat <> 0`), so they
appear in **no funnel segment whatsoever**. They are not a grey bar; they are
absent. 174 of them were heard within `max_silence_days`.

That makes this the exclusion the funnel was built to prevent: invisible, and
larger than anything it does show.

Most are genuinely unknowable: the prompting case, Pokey Hollow,
is a **HELTEC_V3 with no GPS** that has never sent a position since first being
heard on 9 June.

But some have a **door**: a relay adjacent to them in an *answered* traceroute,
whose own position bounds theirs to within one LoRa hop.

### Adjacency is not membership

Only two positions in a route actually touch the target:

| element | why |
|---|---|
| `route_back[0]` | first hop of the reply — the target handed the packet to it |
| `route[last]` | last outbound relay — it handed the packet to the target |

Every other member is adjacent to **us** or to another relay. This is not a
theoretical distinction. A hand query on 2026-08-03 treated the whole chain as
neighbours and reported **Preston~Bowyer — 5.3 km away, on our own doorstep** —
as a neighbour of a node in Guernsey. It also inflated the anchorable count to
**30**; the strict rule gives **21**, and 21 is the correct figure.

### It reports a BOUND, never a position

The door's distance is known; the node's is not. An inferred position written
into the same column as a GPS fix would make every reach figure downstream a
guess wearing a measurement's clothes — the one thing the board exists to
prevent. The emitted detail carries this in the payload itself:

```
note: "door distance BOUNDS the node, it does not place it —
       never usable as a reach figure"
```

### Measured 2026-08-03

- 174 unpositioned nodes heard within `max_silence_days`
- **21** have at least one positioned door
- furthest door **178.9 km** — GU4WRP, Guernsey, the door of **Pokey Hollow**,
  the only target that answered that day
- second: StAustellSimonBase, door GCM017-Lancresse Road, 175.7 km

### Where "us" comes from, and why it nearly produced nonsense

`home_pos` is **NULL** on this host — the parked `radar-home-position-ssot` task
is exactly about that — so `homeLatLon()` needs a fallback.

The first version fell back to *"the most recently heard positioned node"*. On
2026-08-03 that happened to resolve to our own OMNI and gave a plausible 179 km,
which is precisely what made it dangerous. The next two candidates in that same
query were **Gozza_Mesh_2 in Bristol** and **mu7gci office in Guernsey**. Either
would have silently rebased every door distance on a stranger's location and
produced confident nonsense indistinguishable from a measurement.

The fallback now resolves **only our own radios**, via `ownDeviceNums()`. Two
consequences worth knowing:

- `ownDeviceNums()` returns an empty set until `index.js:103` registers the MAC
  resolver at startup. Standing tasks first run 60 s after boot, so the live
  service is always past that — but a **standalone script is not**, and will get
  no distances at all. That is the correct behaviour, not a bug.
- Distances are measured from whichever of our radios was heard most recently
  (OMNI or YAGI). They sit ~0.4 km apart, so figures move by a decimal between
  runs: the same door reads 178.9 km from the YAGI and 179.0 km from the OMNI.

When we cannot place ourselves, `homeLatLon()` returns **null** and the hook
reports its doors **without distances** rather than inventing them.

Both hooks report the zero case explicitly. "0 anchorable" is evidence; silence
is indistinguishable from a broken hook, which is the failure that started the
hooks effort in the first place.


## `blocked-corridors` — the corridor we are choosing not to walk

Peter, 2026-08-03: *"is that another case for new hooks?"* It is, and the rule
generalises:

> **Anything found with a hand-run query is a hook that does not exist yet.**

Third such find in one day, after `stranded-positions` and `anchorable-nodes`.

### What it found

Five nodes **beyond the 189.1 km record**, three heard that day, all on bearing
~160° — every one excluded because its step from proven ground was 37–47 km
against a `window_km` of **25**:

```
JERSEY            218.6 km   step 46.6   159°   heard 1h    widen_to 47
!7a6c4384         215.6 km   step 43.8   160°   heard 0h    widen_to 44
GJ7DTA Anthony 3  212.9 km   step 39.3   161°   heard 9h    widen_to 40
!45403276         210.3 km   step 38.9   160°   heard 330h  widen_to 39
```

They were never a leap into the dark. **Guernsey at ~181 km is proven ground** —
six Channel Islands nodes have answered, two on that same day — so Jersey is one
hop past a *working* corridor.

The selector was behaving exactly as designed and said nothing, because
`skipped_beyond_window` is one number that lumps a genuine next step in with
180-odd hopeless leaps. **"Too far" and "further than we currently allow" are
different claims, and only one of them is a decision.**

### The hook beat the hand query

Run against the same store, it also returned **Stafford-Butterhill2, 205.7 km,
bearing 19° — due north, heard 6h earlier, step 37.4 km**, the *nearest* blocked
corridor of all. The hand query missed it because I had pre-filtered to a Channel
Islands bounding box and was blind to everything outside it.

That is the argument for hooks in one line: a standing task has no hunch to
confirm.

### Definition

All four must hold:

1. positioned, and within the 250 km plausibility ceiling
2. alive — heard within `max_silence_days`
3. further than the furthest target we have actually **answered**
4. step from proven ground **>** `window_km`

Condition 4 is what makes it a corridor rather than a wish. Proven ground uses
the selector's own definition — answered at least once, positioned — so the hook
cannot disagree with the thing it describes.

`widen_to` is the payload that matters: it converts an exclusion into a number
someone can act on. Sorted by **step ascending** — the nearest blocked corridor
is the cheapest next move, and ranking by raw distance is the mistake that had
discovery firing at 234 km while a 20 km extension went untried.

### Home comes from `home.lat` / `home.lon`

The same pair `inferences.js` reads, so hooks and selector cannot disagree about
where we are. The first version read only `home_pos` (absent on this host) before
falling back to our own radios, and a reconciliation run reported *"cannot place
ourselves"* while the config held `51.0263296,-3.1588352` the whole time.

### Verified live

Reconciled against the hand figures at `window_km: 25` — 14 blocked, nearest
needs 38 km. After raising the window to 50 the live hook reports **9 blocked,
nearest needs 55 km**: the Jersey and Stafford corridors have been admitted and
the hook now names the next one out, which is exactly what it is for.


## `relay-corridors` — and the baseline that changed the conclusion

Peter, 2026-08-03: *"if we dont have a route to that node, we can choose one that
would be likely, given the locations of other nodes routing through it. another
case for a worker / hook."* Then: *"whatever happens I dont think we should be
targeting remote nodes directly. that is pointless (pun intended)."*

He is right about the aim. We point the yagi at the target's bearing, but the
mesh transmits to the **first hop**, and the first hop falls outside the 35°
beam ~87% of the time. By distance band: 0–50 km 84%, 50–100 km 100%,
100–150 km 100%, 150 km+ 93%. **It is wrong everywhere**, not only close in —
correcting an earlier claim of mine that the error was concentrated in near
targets. (The two far bands rest on 7 and 15 rows; indicative only.)

### The measurement, including the baseline I initially skipped

70/30 time split, 2,734 answered routes:

| strategy | exact first-hop match |
|---|---|
| aim at the target (today) | ~13% in beam |
| nearest proven relay by bearing | 13% — median error 148°, worthless |
| relay that **serves** that bearing | **32%** |
| **always aim at the commonest door** | **63%** |

**The bearing model is half as good as a constant.** I reported it as "roughly
doubles the hit rate" before testing it against a constant baseline — the wrong
comparator, and it made a weak model look strong.

### The real finding is simpler

**There is one dominant door.** `T4`, 5.3 km away, is the first hop for **67%**
of every route we have completed (63% on the held-out split). It sits on bearing
**274°** and serves targets at **98°** — a relay to our *west* is the way out to
the *east*, which is why aiming anywhere near the target is hopeless.

### And it undercuts the yagi

A door 5.3 km away needs no gain; the omni reaches it comfortably. So for most
targets **the yagi confers nothing whatever it points at** — independent support
for the standing recommendation to run DISC on the OMNI
(`aim-at-the-first-hop`, improvement #1).

### It reports, it does not aim

Changing where the beam points alters live RF on a shared band and needs its own
before/after. Publishing the prediction also allows it to be scored against
reality for free before anything moves.

Both the relay's **own** bearing and the bearing it **serves** are published,
because they are different numbers and the difference is the whole finding.

Relays need ≥5 served targets to qualify; below that a median bearing is noise.
Spread is published too — several relays show a 180° spread, meaning they serve
everywhere and are not corridors at all. Spread-weighting is **not** implemented
and is untested.

**Limit, published in the payload:** trained on ANSWERED routes only. The targets
we actually probe have never answered and may be unreachable for reasons that
have nothing to do with aim.


## Four miners built from the trend analysis

Peter, 2026-08-03: *"do these need workers (miners) and hooks"* — workers, and
none of them wanted a hook. **Hooks announce what code does; workers ask what the
data says.** Each of these had to be run by hand first, which is the definition
of a worker that does not exist yet.

### `probing-stalled` — a dead prober on a live mesh

Between 28 July and 1 August we sent **14 traceroutes** — against ~1,000/day
either side — while still hearing the mesh perfectly well. Nothing said so; the
gap was found by plotting a daily series five days later.

Receiving is the control: silence on both sides is a quiet mesh and not our
problem; **hearing plenty while sending nothing is ours, every time.**

Liveness comes from `relay_observation`, **not** `messages`. `messages` holds
TEXT packets only — 29 in 6 h against **9,794** relay observations — so a
threshold built on it would sit near zero and could call a real stall "healthy".
That was the first version and it was wrong.

The floor is derived from `interval_sec`, not guessed: a tenth of the implied
rate is unambiguously broken rather than merely slow.

**Proven to fire**, not merely to exist: against a copy with the last 6 h of
traceroutes deleted and the packets left intact, it reported
`[fault] PROBING STALLED — 0 traceroutes in 6h while hearing 9775 packets`.

### `rate-changepoint` — the date, not the slope

A slope is arguable; a **step has a date**, and a date can be matched to a
deploy, a config write or a firmware change.

It walks the daily series and reports the largest sustained drop.
**Independently found 2026-07-17** — the same date reached by hand — reporting
18.4% before and 7.2% since. That agreement is the validation.

Days below 30 attempts are skipped rather than plotted as zero: a gap means "not
known", a zero means "nothing worked", and they are different claims.

### `dispatcher-yield` — like-for-like, always

The raw split flatters passive because missions deliberately pick harder targets.
Measured the same day: raw **4.2% vs 10.9%**, but on the nodes tried by **both**,
**9.1% vs 12.4%** — selection explained most of the gap and not all of it.

Only the shared-node form is honest, and this project has had to apply that
control by hand three times. Now it runs hourly. Live at 7 days: aimed 8.5%
(18/211) vs passive 12.0% (59/490) on 78 shared nodes.

### `callout-yield` — what the social capital bought

Callouts spend reputation rather than airtime, so their yield must be visible or
the cost is invisible too. `calloutStats()` existed and nothing emitted it.

It says **"too few to read anything into"** below 30 sends, because 0 of 6 is not
a verdict — at a 6/day ceiling this needs weeks.

## `outbound-relay-identity` — the only outbound evidence we get

Every other relay signal we hold is **inbound**. `relay_observation.relay_byte`
records who relayed *to* us, and routing on this mesh is 62% asymmetric, which is
why every door claim in `docs/modules/doors.md` carries the same caveat: we infer
the outbound door from inbound traffic and hope.

`message_status_event` is different. mesh-gw's `relayed` status means
*"Intermediate mesh node ACKed — routing continues"* and carries `from_num` — a
node that handled a packet **we sent**. That is outbound-direction evidence, by
full node number, with none of the low-byte ambiguity that forces
`doors.js` to disambiguate 4.64 candidates per byte.

### What it reports

For each distinct `from_num`, excluding our own radios:

- **known or ghost** — is it in `nodes` at all, named, positioned
- **already a door** — has it ever been `route[0]` of a completed traceroute, or
  is it a relay we have never routed through
- **distance and bearing** from home, and whether it clears the 40 km
  `BEAM_WORTH_IT_KM` threshold that decides if the yagi is worth turning

### The self-ack trap, which this worker must not fall into

On a **broadcast**, `from_num` is **our own sending radio**. `FloodingRouter.cpp`
generates the implicit ack locally when the sender hears its own packet
rebroadcast and delivers it to itself — measured 2026-08-03, a broadcast with
`want_ack` produced `relayed from_num 646426545` = `!2687afb1` = our own OMNI.

Counting those as discoveries would manufacture a finding out of our own
transmissions. Self-acks are excluded via `ownDeviceNums()` and reported
**separately** so the exclusion is visible rather than silent.

### Finding nothing is a result

At the time of writing the table holds 8 rows and **every identity is a
self-ack** — zero third parties. The worker says so explicitly rather than
staying quiet, because silence is indistinguishable from a broken worker. That
is the failure mode that hid the starved passive tracer for 9.5 hours.

This worker exists precisely to notice the *first* third-party identity. Without
it the column accumulates unread, exactly as `relay_byte` did for 18,670 rows
before anything looked at it.

### The guard that failed open

`ownDeviceNums()` returns an **empty Set** until `index.js` registers the
mac→num resolver (`node-filter.js:12`). An empty exclusion set is
indistinguishable from "nothing to exclude", so a guard built on it alone fails
**open**.

Caught by running this worker outside the service: it reported our own OMNI
(`!2687afb1` / TA2o) as a third-party outbound relay — a discovery manufactured
from our own transmission, which is precisely the trap documented above.

The set is therefore unioned with a durable source needing no registration:
packets our own radios originated carry `transport = 'TRANSPORT_INTERNAL'` in
`relay_observation`. Correct regardless of startup ordering. The general
exposure — other callers of `ownDeviceNums()` sharing the same failure mode — is
filed as **B74**, not fixed here.

## `new-ground` — are we still taking ground, or just re-tracing?

Peter, 2026-08-03, on reading the frontier card: *"and should what we now see
graphically be the topic of a worker?"* Yes — the chart shows this only if
someone looks at it, which is the same gap that left `relay_byte` unread for
18,670 rows.

### The question

**Is the mesh still yielding nodes we have never reached?** Every other panel
counts traffic; none of them separates *new ground* from *re-tracing the same
nodes more often*. If first-ever contacts trend to zero while attempts sit at
1140/day, we are spending airtime on nodes we already own — and nothing else
would say so.

### Reported against the denominator

A raw count is unreadable: **4 of 1140** and **4 of 12** are opposite findings.
The worker reports first-ever contacts, attempts, and the yield between them,
plus how many of those contacts **moved the frontier** past the window's prior
best.

### It counts more than the chart can draw

`frontier.reach` only carries nodes with a position inside 250 km, because a bar
needs a height. **New ground does not require a position** — a first-ever answer
from an unpositioned node is still a node we had never reached. Measured
2026-08-03: **6** first-ever contacts that day, of which only **2** were
plottable. The worker uses the unfiltered count and says how many lacked a
position, rather than silently inheriting the chart's filter.

### Zero is the important result

Silence would be indistinguishable from a broken worker — the failure that hid
the starved passive tracer for 9.5 hours. A window with no new ground is
reported explicitly, and with attempts beside it, because "0 of 1140" is the
finding this worker exists to raise.

### Live at first run

```
9 first-ever contacts in 7d from 1467 attempts — none moved the frontier
{ attempts: 1467, answered: 116, first_ever: 9, moved_frontier: 0,
  unpositioned: 5, prior_best_km: 189.1 }
```

**Nine, against the chart's four** — the difference is the 5 unpositioned nodes
the frontier bars cannot draw. That gap is the reason this worker does not
inherit the chart's filter.

Zero branch verified on a real quiet window (29–31 Jul: 0 first-ever, 5
attempts). Severity is `notice` only above 200 attempts, so a quiet system is not
alarmed while a busy-but-barren one is — "0 of 1140" is the alarm, "0 of 5" is
just a quiet night.

## `explorers` — distant, consistent, reaches us, never answers

Peter, 2026-08-04, after tracing PUCK's behaviour: *"whatever the logic that
calculates or flags this as an important node, should flag this node as being an
explorer."*

### The class

An **explorer** is a node whose traffic reliably crosses a long distance and
several hops to reach us, while never once answering anything we send. It is
evidence that **a corridor exists in its direction** — the node is the far end of
a working path, and the relays along that path are the prize.

Four conditions, all knobs:

| condition | default | why |
|---|---|---|
| distance | ≥ 40 km | inside that, an omni already reaches; nothing to explore |
| hops observed | ≥ 2 | a neighbour is not an explorer |
| traffic in window | ≥ 20 | *consistency* — Peter: "distant but consistent". One packet is a fluke |
| answered us | 0 | the moment it answers it stops being unreached and becomes a contact |

Traffic counts messages **plus** received packets: a node can be consistently
present without ever sending text, and `JRSY` (33 packets, 0 messages) is as real
an explorer as `PUCK` (61 messages).

Our own radios are excluded via `TRANSPORT_INTERNAL`, not by name.

### Measured on the live store, 2026-08-04

60 nodes at traffic ≥5, 39 at ≥10, **18 at ≥20** — which is why the default is
20. The shortlist it produces:

```
LWT1  116.7 km  7 hops  traffic 94  tried 16
ApRo   63.1 km  7 hops  traffic 82  tried 71
PUCK   79.5 km  6 hops  traffic 82  tried 23
BSON  179.5 km  7 hops  traffic 58  tried 11
79fc   66.9 km  7 hops  traffic 47  tried 88
```

`BSON` at **179.5 km** is the find: consistently heard, tried 11 times, never
answered, and within 10 km of the standing record. `PUCK` — the node that
prompted this — ranks third, so the instinct was right and there were two more
like it nobody had looked for.

### What it is NOT

It does not claim these nodes are reachable. `79fc` has been tried **88 times**
and never answered; an explorer is a corridor worth understanding, not a target
worth hammering. Ranking is by traffic, deliberately, so consistency rather than
raw distance leads — a node heard once at 240 km is not an explorer.

### Role decides what a non-answer MEANS

Peter, 2026-08-04: *"JRSY might be a repeatere, or sesnor or does no accept or
monitor messages"*, then *"repeaters are gold dust to us"*. Both land.

A node's `role` changes the meaning of silence entirely:

| role | silence means |
|---|---|
| `ROUTER`, `ROUTER_LATE`, `ROUTER_CLIENT`, `REPEATER` | **a door we cannot reach** — worth chasing |
| `CLIENT_MUTE` | working as designed; it never rebroadcasts and can NEVER be a door |
| `CLIENT_BASE`, unset | an ordinary contact |

So `relay_capable` and `can_never_relay` are published per node, and the sort puts
relay-capable first — a router we cannot reach is a **missing door**, which is
worth more than a chatty client that could never be one. Ranking on traffic alone
had `LWT1` (`CLIENT_MUTE`, 116.7 km) at the top; it can never relay for anyone.

### The finding this exposed

31 relay-capable nodes sit within 250 km and **not one has ever been our
`route[0]`**:

```
   km    az  role           pkts tried ok  alive   name
 218.6  159  ROUTER           33     4  0     2h   JRSY   29 km PAST the record
 171.6  236  ROUTER_LATE      13    58  0     0h   Star
 140.0  239  ROUTER           10    12  2     1h   Grn4   has answered twice
 127.8   36  ROUTER_CLIENT    21    20  0     4h   BBBC
 109.5    3  ROUTER           38    37  0     0h   35e7
```

`JRSY` is a live ROUTER **29 km beyond the standing record**, heard 2 h ago, and
has been tried **four times** — while `79fc`, a CLIENT, has been tried **88**. We
spend attempts on nodes that cannot relay and barely ask the ones built to.

`Grn4` at 140 km has already answered **2 of 12** and has still never been used
as a door.
