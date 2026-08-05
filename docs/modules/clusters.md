---
module: clusters
source:
  - src/clusters.js
  - src/clusters-api.js
source_hash: 745f6a00ff886b22ac873a4ead303ad3a73ea8b6a0b00797a36fbcc84c7a2505
updated: 2026-08-05
---

# Module: clusters

Implements `docs/CLUSTERS_SPEC.md`. That document carries the reasoning and the
measurements; this one is the mechanism as built.

## Model

A cluster is an **anchor** (a fixed point on the ground) plus a **radius**.
Membership is derived and recomputed; the anchor is the identity. Peter chose
this over a curated member list so a friendly name survives nodes joining and
leaving.

```
clusters(id, slug, friendly_name, lat, lon, radius_km, source, created_at)
```

- `slug` — `cluster-a` … system-owned, permanent, never reused.
- `friendly_name` — operator-owned, optional. `name` is served as
  `friendly_name || slug`, so there is always something to print.
- `radius_km` — null means "use `clusters.radius_km`".

**5 km is the default because it was measured**, not chosen: best door predictor
(74.5% against a 48.4% constant baseline) *and* a 64% cut in radar marks
(371 → 134). One knob serving both purposes.

## Derivation rules

- **Nearest anchor wins.** A node inside two radii joins the closer one only, so
  no node is in two clusters and no stat double-counts.
- **The anchor never auto-recentres.** It is a place. Divergence is reported as
  `drift_km` (anchor → member centroid) and acting on it is an operator decision.
  Re-centring would let a cluster slowly become a different place while keeping
  the operator's name on it.
- **Loners are first class.** Nodes in no cluster are returned in their own list,
  never bucketed into "other". An isolated node is often a candidate new door.
- **Plausibility ceiling, 500 km.** The furthest "positioned" node in the store is
  1681 km away — bad data, not a contact. One such row would blow up every hull
  and extent. Same reasoning as the ceiling on `contribution()`.

### Seeding

`seedClusters()` runs single-linkage grouping at `radius_km` and drops an anchor
at each group's centroid. **Additive and idempotent**: never deletes, never moves
an existing anchor, and only proposes where no cluster already covers the group.
Safe to call repeatedly, and therefore safe to expose as a button.

## Served statistics

`member_count`, `members`, `doors_inside`, `extent_km`, `extent_deg`,
`centroid_km`, `centroid_deg`, `drift_km`, `hull`, `best_snr`, `dominant_door`,
`door_purity`, `routed_members`, `verdict`, `verdict_tone`.

`hull` is a convex hull (monotone chain) over member positions — the polygon the
radar draws as the blob.

### Purity, and the three verdicts

`door_purity` is the fraction of **routed** members using the cluster's dominant
door. It is the point of the feature: a cluster whose members all leave by one
door is *solved*; a mixed one is *unresolved* and is where probing belongs.

| verdict | rule | meaning |
|---|---|---|
| `unknown` | `routed_members == 0` | we have never reached this place at all |
| `solved` | purity ≥ 80 | one reliable way in |
| `mixed` | purity ≥ 50 | works, but not consistently |
| `unresolved` | purity < 50 | reached by inconsistent paths |

`unknown` is deliberately distinct from `unresolved`. Never having reached a place
is a different fact from reaching it unreliably, and collapsing them would hide
the most actionable class on the board.

Verdict strings and tones are **served**, not composed in the browser.

## API

| route | purpose |
|---|---|
| `GET /clusters` | every cluster with derivation and stats, plus loners |
| `GET /clusters/config` | the merged config |
| `GET /clusters/anchors` | raw anchors, undERIVED, for a management UI |
| `POST /clusters/seed` | run the seeder; additive |

Mounted at root, matching the traceroute router's convention.

Config: `clusters.radius_km` (5), `min_members` (2), `window_days` (14),
`ttl_sec` (120).

## Caching

`clusters()` is cached for `ttl_sec`. It is an O(n²) linkage on seed and an O(n·a)
assignment sweep plus a query per member on read, and the radar asks for it often.
`invalidate()` is called by every write.

## Verified 2026-08-05

Seeded against the live store: **52 clusters, 115 loners** from 371 positioned
nodes heard in 14 days.

| slug | n | km | ° | purity | routed | verdict |
|---|---|---|---|---|---|---|
| cluster-f | 15 | 178.4 | 166 | 50 | 4 | mixed |
| cluster-k | 15 | 47.7 | 200 | 92.3 | 13 | solved |
| cluster-m | 14 | 43.1 | 217 | 77.8 | 9 | mixed |
| cluster-l | 13 | 67.9 | 36 | 100 | 1 | solved |
| cluster-e | 11 | 2.0 | 74 | 85.7 | 7 | solved |
| **cluster-r** | **11** | **113.5** | **35** | — | **0** | **unknown** |
| **cluster-d** | **7** | **178.3** | **26** | — | **0** | **unknown** |

The `unknown` rows are the immediately actionable finding: 11 nodes at 113 km on
35°, and 7 at 178 km on 26°, that we have **never routed to at all**. `cluster-l`
shows why purity needs its denominator read too — 100% on a single routed member
out of 13.

## Backend node filters apply here too (2026-08-05)

Peter: *"node filters are backend filters that affect many pages and filter what
any of them can see. the layers etc are user prefs and is different."*

`candidateNodes()` therefore honours `node_filters.hide_mqtt_only` (default
**true**). A node reached only over MQTT is absent from clusters as well as from
the node list.

It matters more here than anywhere else: the MQTT-only set is disproportionately
**distant** — 193, 202, 245, 286, 291, 309 km. Leaving them in inflates cluster
extents and our apparent reach with paths that never touched radio at all.

Measured effect: loners 115 → 99, total clustered members 234, and 14 clusters
still sit beyond 150 km on genuine RF evidence.


## CRUD — you can finally name a place (2026-08-05)

`createAnchor` / `updateAnchor` / `deleteAnchor` existed in `clusters.js` from the
day the module was written and were **never wired to routes**. So you could see
`cluster-f` on the radar and had no way to call it "Blackdowns" — which is what
made the whole feature feel unfinished.

| route | |
|---|---|
| `POST /clusters` | create a manual anchor |
| `PATCH /clusters/:id` | rename, move, or change the radius |
| `DELETE /clusters/:id` | remove the anchor |

**The anchor is the identity.** Renaming never moves it; moving it never renames
it. Membership is always derived, so neither operation touches a node — and
deleting an anchor deletes a *place*, not any nodes: its members simply become
loners on the next derivation.

**`PATCH` treats absent as unchanged**, per field. Three config paths in this repo
wiped stored values by treating "not supplied" as "set to nothing" (`8002efd`);
this is not the fourth. Verified: patching only `radius_km` left `friendly_name`
intact.

### Naming happens where you are already looking

The radar hover card carries the name field, rather than a separate admin page.
The card is `pointer-events:none` so it never blocks the radar; the name row
re-enables them, and the card pins while the pointer is over it so moving from
the blob to the field does not dismiss it mid-edit.

### Verified 2026-08-05

```
PATCH /clusters/6  {"friendly_name":"Blackdowns"}  -> label "Blackdowns-18/5"
renameCluster() from the card                      -> label "Exe Valley-14/13"
PATCH {"radius_km":6} alone                        -> friendly_name survives
```
