---
module: traceroute-removal-backend
source:
  - src/ws-relay.js
  - src/bridge-events.js
  - src/node-list.js
  - src/lifecycle.js
  - src/index.js
  - src/db.js
source_hash: 6d19422b8114dc231d5ce7a18eee1b7ca1923c317e84899c0bfbad7ee9f918df
updated: 2026-09-03
---

# Removal spec: the rest of the traceroute surface in `src/`

## Purpose

The **Domain 1** half of Peter's instruction, 2026-08-17: *"I want all traces of
it removed, browser and backend. it will be re-designed with no fragments
remaining."*

Three commits complete the removal:

| commit | what |
|---|---|
| `2ef5611` | every DISPATCH caller — seven, not the six the task listed |
| `86400ab` | every trace in `public/` |
| this | the feeds, the decode, the reads, and `passive-tracer.js` |

It designs nothing. The replacement is decided after the tree is clean, as its
own task, per Peter's sequencing rule.

## It also fixes a regression the browser commit introduced

`86400ab` changed the radar to read `ctx.focusNode` from
`radar_context.focus_node`. Nothing emitted that field, so between the two
commits ACTV had no crosshair and no signal overlay. This commit emits it.

**The rename is the point, not a workaround.** `radar_context.traceroute_node`
never meant what it was called: in ACTV `ws-relay` put the *tracker's* target
there — where the rotator is pointing. Deleting the field with everything else
traceroute-shaped would have taken ACTV's crosshair with it. In PASV and SCAN it
carried the last TRACED node, which no longer exists, so those modes now have no
focus node. `traceroute_active` had no second meaning and is gone.

## What is removed

### `src/ws-relay.js`

- `passive_trace_start` and `route_discovered` broadcasts, and the
  `SSOT_TRACEROUTE` V1/V2 fork that chose their source
- `trace_aiming` / `trace_aimed` broadcasts
- the `traceroute.on('start'|'result'|'cancel')` triggers, including the
  `traceroute_failed` broadcast
- the `traceroute_history` replay on WS connect
- `_rcTracerouteNode`, `_rcActive`, `_rcPassiveTracingNode`
- the PASV "TRACING" active card
- `hops_verified` and `hops_fresh` on every node; `hops_display` is now the
  reported packet-hop count and nothing else
- `via` (the first-hop relay bundle) is now always `null` — it was read from
  `last_traceroute.route[0]`. It is still SENT as null: the radar list renders a
  column for it, and a missing key and an unknown first hop are different
  statements.
- `withSnrDb()` and `withLinkBudget()`, with their now-unused imports

### `src/bridge-events.js`

Both traceroute decode paths — the legacy in-place `route_discovery` decode and
`traceroute.handlePacket()` — plus the `ev.type === 'traceroute'` branch.

**This is a genuine loss and it is deliberate.** We overhear other people's
traceroute replies, and decoding them costs no transmission at all. That passive
data is no longer captured. A rewrite should take this back FIRST: it is the
cheapest route information available and the only kind that puts nothing on air.

### `src/node-list.js`

`last_traceroute` is no longer attached to the node payload (three sites).

**Note the asymmetry — it is deliberate.** `setTraceroute()`, the WRITER, stays.
Its only caller is `src/traceroute.js`, which Peter chose to keep intact and
unwired. Deleting the writer would quietly break the one file this exercise is
preserving.

### Deleted files

- `src/passive-tracer.js` (+ its spec) — its whole job was to traceroute a node
  it had just heard
- `src/traceroute-api.js` (+ its spec) — the POST went in `2ef5611`; the
  `GET /traceroute_history` goes here

### `src/index.js`

- the `tracerouteRouter` import and mount
- `/traceroute_history` from `WS_ONLY_ROUTES` — the route does not exist to
  protect
- both one-shot migrations: the `tx_device` backfill and the
  `perf.failure_epoch` stamp. **Verified already applied before removal** —
  `migrations.traceroute_tx_device = true`, `perf.failure_epoch = 1783063900` —
  so they were no-ops on every boot since. The stored config values stay.

### `src/db.js`

`queryTracerouteHistory`, `queryTracerouteHistoryByDevice`,
`backfillTracerouteTxDevice` — the reads Peter dropped.

## What STAYS

| kept | why |
|---|---|
| `src/traceroute.js` | Peter's decision: kept, unwired, zero importers. The scar tissue stays readable in place |
| `traceroute_history` + its 37,424 rows | Peter's decision: keep the data, drop the reads |
| `insertTracerouteHistory`, `insertTracerouteFailure`, `upsertTraceroute`, `nodeList.setTraceroute` | the writers `traceroute.js` calls |
| `src/link-budget.js` | serves the per-RADIO budget the Performance page still shows. Only the per-ROW attachment went |
| `app-helpers.js` `TRACEROUTE_APP` label | a RECEIVED packet type; the event feed still names it |

## Consequences

- **No traceroutes are dispatched, and none are decoded.** Route information
  stops accruing entirely, actively and passively.
- **PASV listens and does nothing.** The mode remains; its only behaviour is gone.
- **DISC was already inert** — `missionRunner.setQueue()` is called from inside
  the observatory block disabled in `3b39449`.
- **Hop counts are all "reported".** Nothing can verify one.

## Test notes

1. WS `/events` for 18 s: no event whose type matches `/trace|route_disc/`.
2. `radar_context` carries `focus_node`, not `traceroute_node`, and no
   `traceroute_active`.
3. A `node_list` node has `hops_display`, and no `hops_verified`, `hops_fresh`
   or `last_traceroute`.
4. `traceroute_history` gains no rows.
5. ACTV crosshair: with an ACTV `radar_context` the focused node gains
   `.radar-node-target` and the TARGET card renders.

## Out of scope

- `src/index.js:379`, the catch-all `/!hex/…` proxy. It forwards ANY unknown
  per-device verb to mesh-gw unexamined — traceroute was simply the one this
  work found, and with the browser callers gone nothing reaches it any more.
  Whether it should refuse POST at all is its own Domain 1 question.
- Designing the replacement.
