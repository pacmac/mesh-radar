---
module: OBSERVATORY_CHARTS
source_hash: a79c2838fb4a8d8ea4c12ae831fb7397c2c9c4727ca54d6d58b58c35de96fa58
updated: 2026-08-02
---

# Charts — the questions that keep getting asked by hand

Task: `observatory-charts`.

Peter, 2026-08-02: *"a new charts sub page is desperately needed."*

Everything learned during 2026-08-02 came out of ad-hoc `node -e` queries against
tables the dashboard already reads — the record ladder, the 27 July prober cliff,
the liveness curve, the 0-for-86 at 187–234 km. None of it was on screen, so it
was invisible to the operator and had to be re-derived by hand each time.

**Every chart here answers a question that was actually asked today.** That is the
selection rule; a chart nobody has needed is decoration.

## The four

| chart | question | source |
|---|---|---|
| **Record over time** | is the frontier moving at all? | `reach.ladder` rungs |
| **Attempts & answers per day** | is the prober working, and yielding? | `traceroute_history` by day |
| **Answer rate by silence** | does hearing a node predict a reply? | `traceroute_history` × `nodes.last_heard` |
| **Answer rate by distance** | where is the wall? | `traceroute_history` × node positions |

Data confirmed present before building: 38 days spanning 2026-06-24 → 08-02,
8 ladder rungs, 18,573 attempts against placed targets, 932 nodes with
`last_heard`.

### Why these and not a chart of everything

The record chart is the product's narrative (`MESH_REACH_SPEC` §1a) and shows the
uncomfortable truth plainly: the whole climb happened in ~18 hours on 24 June and
the frontier has moved 7.5 km since.

The daily chart makes the **27 July cliff** visible — ~1,000 attempts/day to 1,
because `traceroute.enabled` was false — which took a database query to find and
would have taken one glance.

The silence chart is the strongest predictor measured (26.1% / 16.0% / 7.0% /
1.8%) and is the justification for `max_silence_days`. Having it on screen means
the setting can be argued with rather than trusted.

The distance chart is the one that would settle whether today's silence is the
targets or the setup.

## Where the aggregation lives

**In `db.js` as named queries, aggregated by `observatory-ws.js`** — not as
inferences.

The catalogue's rule is *small, and one thing*; four display series in one
inference would break it, and four separate inferences would bloat a registry
whose purpose is to list what the system *works out*, not what it *draws*. A
chart series is display aggregation, and `observatory-ws` is the display feed.
Named queries rather than an exported handle, for the reason
`recentAimedTraceroutes` gives.

`reach.ladder` is reused as-is — it is already a fact and must not be recomputed
here.

## Exact changes

### `src/db.js`

- `attemptsByDay(days)` — per day: attempts, answers.
- `answerRateBySilence()` — buckets: heard directly (`signal_history`), ≤24 h,
  ≤7 d, longer/never; attempts and answers each.
- `answerRateByDistance()` — 25 km bands to 250 km; attempts and answers each.

### `src/observatory-ws.js`

- `charts()` assembles the three plus the ladder, pushed as a `charts` message on
  connect and after each recompute.

### `public/app-observatory.js`

- `obsChartLadder()`, `obsChartDaily()`, `obsChartSilence()`, `obsChartDistance()`
  — each returning an SVG string.

**SVG as a string, DaisyUI variables for colour.** Both rules already apply to the
radar and map and for the same reasons: `<template x-for>` inside `<svg>` cannot
work (the parser namespaces it and Alpine sees no `.content`), and Tailwind
classes injected via `x-html` are never compiled by the in-browser JIT.

### `public/partials/tab-observatory.html`

- A `charts` sub-tab beside Board / Radar / Map / Receptions, two columns.

## What it showed the moment it rendered

The distance chart is why this page was worth building. First render, live data:

```
   0+  30.6%  n=5618      100+   0.0%  n=171
  25+  11.4%  n=7871      125+   1.3%  n=525
  50+  14.2%  n=2265      150+   0.3%  n=340
  75+  20.9%  n=549       175+   1.2%  n=1004
                          200+   0.0%  n=48
```

**There is a wall at 100 km.** Below it, 11–31%. Above it, 0–1.3% across 2,088
attempts. The 189.1 km record was a 1-in-63 event, and every DISC mission today
has been fired into the 187–234 km band — 0.0–1.2% territory — which is why 86
attempts produced nothing.

That was invisible before this page existed, and it changes what the ladder
should be aiming at.

## Axes

Both time charts carry an x axis with five evenly spaced ticks. The record chart
shipped without one — it plotted time and never said what the horizontal meant.
Peter: *"records over time has no x axis, and you can use a very short form for
date/time, we know what year it is."*

Format is `24 Jun` — **no year**, because the series is all one year and the label
must fit the column rather than the column stretching for the label. Forced to
`en-GB`, not the browser default: the default renders `Jun 24` on a US locale, so
the axis would silently change shape depending on who was looking at it.

The daily chart thins its labels to roughly five so they never collide across 30
bars, and uses the same formatter, so the two charts read as a pair.

## Invariants

- Every number is server-computed; the page scales and positions only.
- An empty series renders an empty state naming what fills it, never a fake axis.
- No new airtime: all four read stored history.
