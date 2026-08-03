---
module: OBSERVATORY_CHARTS
source_hash: 4d54f1514b0098df82363e435dbc0a3c5691fab096a474ee8e301840b3ddbcbf
updated: 2026-08-03
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

## The fifth — rate by band, by day

Task: `rate-by-band-by-day`. **Domain 1 only**; the chart is a separate Domain 2 task.

Peter, 2026-08-03: *"do we need a window so that we can actually see what's happened in
the last x days, are we doing better now than we were before? was there a window when
things suddenly spiked / dropped?"*

Yes, and the aggregate daily chart above cannot answer it. It plots one line, in which a
change in **target mix** and a change in **performance** are indistinguishable. That
ambiguity hid a three-week collapse:

```
date          <25km        25-100km      100+km        no-pos
2026-07-04   59%  (280)    5%  (538)    3%   (30)   18%   (88)
2026-07-08   55%  (259)   17%  (501)    4%   (83)   13%   (46)
2026-07-17   12%  (251)   12%  (468)    1%  (128)    9%  (211)
2026-07-23    7%  (202)    2%  (395)    0%  (128)    3%  (348)
2026-07-27    5%  (128)    3%  (403)    0%   (62)    5%  (317)
2026-08-03   11%   (36)    4%  (180)    0%   (58)   15%  (137)
```

**Answer rate to nodes within 25 km fell from ~58% to ~7%.** Close targets cannot be
explained by mix, so this is the rig degrading, not the strategy. Meanwhile the 100+ km
band sat at 0–4% throughout and never moved — it was never working, before or after.

That reorders the whole project: pursuing 200 km while 20 km is broken is the wrong
problem. This series is also the only way to judge whether the YAGI `override_duty_cycle`
change of 2026-08-03 helps, since a throttled send and a genuine silence are currently
the same row.

### Bands

`<25`, `25-100`, `100+`, and `no-pos` — four, not the ten that `answerRateByDistance()`
uses. Ten series across thirty days is unreadable, and four is what made the collapse
visible by hand.

**`no-pos` is a bucket, never folded into a distance band.** `answerRateByDistance()`
inner-joins `nodes` and drops position-less targets entirely; they are 137 of 411
attempts today — a third of all airtime — and they answer at 15–21%. Hiding where a third
of the effort goes is how effort gets wasted unnoticed. They have no distance, so they
are reported separately rather than guessed at.

### The server decides what is renderable

`rate` is `null` when `attempts < MIN_ATTEMPTS` (**15**). 2026-08-02 shows 24% on n=21 and
that is noise; a page drawing it as a recovery would mislead.

Per `BROWSER_CONTRACT` the browser makes zero decisions, so the threshold lives here and
not in the chart. `attempts` and `answers` are always returned — the page renders a gap
where `rate` is null, and never has to qualify a number itself.

### Where it lives

`db.js` as `rateByBandByDay(days)`, assembled by `observatory-ws.js charts()` into
`out.bands`, riding the existing `{type:'charts'}` broadcast. Same rule as the other four:
display aggregation belongs in the display feed, not the inference catalogue.

The haversine expression is duplicated from `answerRateByDistance()` rather than factored
into a shared fragment — extracting it would edit a working query for no behavioural gain.

### The first day in the window is always partial

The filter is `ts > now - days*86400`, a rolling cut at the current time of day, so the
oldest day carries only the hours after that cut. Served on 2026-08-03 the first day reads
`63% (186)` where the full day was `59% (280)` — not a discrepancy, just a part-day.

Left as a rolling window rather than snapped to midnight: the other series use the same
`days` convention, and a chart whose oldest column silently changed width would be worse
than one whose oldest column is honestly short.

### Verified against the hand analysis

Served output matched the by-hand numbers exactly on every full day checked — 07-08, 07-17,
07-23, 07-27 and 08-02 agreed to the individual attempt. Query 35 ms for 108 rows over
~22k history rows.

## The analysis window is SERVER state

Task: `observatory-window`. **Domain 1**; the selector is a separate Domain 2 task.

Peter, 2026-08-03: *"we def need a window filter, all time being one option, 1 day, 7
days, 30 days, 60 days? … we have a farthest target in for example the last 7 days."*
And, decisively: *"the browser is a presentation layer ONLY, this filtering must be done
backend so anyone using the browser sees the same thing."*

One stored value, `observatory.window_days`. Every viewer sees the same figures. The
browser PUTs and re-renders from the broadcast, holding no state of its own — the rule
that already governs `favourite` and `obs_target`.

### What this fixes is worse than a missing control

Before this task the page mixed windows **silently**:

```
attemptsByDay(30)        30 days
rateByBandByDay(30)      30 days
answerRateBySilence()    ALL TIME   — took no window parameter at all
answerRateByDistance()   ALL TIME   — took no window parameter at all
reach.ladder             ALL TIME
```

Four series side by side, two windowed and two not, with nothing on screen saying so. Any
comparison a reader drew between them was invalid — including the "wall at 100 km", an
all-time figure repeatedly read against a 30-day chart during this session's analysis.

**Every figure previously derived from `answerRateByDistance` or `answerRateBySilence`
must be re-derived, not carried forward.** They now mean something different.

### `0` means all time

`days = 0` is the "all time" option and is handled by omitting the predicate entirely.
A naive `ts > now - 0` returns nothing, which would render an empty page as though there
were no data.

Allowed values are `0, 1, 7, 30, 60` — validated as an enum on write, not clamped to a
range, because the intermediate values are meaningless and a free-form number invites the
unclamped-config defect raised with mt-radar earlier.

### The record and the window are different facts

`record_km` stays **all time**. It is the thing to beat — 189.1 km, set 2026-07-04 — and
windowed to 7 days it would read 92 km and imply we had gone backwards.

`window_best_km` is the furthest reached **inside** the window, which is the number Peter
actually asked for. Both are served, both labelled. Serving only the first is how the
ladder came to imply we were still at 189.1 km while the last twelve hours topped out at
92.

### Refresh — why a core hook was unavoidable

`observatory-ws.js` recomputes on `recomputeMin` minutes, **default 15**. A control whose
effect appears a quarter of an hour later is not a control.

`config-api.js` is CORE and may not import or name `observatory-ws`, which is a plugin —
`ws-relay.js` carries an explicit comment about pac-host having been named in it seven
times and why that was wrong. So `ws-relay.js` gains a **generic**
`registerSettingsListener(fn)`, fired by `broadcastSettings()`, alongside the existing
`registerWsWiring` and `registerConnectReplay`. It names no plugin; the observatory
subscribes to it and rebroadcasts its own charts.

## Axes

Both time charts carry an x axis with five evenly spaced ticks. The record chart
shipped without one — it plotted time and never said what the horizontal meant.
Peter: *"records over time has no x axis, and you can use a very short form for
date/time, we know what year it is."*

Format is `24-06` — day-month, zero padded, **no year**, because the series is
all one year and the label must fit the column rather than the column stretching
for the label. Built by hand rather than through `toLocaleDateString`: a locale
formatter gives neither day-first nor hyphens reliably, and pinning a locale to
work around that is weaker than not depending on one.

The daily chart thins its labels to roughly five so they never collide across 30
bars, and uses the same formatter, so the two charts read as a pair.

## Invariants

- Every number is server-computed; the page scales and positions only.
- An empty series renders an empty state naming what fills it, never a fake axis.
- No new airtime: all four read stored history.
