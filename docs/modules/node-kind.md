---
module: node-kind
source: src/node-kind.js
source_hash: 4bc5d55fb291bef61169c6daaf1cd596a263c3d52ee86c90f3c453cdb5484bfc
updated: 2026-08-05
---

# Module: node-kind

## Purpose

One answer to "what is this node to us", decided in Domain 1 so the radar can
draw a different icon per kind without deciding which (`docs/BROWSER_CONTRACT.md`).

Peter, 2026-08-04:

> the current dash is saturated with every node plotted the same with no
> indication of whether it is a target, a relay / router

## The four kinds, and their precedence

| kind | meaning |
|---|---|
| `own` | one of our own radios — never drawn as mesh infrastructure |
| `door` | we have **proven** we can transmit to it directly: it has been the first hop of a completed traceroute |
| `router` | the node **declares** a relay role in its nodeinfo |
| `endpoint` | everything else — a destination, not a way through |

Precedence is `own` > `door` > `router` > `endpoint`.

### Why `door` outranks `router`

Measured 2026-08-04: of the 13 relays we could provably reach, **8 declared no
router role at all**; and of 28 declared `ROUTER`s only 12 had ever carried a hop
for us. A relay we have actually transmitted through is a more useful thing to
see on a radar than one that merely says it is a router.

Declaration is a hint. A completed route is a fact.

### Why a door is evidence and not a guess

`provenDoorNums` selects `route[0]` from **completed** traceroutes. That is the
relay that forwarded OUR transmission, so it proves the **uplink**. Hearing a node
proves only the downlink, and asymmetric paths are real (`direct-gate-relay-node`).

## The role set

`RELAY_ROLES` = `ROUTER`, `ROUTER_LATE`, `ROUTER_CLIENT`, `REPEATER`.

`ROUTER_CLIENT` and `REPEATER` are **not** current firmware roles. Peter, 2026-08-05,
listing the live set: CLIENT, CLIENT_MUTE, TRACKER, LOST_AND_FOUND, SENSOR, TAK,
TAK_TRACKER, ROUTER, ROUTER_LATE, CLIENT_BASE.

They stay in the set because this module classifies what we **observe**, and we
observe several firmware generations at once — 4 nodes still report `ROUTER_CLIENT`
and 1 reports `REPEATER`. It is not a list of roles to offer as a choice, and
anything building a role picker must not read it.

This mistake has already cost real work: `ROUTER_CLIENT` was written to the OMNI
on 2026-08-04 precisely because it was inferred from these stored values. The radio
rejected it. Recorded here so the next reader does not repeat it.

### One declaration, replacing four

The Set was hand-copied into `doors.js:40`, `standing-tasks.js:39`,
`observatory-ws.js:190` and `observatory-ws.js:831` — four copies, each free to
drift. They now import from here. Same failure mode as the seven private copies
of the discovery defaults that `discoveryConfig()` replaced.

## Caching

`provenDoors()` is a full scan of `traceroute_history`, and `node_list` is emitted
often, so the set is cached behind `node_kind.ttl_sec` (default 300). A declared
knob, not a literal.

- `invalidateDoors()` drops it, so a newly discovered door appears immediately.
- If the query throws, the **last good set is kept** rather than publishing an
  empty one — a failed lookup must not silently reclassify every door as an
  endpoint.

## Where it is served

`ws-relay.js` `enrichEvent()` stamps `node_kind` on every row of `node_list`. The
door set and our own nums are resolved **once per emission**, not per node.

## Known: `own` does not appear in `node_list`

`node-filter.passesFilter()` already excludes our own radios from the node list, so
the `own` branch is unreachable on that path. It is kept because the classifier is
not private to `node_list` — any consumer passing an unfiltered set (the radar's
own device markers, the cluster stats) needs the precedence to be correct.

Verified 2026-08-05 over the whole 14-day store: `door` 14, `router` 31,
`endpoint` 495.

## The role never reached the classifier (2026-08-05)

Peter: *"Routers dont show at all that I can see, was expecting to see little
radar icons."*

He was right, and the cause was upstream of the glyph. **The live node cache
carries no `role`.** nodeinfo writes the role to the `nodes` table; the in-memory
row that reaches `node_list` does not have it. Measured: all 73 rows in a live
`node_list` had `role: null`, while the store held roles for 214 nodes. So
`isRelayRole(null)` was always false and the `router` branch was dead code.

Fixed with `rolesByNum()` — a num→role map from the store, cached on the same TTL
as the door set, resolved **once per emission** and passed through
`nodeKind(..., { roles })`. `nodeKind` prefers the caller's role when it has one
and falls back to the store otherwise.

### …and that exposed the real reason the radar looks empty

With the fix in, still no routers — because **none of the 19 nodes in the live
list has a relay role**. The store holds 48.

The live node cache only contains what has been heard **since the last restart**.
`load_nodes_on_boot` is `false` on both radios (deliberately — the comment at
`device-config.js` says "slow; disable for dev"), so nothing is pre-loaded.

Measured 2026-08-05: 19 nodes in the live list at 1.1 minutes uptime, against
**369** positioned nodes heard within 14 days in the store. Earlier the same
evening, on a longer-lived process, the radar showed 53.

**So the radar's population is a function of process uptime, not of the mesh.**
That is not a node-kind defect and is not fixed here — it changes what the whole
dashboard shows and is an operator decision:

- flip `load_nodes_on_boot` (costs a slow boot), or
- have the radar draw from the store's positioned set rather than the live cache.

Recorded rather than chosen.
