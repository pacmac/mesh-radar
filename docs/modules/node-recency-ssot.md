---
module: node-recency-ssot
source:
  - src/ws-relay.js
  - src/db.js
source_hash: b3bf798d90f5b70cc6f8bb22dd53f38f30a5306b1b8d79c3bf0c31cff13abefb
updated: 2026-09-03
---

# Last trace is recorded and never published

## What Peter asked, and what was actually wrong

Peter, 2026-08-18: *"we have no SSOT, we have cached vs real time last_heard, we
have no record of last trace. that last one I challenge, because every traceroute
saves to and / or updates tables."*

**He was right to challenge it.** Last trace IS recorded, in `traceroute_history`
and in `nodeinfo.last_traceroute`, and the two agree. What it is not is
**exposed**: a consumer that wants to know when a node was last traced has to go
and query `traceroute_history` itself.

Verified on the live WS feed, 2026-08-18: a node in `node_list` carries **zero**
keys matching `/trace/i`.

## What this task explicitly does NOT do, and why

An earlier version of this spec claimed the dashboard "paints T4 41 hours stale
and filters it out of a heard-recently view one minute after we received a packet
from it". **That claim was false and is withdrawn.** Measured on the live feed:

```
T4    last_heard = 33 min ago    tone=warning
trac  last_heard = 14 min ago    tone=muted
G1    last_heard = 11 min ago    tone=muted
```

Those are the first-hand values. `node-list.js` keeps an in-memory cache that
`touchLastHeard()` stamps on every received packet (`bridge-events.js:63`), and
`hydrateFromStore` seeds it with `rf_last_heard ?? last_heard`
(`node-list.js:411`). The stale figures live in the `nodes` **table columns**,
which the live payload does not read for freshness.

The error was reasoning from the DB columns and from `filters.js` without opening
the payload the browser actually receives. `filters.js:queryNodes()` turns out to
have **zero callers**.

So there is no live freshness bug to fix, and the recency-binding work that was
planned here is **not needed**. Two things remain genuinely true and are recorded
rather than acted on:

- **Five timestamps, no documented rule.** Worth writing down (below), not worth
  re-plumbing.
- **`nodes.last_heard` is a second-hand claim wearing a first-hand name.** Latent:
  nothing user-facing reads it for freshness. A rename is tidiness, and it touches
  storage plus 85 call sites plus the browser, so it is its own task.

## The five timestamps, and which question each answers

| where | means | hand |
|---|---|---|
| `nodes.last_heard` | the RADIO's nodedb claim, replayed on `node_info` | second |
| `nodes.rf_last_heard` | a packet reached us over the air | **first** |
| `traceroute_history` MAX(ts) | we last SENT a traceroute, any outcome | first |
| `traceroute_history` MAX(ts) WHERE ok | a traceroute was ANSWERED | first |
| `nodeinfo.last_traceroute` | the stored route blob's stamp | first |

The in-memory node cache's `last_heard` is **not** the column of the same name —
it is `rf_last_heard ?? last_heard`, refreshed per packet. That collision of names
is the confusion Peter put his finger on.

## The change

Additive, backend only. The browser is not touched, so Domain 2 stays out of this
task by construction (CLAUDE.md: no fix may span domains).

### `src/db.js` — one grouped read, never one query per node

```js
lastTraceByNode()  ->  Map(num -> { attempt, hit })
```

```sql
SELECT to_num,
       MAX(ts)                                AS attempt,
       MAX(CASE WHEN status='ok' THEN ts END) AS hit
  FROM traceroute_history
 WHERE tx_device IS NOT NULL
 GROUP BY to_num
```

`tx_device IS NOT NULL` restricts it to traces **we** sent. An overheard reply is
recorded with null attribution and is not our attempt.

### `src/ws-relay.js` — the node payload gains two fields

| field | meaning |
|---|---|
| `last_trace_attempt` | unix seconds, most recent traceroute we sent. `null` if never |
| `last_trace_hit` | unix seconds, most recent one that was answered. `null` if never |

Both are raw timestamps. The browser derives nothing from them — anything that
needs an age or a tone gets it computed server-side, as `heard_tone` already is.

## Test notes

1. A node we have traced carries both fields; T4 is a live example with both set.
2. A node we have never traced carries `null` for both, not `0` and not absent.
3. A node with attempts but no answer carries an `attempt` and a `null` `hit` —
   that distinction is the whole point. `78f1` is the live example: **127
   attempts, never once answered**. (`HOME` is NOT the example — it has 730
   attempts in 7 days with none answered *in that window*, but it did answer on
   14 Jul, so its `hit` is set. That is exactly the difference this pair of
   fields exists to show, and picking it as the example would have been wrong.)
4. The values match a direct `traceroute_history` query for the same node.
5. Building the node list issues ONE traceroute_history query, not one per node.
