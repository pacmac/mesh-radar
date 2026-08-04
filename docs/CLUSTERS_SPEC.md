---
doc: CLUSTERS_SPEC
source_hash: a968e76211fcf3a0626aab26490e4eaeba821c8c146c36dea2fdd51dad8e8fe5
updated: 2026-08-05
status: founding spec — not yet implemented
---

# Clusters

Founding spec. Written 2026-08-04/05 from Peter's design and from measurements
taken the same evening against live data. Nothing here is built yet.

---

## 1. Why

The mesh around this site is not a radial field. It is a set of geographic
**clusters**, and connectivity between them runs through a very small number of
**doors** — relays we can transmit to directly.

Three measurements make the case. All are from live data, and all are small
samples; §9 states the limits honestly.

### 1.1 Bearing is the wrong model

Measured over 2,726 completed traceroutes with a locatable first hop:

| | |
|---|---|
| first hop inside the endpoint's 35° beam | **12.9%** |
| first hop more than 90° away | 56.3% |
| first hop more than 135° away — behind the antenna | **53.4%** |
| mean separation between endpoint bearing and first-hop bearing | **102.6°** |

Pointing at a destination points *away* from the receiving relay most of the
time. Observed directly: endpoint WLCD at 62° NE, first hop T4 at 274° W —
148° apart, 44 recorded occurrences.

### 1.2 Cluster membership predicts the door better than anything else

Leave-one-out over the 91 endpoints that have both a position and a known door:

| predictor | accuracy |
|---|---|
| constant (always the commonest door) | 48.4% |
| bearing sector (±22.5°) | 65.9% |
| nearest neighbour / knn3 | 65.9% |
| **cluster membership, 5 km single linkage** | **74.5%** |

Three clusters are 100% pure and all of them route the "wrong" way:

| cluster | bearing | km | door | purity |
|---|---|---|---|---|
| 3 nodes | 355–2° (N) | 49–54 | **T4 @ 274° (W)** | 100% |
| 3 nodes | 98–110° (E) | 22–32 | **T4 @ 274° (W)** | 100% |
| 3 nodes | 118–119° (ESE) | 92–95 | **T4 @ 274° (W)** | 100% |

Going the opposite way is the rule inside a cluster, not an exception to tolerate.

**A caveat that must not be lost:** an agreement-based confidence signal does NOT
work here. Conditioning on how many of the 3 nearest neighbours agree gave 59.0%
(3/3), 70.2% (2/3), 80.0% (1/3, n=5) — flat to inverted. Do not build a
"only act when neighbours agree" gate; it would make things worse.

### 1.3 The same 5 km parameter declutters the radar

371 positioned nodes heard within 14 days:

| linkage | radar marks | reduction | door purity |
|---|---|---|---|
| 2 km | 213 | 43% | — |
| **5 km** | **134** | **64%** | **74.5%** |
| 10 km | 84 | 77% | 69.7% |

5 km is simultaneously the best door predictor and a 64% cut in clutter. One
knob, and its default comes from measurement rather than taste.

---

## 2. What a cluster is

**A cluster is an anchor point with a radius.** It is a *place*, not a set of
nodes. Membership is derived from the anchor and recomputed; the anchor is the
identity.

```
cluster
  id            stable integer
  slug          'cluster-a', 'cluster-b', …  system-owned, permanent
  friendly_name operator-owned, optional, freely editable
  lat, lon      the anchor — a fixed point on the ground
  radius_km     default from config (5), per-cluster override allowed
  created_at, source ('auto-seed' | 'manual')
```

The slug/friendly-name split is deliberate: the system always has a name it can
print, and Peter's name never blocks derivation or disappears when membership
changes.

### 2.1 Membership rules

- A node belongs to a cluster if it lies within `radius_km` of the anchor.
- **Nearest anchor wins.** A node inside two radii joins the closer anchor only.
  No node is in two clusters, so no stat is double-counted.
- Membership is **derived, never stored as truth**. It is recomputed whenever
  positions change. There is no "add node to cluster" write.
- **Loners are first class.** A node in no cluster is rendered as itself and is
  never swept into an "other" bucket. 82 of 371 nodes are loners at 5 km, and an
  isolated node is often the most interesting one — it is a candidate new door.

