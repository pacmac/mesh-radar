---
module: standing-tasks
source: src/standing-tasks.js
source_hash: 0f0a0b4022dc2d630d6e6c3c85720e88a1b31c7e0c9e8915af94be7dad58540f
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
