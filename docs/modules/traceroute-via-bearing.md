---
module: traceroute-via-bearing
source:
  - src/aim.js
  - src/traceroute-api.js
source_hash: b0230e5ce5bceda76f290297352a55292b01f73af4dd8f6434e6589ebbbba658
updated: 2026-09-03
---

# `via` accepts a BEARING as well as a node

## His words, 2026-08-18

> "just thought of another case, we need to able to force a traceroute via a node
> or via a bearing. so I might look at the radar and see a cluster and attempt to
> route via them by a bearing / angle."

The use case is the point: a cluster on the radar is a **direction**, not a node.
You can see that something is over there worth trying without knowing which node
it is, or whether we have a position for any of them.

## The ambiguity, and how it is closed

A bare number could be a bearing or a node num. Guessing wrong points a 35°
antenna at the wrong part of the sky and records a row that looks deliberate —
the same shape as every coercion fault this code has already been bitten by
(`Number(null) === 0` pointing due north, channel `0` being PRIMARY, a node_id
compared against a MAC).

So the rule is explicit, and it is **guarded**, not merely documented:

| `via` | read as |
|---|---|
| `"!da5af428"` | node — the `!` prefix is unambiguous |
| `0` … `360` | **bearing**, in degrees. 360 normalises to 0 |
| `> 360` | node num |
| `{ "bearing": 219 }` | bearing, explicitly — escapes the range rule |
| `{ "node": 219 }` | node, explicitly — escapes the range rule |

**THE COLLISION GUARD.** A bare number in 0–360 that also matches a known node
num is REFUSED, naming both readings and asking for the explicit form. Measured
2026-08-18: no node in the store is below 360 — the smallest is 3,119,745 — so
this cannot fire today. It costs nothing and the day it does fire it prevents a
silently wrong beam, which is the whole reason the range rule is acceptable at
all.

## What it aims at, and what the row says

| form | `aim_mode` | `aim_target` | `aim_az_req` |
|---|---|---|---|
| node | `via` | the node num | that node's bearing |
| bearing | `bearing` | **null** | the bearing given |

`aim_target` is null for a bearing because there is no node identity — we are
pointing at a direction, and claiming a target we did not choose would be a lie
in the data. `bearing` is a distinct mode rather than a flavour of `via` so the
two are separable in `traceroute_history` without parsing anything.

## Everything else is unchanged

- **Directional radios only.** An omni ignores it and says so, exactly as for a
  node `via`.
- **A bearing is always honourable.** Unlike a node, it needs no position lookup,
  so the "refuse rather than fall back" case cannot arise for it — the only
  failure left is the rotator declining to move, which is the existing
  aim-not-confirmed refusal.
- **Not validated against the known route.** Same reason as before: the operator
  is testing a corridor the known route does not contain.

## Test notes

1. `via: 90` → `aim_mode 'bearing'`, `aim_az_req 90`, `aim_target null`.
2. `via: 360` → normalised to 0, not read as a node.
3. `via: 3663393832` → still a node, `aim_mode 'via'`.
4. `via: {bearing: 219}` and `{node: 219}` → forced, whatever the range rule says.
5. `via: 400` with no such node → refused as an unresolvable node, not silently
   treated as bearing 40.
6. On air: the rotator arrives at a bearing that neither the node nor its relay
   would have produced.