### 2.2 The anchor does not auto-recentre

Once created, the anchor stays put. If members drift away from it, that is
**surfaced as drift**, not silently followed.

The alternative — re-centring on the membership centroid — means a cluster can
slowly become a different place while keeping the operator's name on it. That is
the same class of error as a stale spec validating green: the label stays
trustworthy-looking while the thing underneath changes.

Drift is reported per cluster as the distance from the anchor to the current
member centroid. Acting on it is an operator decision, never automatic.

### 2.3 Seeding

Auto-seed runs single-linkage clustering at `radius_km` over positioned nodes
heard within the analysis window, and drops an anchor at each group's centroid.
Groups of one do not produce a cluster.

Seeding is idempotent and additive: it never deletes or moves an existing anchor,
and it only proposes anchors where no cluster already covers the group.

---

## 3. Per-cluster statistics

All computed in Domain 1. The browser renders these and derives none of them
(`docs/BROWSER_CONTRACT.md`).

| stat | meaning |
|---|---|
| `member_count` | nodes currently inside the radius |
| `extent_km` | nearest and furthest member distance from home |
| `extent_deg` | bearing span of members from home |
| `centroid_km`, `centroid_deg` | where the cluster sits, from home |
| `drift_km` | anchor to member-centroid distance (see §2.2) |
| `dominant_door` | most common first hop among members with a known route |
| **`door_purity`** | fraction of routed members using that door |
| `routed_members` | how many members have a known route at all |
| `best_snr`, `median_hops` | signal profile, for reachability at a glance |
| `verdict`, `verdict_tone` | served display strings — never assembled in the browser |

### 3.1 `door_purity` is the point

A cluster whose members all leave through one door is **solved** — we know how to
reach that place. A cluster with mixed doors is **unresolved**.

The six-node cluster at 176–182 km, bearing 165–168°, has **33% purity**: we have
reached those nodes by inconsistent paths and have no reliable route to that
place. That is the frontier, and it is exactly where probing effort belongs.

Rendering that difference is what turns the dashboard from 371 dots into a
statement of what the engine has and has not achieved. It is the strongest single
argument for this feature — stronger than decluttering.

### 3.2 A cluster is a hypothesis

Grouping is geographic; routing is RF. At 74.5% purity, roughly one routed member
in four uses a different door from its cluster's dominant one.

The UI must not imply certainty. Purity is displayed, not hidden, and any
consumer of `dominant_door` treats it as a ranked hint that degrades gracefully —
never as a fact. Same discipline as aim provenance: record what is known, show
what is not.

---

## 4. API surface (Domain 1 → browser)

Read:

- `GET /clusters` — every cluster with §3 stats and member num list
- `GET /clusters/:id` — one cluster, with members expanded
- WS `clusters` payload — same shape, pushed on change, so the radar has no
  polling path of its own

Write (operator only):

- `POST /clusters` — create a manual anchor `{lat, lon, radius_km?, friendly_name?}`
- `PATCH /clusters/:id` — set `friendly_name`, `radius_km`, or move the anchor
- `DELETE /clusters/:id`
- `POST /clusters/seed` — run auto-seed, return proposed anchors; additive only

Config: `clusters.radius_km` (default 5), `clusters.min_members` (default 2),
`clusters.window_days` (reuses the observatory analysis window rather than
declaring a second one).

**No timing or threshold literals in the browser.** All defaults live in
`config-api.js` DEFAULTS and reach the engine through a merged accessor — see the
`discoveryConfig()` precedent, where seven call sites each carried their own
private fallback and a newly added key was invisible until the form was saved.

---

## 5. Domain 2 — overlays on the same radar

Peter, 2026-08-04: *"the same radar only with different overlays."*

Not a second page and not a second renderer. The existing radar gains independent
layers:

