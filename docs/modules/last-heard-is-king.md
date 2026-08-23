---
module: last-heard-is-king
source:
  - src/db.js
  - src/bridge-events.js
source_hash: 5629eae3c1ba312e4b140da6c4d9a80448888872e059b40ab9e9641b47e5c296
updated: 2026-08-18
---

# `last_heard` is king, and it must never be stale

Peter, 2026-08-18: *"last_heard is king. traceroute is tx/rx so last_heard will
also reflect traceroutes. last_heard is KING, it must never be stale"*

## The fault

**`nodes.last_heard` is written only by the radio's nodedb replay.** Nothing we
hear ourselves ever reaches it.

`nodeList.touchLastHeard()` (`node-list.js:166`) — the function called on every
received packet — updates the **in-memory cache only**. It issues no SQL. The
column is written by `upsertNode` (from `node_info`/`node_update`, which
`db.js:710` itself documents as *"a BLE nodedb replay, not reception evidence"*)
and by the env-metrics insert.

So the field named `last_heard` holds the radio's second-hand claim about when
**it** last heard a node, and the moment node-dash restarts and rebuilds its cache
the first-hand value is gone. Measured 2026-08-18: T4 read **42.8 hours** stale in
the column while we had heard it — and successfully traced it — 30 minutes
earlier.

### Three ways it goes stale

| # | where | effect |
|---|---|---|
| 1 | `touchLastHeard` writes no SQL | **no reception ever persists.** The permanent one |
| 2 | `node-list.js:167` `if (this._scanActive) return;` | during a scan, not even the cache updates |
| 3 | `bridge-events.js:61` `yagiOnly` | during a scan, a packet heard by the non-scan radio is dropped entirely — `touchRfHeard` sits inside that guard too |

A traceroute reply is an ordinary received packet, so it reaches
`touchLastHeard` — and therefore stops at the cache like everything else. That is
the specific case Peter named: *"traceroute is tx/rx"*.

## The rule

**A reception is persisted, always, and `last_heard` only ever moves forward.**

```sql
UPDATE nodes
   SET last_heard    = MAX(COALESCE(last_heard, 0),    @ts),
       rf_last_heard = MAX(COALESCE(rf_last_heard, 0), @ts)
 WHERE num = @num
```

`MAX`, not assignment: a replayed nodedb row, an out-of-order packet, or a
backfill must never roll it backwards. `upsertNode` already guards its own path
the same way; this gives the first-hand path the same protection.

**RF only.** The stamp stays behind `if (!ev.via_mqtt)`. An MQTT-delivered packet
did not travel the whole path by radio, and `hide_mqtt_only` rests on that
distinction. "Heard" means heard.

## The change

### `src/db.js` — `touchRfHeard` advances both columns

It already stamps `rf_last_heard` monotonically; it now stamps `last_heard` the
same way in the same statement. One write, one round trip, no new call site.

### `src/bridge-events.js` — the stamp leaves the `yagiOnly` guard

`yagiOnly` exists so that during a scan only the scan listener may update the
**cache** — that is a scan-attribution rule, and it stays. But *"we received a
packet from node X at time T"* is true no matter which radio heard it, and
refusing to record it does not make the scan more accurate, it just loses the
fact. The DB stamp moves outside the guard; the `touchLastHeard` cache call stays
inside it.

## What this does NOT do

- **No column is renamed.** Peter named `last_heard` as the field that must be
  right, so it is made right in place. An earlier sketch to rename it
  `nodedb_last_heard` and point consumers at `rf_last_heard` is abandoned — it
  would have left the king's name on the wrong number.
- **`rf_last_heard` stays.** It still answers the narrower question "did we hear
  this over the air", which `hide_mqtt_only` needs. After this change the two
  agree on RF receptions and differ only where a nodedb replay is newer.
- **The scan cache guard is unchanged.**

## Test notes

1. Note `nodes.last_heard` for a live node, run a traceroute it answers, and the
   column moves to the reply time. This is Peter's stated case.
2. The column never decreases: replay an older `node_info` and it holds.
3. An MQTT-only packet does not move it.
4. Removing the `last_heard` term from the statement makes check 1 fail — the
   column stays at its old value while `rf_last_heard` advances.
