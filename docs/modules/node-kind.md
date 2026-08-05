---
module: node-kind
source: src/node-kind.js
source_hash: 30a645067b9ff55d6bd88f5aab94c018068a6c80e2ce946c660ab92dc5c463e0
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

## MQTT-only nodes (`node_filters.hide_mqtt_only`, 2026-08-05)

Peter: *"we are not really interested in that because that is cheating and does
not use radio for the whole path, so that should be a node-filter with default
to off."*

`nodes.rf_last_heard` records when we last heard a node **over the air**.
`last_heard` counts any arrival including MQTT; this counts RF only. Null means
never heard by radio.

- **Stamped forward** in `bridge-events.js`, only when `!ev.via_mqtt`.
- **Backfilled at migration** from evidence already held: a local RSSI/SNR can
  only come from our own radio, since an MQTT-delivered packet carries no local
  signal reading. 958 rows backfilled; 887 nodes have RF evidence, 71 do not.
- The backfilled timestamp is the best RF evidence we hold, **not necessarily the
  true last RF reception** — older rows may have aged out of `signal_history`.
  It is used as a has-ever-been-heard flag, which is what the filter needs.

`node_filters.hide_mqtt_only` defaults to **true**. It is a BACKEND filter and so
governs every page at once — distinct from the radar layer toggles, which are
per-viewer view preferences and change nothing about what a page may see.

The pre-existing `node_filters.hide_mqtt` tests a per-node `via_mqtt` flag that
is **never populated** — the `nodes` table has no such column — so it has always
been dead. Left in place rather than removed, but it is not the working filter.

## Role normalisation

`role` arrived unvalidated. The gw sends `user.role` as the **number 200** for
three of our own radios (BNCH, GARG, SOAK); bound into a TEXT-affinity column
that became the string `'200.0'` — the `.0` is ours, a JS float landing in
SQLite. It then matched no role, so `node-filter.js:92`'s whitelist test excluded
our own radios from the radar.

What 200 means is a **mesh-gw question and is not answered here.**

`normaliseRole(v)` uppercases and trims, returns a member of `KNOWN_ROLES`, and
returns `null` for anything else — logging each unrecognised value **once**, so a
genuinely new firmware role surfaces as a line to act on instead of silently
becoming null forever.

**Numbers are deliberately NOT mapped to enum names.** The ordinals cannot be
verified against the device from here, and guessing them would mislabel nodes —
the failure the "ask the device, don't trust the docs" rule exists to prevent.
Normal traffic already arrives as strings, so a numeric role is the anomaly and
`null` ("unknown") is the honest answer. `node-filter` already defaults a null
role to `CLIENT`, matching the protobuf omit-the-default semantics it documents.

`KNOWN_ROLES` spans firmware generations, because we observe several at once.
`ROUTER_CLIENT` and `REPEATER` are retired but still arrive from old nodes;
`CLIENT_HIDDEN` is current and was **missing** from the canonical list in this
module's own header comment until two live nodes (KITE, d1b0) turned up holding
it. It is what we accept off the wire, not a menu of roles to offer.

### Normalised on the way out as well as in

Applied at four write sites in `persist.js` — and then in `node-list._filter()`,
which is the one that mattered. `_filter()` hands back live **cache** entries
whose `user` comes straight off the gw feed and never passes a write path, and
`GET /nodes` is exactly that. Measured after the write-path fix: the DB read 0
bad roles while `/nodes` was still serving `role: 200` for BNCH.

The out-bound pass copies only when a value actually changes, so the common case
does not clone the whole cache on every emit and never mutates the shared entry.
