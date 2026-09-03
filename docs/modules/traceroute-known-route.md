---
module: traceroute-known-route
source:
  - src/db.js
  - src/aim.js
  - src/traceroute.js
source_hash: ec1f9c3f0ab4ac88f0bc91dfa40e0081f951156bedb32d7b697f9303c4210bc8
updated: 2026-09-03
---

# `known_route` — the feed carries the path it is working from

## His words, 2026-08-18

> "so the ws feed already looks up the target node's last record to determine the
> route if it is not direct and aims it at the first node (or a bearing) so
> traceroute knows the old route. and this should also be part of the ws feed.
> why because radar can then plot it without having to do it's own enquiries."

Correct, and it is the better shape: `decideAim()` already queries the target's
last known route to choose node-vs-relay, so the backend holds that path at emit
time. A consumer that had to fetch it separately would be doing a second lookup
for something the emitter already had — and would be free to disagree with it.

This also follows the rule the feed exists for: the radar **observes**. Giving it
the believed path means it never has to ask, and therefore never has to decide.

## `direct` and `unknown` become distinguishable

`stmts.latestRouteTo` filters `json_array_length(route) > 0`, so a node whose
last successful trace was DIRECT (empty route) returns no row — identical to a
node never traced. Measured 2026-08-18: **7 nodes are in that state**, including
WLCD (919 attempts, 657 answered) and TA2m (972 / 393).

**This has never caused a wrong decision.** The one consumer is `decideAim`, and
empty and missing both fall through to the same branch — aim at the node, which
is right because a direct node has no relay. Dispatch never consults it; direct
nodes are traced exactly like any other.

It matters now only because the two are different things to *show*: "direct — we
reach it ourselves" is not "we have no idea what the path is". So a second
statement, `lastKnownRouteTo`, returns `route` and `ts` **without** the filter.

`decideAim` moves to it. Behaviour is unchanged — empty still yields no relay —
and it stops being blind to the distinction.

## The payload addition

Present on every phase, since it is part of the run context:

```jsonc
"known_route": {
  "route":       [3608510722, 106643874],   // as last observed
  "hops":        2,
  "direct":      false,                     // true = empty route, we reach it ourselves
  "ts":          1786998000,                // when that path was last observed
  "relay_num":   3608510722,                // route[0] — what a relay aim points at
  "relay_label": "fir",
  "relay_positions": { "3608510722": { "latitude_i": …, "longitude_i": … }, … }
}
```

`null` when nothing is known — never an empty shape a consumer would have to tell
apart from a real direct contact.

Labels are pre-resolved because the browser resolves nothing.

`relay_positions` is carried for the same reason the OLD radar overlay carried
it: a consumer working from the node list alone cannot place every hop. Measured
2026-08-18, only **80 of 109** relays appearing in stored routes have a position
in `nodes` — so 27% of hops would be unplottable. `extractRelayPositions()` reads
`nodeinfo`, the same source the stored rows used.

## What this gives a consumer

On `resolved`/`aiming` it has the believed path before anything moves, so it can
draw it immediately. On `answered` the `result` block carries the NEW route, so
old and new sit side by side and a changed path is visible as a change rather
than as a redraw.

## Test notes

1. A node with a relayed last route → `known_route.direct` false,
   `relay_num` equals `route[0]`, `hops` equals `route.length`.
2. A node whose last route was EMPTY → `direct` true, `relay_num` null — and
   NOT null-the-whole-object, which is what the old filtered query forced.
3. A never-traced node → `known_route` null.
4. `decideAim` behaviour is unchanged across all three.
5. Live: the field arrives on every phase of a real traceroute.
