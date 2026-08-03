---
module: standing-tasks
source: src/standing-tasks.js
source_hash: 95556575eb0af65cbff882bfb8ba7d3a8e09e8950673841c44279f78741a2142
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

**127 nodes are excluded from the discovery shortlist for having no position** —
the second-largest exclusion in the funnel after distance, and invisible except
as a grey bar. Most are genuinely unknowable: the prompting case, Pokey Hollow,
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

Both hooks report the zero case explicitly. "0 anchorable" is evidence; silence
is indistinguishable from a broken hook, which is the failure that started the
hooks effort in the first place.
