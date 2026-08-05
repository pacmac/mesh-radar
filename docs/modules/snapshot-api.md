---
module: snapshot-api
source: src/snapshot-api.js
source_hash: 32d81cf2db95b446795165b50d65fc4d7286cf74ea9e4a2682a37a8f8983b9e7
updated: 2026-08-05
---

# Module: snapshot-api

## Purpose

Domain 1 for the **Snapshot** board — one screen answering *how far can we get ·
what is new · are we productive · is the machine working*. Everything is derived
in Node; the browser renders and computes nothing (`BROWSER_CONTRACT`).

Built in six increments, on Peter's instruction (2026-08-05): *"you need to start
filling with live data and validate that the static and live data correlate.
suggest you do not do this in 1 shot."* Each increment must reconcile against the
hard-coded value it replaces before the next begins.

**Increment 1 — the hero band — is implemented. 2 to 6 are not:**

| # | band | reconciles against |
|---|---|---|
| **1** | hero: furthest contact / direct / contacted | 95.2 · 5.3 · 33 · 7 ✅ |
| 2 | distance ladder + doors | 3·5·21·4, T4 2094 |
| 3 | new ground | 0·0·0 + a real source for "first heard" |
| 4 | productivity + 14-day series | 540 · 86 · 15.9% |
| 5 | machine health | live, no static equivalent |
| 6 | global window wiring | every band moves together |

## Every figure carries its window

`window_days` is returned **in the payload**, and the browser prints what it is
given.

This exists because the static mockup shipped an **all-time 189.1 km under a 7D
badge** — the true 7-day figure was 176.2 km — while the ladder and doors were
all-time and the answer rate was *today*. Three periods presented as one view,
flattering us by 13 km. A number without its window attached is how that happens.

Default comes from `observatory.window_days` (server-side SSOT, so every viewer
sees the same board); `?days=N` overrides for a single call. `0` means all-time,
matching `config-api`'s `WINDOW_DAYS` vocabulary.

## Contact and direct are different claims

| field | means |
|---|---|
| `furthest_contact_km` | any completed traceroute, however many relays carried it |
| `furthest_direct_km` | an **empty route** — the endpoint answered with no relay at all |

"We talked to something 189 km away" and "we reached something 5 km away
ourselves" are not the same sentence, and only the second describes our own
reach. They are served separately with the distinction stated in `caveat`, never
merged — `reach.js` records the cost of merging them once already (143 km
"achieved" where the proven maximum was 48.4).

Note `direct` here counts **0-relay only**. `reach.js`'s `provenLinks()` also
counts first-hop evidence, which is why its all-time figure (48.4 km) is larger
than this endpoint's. Two defensible definitions; do not compare them directly.

## The plausibility gate

Distances above `reach.max_plausible_km` (default 500) are dropped. One bad GPS
fix — MLBR reporting 1681 km — is how a single row silently governs an entire
display; `clusters.js` and the radar already gate on the same constant.

## Route

`GET /snapshot/frontier?days=N` →

```json
{ "ready": true, "window_days": 1,
  "furthest_contact_km": 95.2, "furthest_contact_node": "Mr B",
  "furthest_direct_km": 5.3,   "furthest_direct_node": "…",
  "contacted": 33, "direct": 2, "doors_used": 7,
  "max_plausible_km": 500, "caveat": "…" }
```

`ready:false` with a `reason` when there is no home position — a gap, never a
zero.

## Reconciliation (the acceptance test for increment 1)

Live endpoint vs the SQL-derived values the static page displayed:

```
field                 live      static
furthest_contact_km   95.2      95.2     OK
furthest_direct_km     5.3       5.3     OK
contacted               33        33     OK
direct                   2         2     OK
doors_used               7         7     OK
```

and across windows, against figures measured independently in SQL:

```
1d   95.2      7d  176.2      30d  187.7      all  189.1     (contacted 93)
```

These are live and will drift as new traceroutes land — the match proves the
endpoint computes the same thing, not that the numbers are frozen.
