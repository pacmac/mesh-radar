---
module: snapshot-api
source: src/snapshot-api.js
source_hash: fa0fb2ee72615de3c0036f2676437ad4dc8308539a2454881ff60afe74c0eaec
updated: 2026-08-05
---

# Module: snapshot-api

## Purpose

Domain 1 for the **Snapshot** board. Everything is derived in Node; the browser
renders and computes nothing (`BROWSER_CONTRACT`).

## Receive is the only source of truth

Peter, 2026-08-05: *"active means transmit, passive means receive. if transmit was
successful then receive will reflect it. no ambiguity at all."*

A successful transmit **is** a reception — the reply arrives and the node lands in
`nodes`. Therefore transmitting can never produce a node we have not heard, and
reach derived from `traceroute_history` is a strict **subset** of reach derived
from reception.

Measured 2026-08-05:

```
traceroute-confirmed nodes            115
  ...also heard passively             113
  ...NEVER heard  (active-only win)     0
heard but never traceroute-confirmed  851
```

That `0` is **a tautology, not a finding**. An earlier draft of this spec
presented it as evidence about the discovery engine; it is structurally incapable
of being anything else.

**The rule:** *"passive data is the ONLY real truth. it can be increased by active
but can never be less than."* Reception sets the floor; a traceroute adds
confidence and proves a round trip, but it may raise the figure and never lower
it.

### What this replaced, and why it was wrong

The first version derived everything from `traceroute_history` and served
**189.1 km** while `nodes` already held **495.8 km**. It reported *less than the
truth we already possessed* — the one thing the rule forbids. It also split the
answer into "contact" and "direct" as two competing claims. That framing is
withdrawn: there is one source (reception), one metric (distance), and hops as a
quality ranking on top.

## Hops rank quality, they do not gate reach

The goal is distance — *"how far can we get"* — so a node heard at seven hops
still counts. But *"100 km is better than 100 km in 7 hops"*, so hops survive as
`km_per_hop` (distance per leg; `hops = 0` is one leg, hence `hops + 1`).

Measured spread, best km/hop by hop count:

```
0: 285.8   1: 122.6   2: 156.4   3: 124.0   4: 91.3   5: 75.3   6: 48.6   7: 53.5
```

It separates the field meaningfully — `469.2 km in 2 hops` (156.4/hop) outranks
`495.8 km in 3` on quality while losing on distance. Served, so the browser ranks
nothing itself.

`hops` may be null. Unknown is **not** zero, and a null must not flatter the
ranking, so those rows are skipped for quality and still counted for distance.

## `scale_max_km` bounds a display scale — it does not judge data

**RETRACTION.** Earlier versions of this spec, and two commit messages, called
MLBR's 1681 km *"a bad GPS fix"* and used it to justify the cap. That is wrong.
`51.515 / 21.106` is a real location in Poland, and the excluded rows cluster
coherently in real places:

```
2737 km  Tenerife      1681 km  Poland (MLBR)     1461 km  Lisbon
1067–1017 km  SIX nodes clustered in Galicia
```

Random corrupt coordinates do not cluster geographically. The cap bounds what the
radar and this endpoint will **scale** to; it makes no claim that the excluded
rows are invalid. `beyond_scale` reports how many were set aside.

## The open question this exposes

With hops irrelevant, the distinction that matters is **what carried the packet**
— RF or the internet. `rf_last_heard` cannot currently tell them apart: Tenerife
at 2737 km is flagged `RF`. Until `packet-provenance-capture` lands
(`transport_mechanism`, `relay_node`), distance alone does not prove radio reach,
and the served `caveat` says so.

The figure with unambiguous provenance is the 0-hop maximum, **285.8 km** — no
relay, no MQTT path.

## Route

`GET /snapshot/frontier?days=N` → `furthest_km`, `furthest_node`, `heard`,
`confirmed`, `best_quality_km_per_hop`, `best_quality_node`, `window_days`,
`scale_max_km`, `beyond_scale`, `caveat`.

`window_days` rides in the payload and the browser prints what it is given — the
static page once showed an all-time 189.1 km under a 7D badge (true 7-day figure
176.2 km), and a number without its window attached is how that happens.

`ready:false` with a `reason` when there is no home position — a gap, never a zero.

## Reconciliation

Endpoint vs SQL run independently, all four windows:

```
          furthest   heard
1d          208.0      162
7d          444.2      323
30d         469.2      518
all         495.8      590
```

## The invariant is enforced, not remembered

`check_contract.mjs` asserts `served furthest_km >= passive floor`. Negative
control — reach reverted to transmit-only:

```
FAIL  reach is below the passive floor
      served 189.1 km < heard 495.8 km
```

so a regression to transmit-derived reach fails the build rather than quietly
shrinking the frontier.

## Every band, one window

`distribution` (bands + **every** door, not a truncated list — the card once
dropped rows to fix a layout problem, which is deleting data to fix CSS),
`new-ground`, and `productivity` all take the same `days`, and the browser loads
them together. The board previously mixed all-time, 30-day and today in one view.

`first_heard` lives on **nodeinfo**, not `nodes` — 1104 rows. The board rendered
"no first_heard column" because I checked one table and declared an absence.

`new_clusters` is served **null**, not 0, with `new_clusters_reason`: cluster
anchors carry no creation timestamp. Null says "cannot measure"; 0 would claim
"none appeared".

Verified on `all`: 115 first-ever contacts · 16 new doors · 1104 first heard ·
471.8 km furthest new contact (B14) · 25093 attempts at 14.7%.

**The check that was missing:** vary the window, assert the render changes. Six
windows produced six distinct renders. A value identical across every window is
not window-derived, which is how five hard-coded zeros survived review.

## Health admits what it cannot measure

The card previously showed six invented rows ("sent 11:38", "v4 · 20° · free",
"within budget", "204 of 387").  now returns only observable
state; anything else carries `value: null` and a `reason`, and the card renders
the reason. A health panel that fabricates health is worse than none — its whole
job is to be believed, and the alerts path was dead today while nothing said so.

The four header badges (gw live / OMNI rx · YAGI tx / ACTV / rotator 20°) were
also invented and are removed rather than left looking live.

## scripts/check_snapshot.mjs

54 assertions: 9 fields x 6 windows, endpoint vs SQL written independently of the
endpoint code. Run it on every change to this module.

## Health admits what it cannot measure

The card previously showed six invented rows ("sent 11:38", "v4 · 20° · free",
"within budget", "204 of 387"). The health route now returns only observable
state; anything else carries a null value and a `reason`, and the card renders
the reason. A health panel that fabricates health is worse than none — its whole
job is to be believed, and the alerts path was dead today while nothing said so.

The four header badges (gw live / OMNI rx · YAGI tx / ACTV / rotator 20°) were
also invented, and are removed rather than left looking live.

## scripts/check_snapshot.mjs

54 assertions: 9 fields across 6 windows, endpoint vs SQL written independently
of the endpoint code. Run on every change to this module.
