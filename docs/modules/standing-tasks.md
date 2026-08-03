---
module: standing-tasks
source: src/standing-tasks.js
source_hash: 69730331f62efe2f272034504fb2568c1f5503af8754ee2fc08b533282deaaea
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