| layer | draws |
|---|---|
| `nodes` | individual nodes (today's behaviour) |
| `clusters` | cluster hulls/discs with slug or friendly name |
| `doors` | the relays we provably transmit to directly |
| `routers` | nodes whose role declares them routers (`is_router`, served) |
| `endpoints` | everything that is neither door nor router |
| `loners` | nodes belonging to no cluster |

Layers combine freely. The cases Peter named — clusters without nodes, relays and
clusters only, hide endpoints, show doors only — are all combinations of the
above, so no per-view code is needed.

Layer state is browser-local view preference (which layers are visible). Layer
*contents* are served. The browser decides nothing about membership, purity,
door identity or verdict strings.

### 5.1 Ring scale interacts with this

Decided separately 2026-08-04: the radar's outer ring follows the furthest
plotted node with quantile-spaced inner rings, rather than a fixed 100 km. As of
that evening 13 of 53 plotted nodes sat beyond the 100 km rim and were drawn
clamped to it — TH at 180 km rendering at the same radius as a 100 km node.
Clusters do not fix that; both changes are needed for the radar to be honest
about distance.

---

## 6. What this unlocks (workstream 2 — NOT in this spec)

Recorded so the model is designed for it, and deliberately out of scope here.

Pointer and route decisions become cluster-aware:

```
known route                -> aim at the furthest relay on it that we
                              provably reach directly AND that is better
                              aligned to the endpoint than the door is
unknown endpoint           -> borrow the corridor: nearest node with a known
                              route, intersect its route with our proven-
                              reachable relays, aim at the furthest member
no corridor                -> aim at the endpoint, betting on direct contact
door under beam_worth_it_km-> do not rotate at all; the omni already reaches it
```

Supporting measurements, same evening:

- The nearest known neighbour's route **shares at least one relay** with the
  unknown node's real route **85.7%** of the time. The *specific* last relay
  matches only 23.1%, so the neighbour's route is a **candidate corridor**, not a
  prediction.
- We can provably transmit directly to **13 relays**. Two of them — T4 at 5.3 km
  and fir at 13.1 km — carry **89.7%** of all traffic. Four more are our own
  radios. The five that are far enough for the yagi to matter (E1 48.7 km,
  EX4E 44.3 km, RDEw 41.9 km, EX5R 38.0 km, TivN 25.1 km, all 202–246°) carry
  **1.2%** between them.
- **Endpoint distance does not select the rule.** Mean door distance is 5.9–9.0 km
  in every endpoint band from 0–10 km to 120+ km; the beam-worthy share is 0.0%
  in every band except 30–60 km (4.3%). A 120 km endpoint exits through the same
  near door as a 3 km one, just with more hops (1.3 → 3.8). Measured on
  successful traces only, so distant-door attempts that failed are invisible —
  which does not change the conclusion, because we cannot point at a door we have
  never proven.

The discriminator is therefore **intent, not distance**: *exploit* an existing
path (never rotate) versus *explore* for a new one (rotate at the candidate).
That maps onto the existing selection classes in `inferences.js`, which already
encode intent and today carry only a quota.

---

## 7. Non-goals

- **Not a routing table.** We cannot choose the next hop; the mesh does. A
  cluster's dominant door informs where we *aim* and what we *probe*, never a
  claim about how a packet will travel.
- **Not RF clustering.** Grouping is geographic only. An RF-derived grouping may
  be worth building later; conflating the two now would hide the disagreement
  between them, which `door_purity` exists to expose.
- **No browser-side derivation.** Purity, verdicts, extents, dominant door and
  every display string are computed server-side.
- **No automatic anchor movement, deletion, or merging.**

---

## 8. Domain split

`CLAUDE.md` forbids one task spanning `src/` and `public/`. This is at least two
tasks, and they are sequenced:

1. **Domain 1** — schema, derivation, stats, API, WS payload, config.
2. **Domain 2** — radar layers and toggles, rendering what is served.

Workstream 2 (§6) consumes the model built in (1); building it first would mean
building the cluster→door lookup twice.

---

## 9. Limits of the evidence

Stated here rather than discovered later:

- **91 endpoints** have both a position and a known door. Every accuracy figure
  in §1.2 rests on that sample.
- The three 100%-pure clusters are **3 nodes each**. "100%" means "3 of 3".
- Only **13 relays** have proven direct TX reach, so a corridor intersection will
  sometimes be empty.
- Positions come from the node database and include implausible outliers — the
  furthest "positioned" node is 1,681 km away, which is almost certainly bad data
  rather than a contact. Clustering and any ring scale need a plausibility
  ceiling, as `contribution()` already applies at 250 km.
- All door statistics come from **completed** traceroutes. Failed attempts carry
  no route, so every door figure is survivorship-biased toward paths that work.
