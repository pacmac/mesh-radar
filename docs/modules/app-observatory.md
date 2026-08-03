---
module: app-observatory
source: public/app-observatory.js
source_hash: 6d508a32664df5dbb1755d36e350b2506626b7b906544c171be7bc6f06aceecf
updated: 2026-08-03
---

# Module: app-observatory

## Purpose

Observatory page mixin — the live observation feed and the doors table.
**Presentation only.** Every value arrived over the WS from
`src/observatory-ws.js`; this file decides nothing (`BROWSER_CONTRACT`).

**No fetch anywhere in it, and there must never be.** The feed is pushed,
replayed on connect, appended on arrival.

## State

| | |
|---|---|
| `observations` | newest first, capped at 500 |
| `relayUsage` | doors, server-ranked and server-labelled |
| `reach` | the reach model — record, ladder, frontier, radar plot |
| `meshLinks` | `{ total, links[], marks[], nodes[], legend[] }` — geometry, captions, classes |
| `missions` | `{ missions[], summary }` — ranked, classified and explained by the server |
| `obsTab` | `'board'` \| `'radar'` \| `'map'` \| `'receptions'`, persisted, declared in `app.js` |

`MAX_ROWS = 500` — enough to fill a tall screen and scroll, small enough that an
idle tab cannot grow without bound. The server replays 200 on connect.

## Sub-tabs

Peter, 2026-08-02: *"maybe we need a main menu and sub menus for this? … that way
debug sub pages can be added and we still have the main nasa dashboard."*

`switchObsTab()` mirrors `switchControlTab`/`switchCfgTab` exactly. **No data load
on switch** — everything is WS-pushed regardless of which tab is showing.
Defaults to `board`: the dashboard is the page, raw feeds are diagnostics you go
looking for.

## Times are absolute, not relative

A contract decision rather than a style one. `BROWSER_CONTRACT` forbids the
browser computing "3s ago" on a timer; formatting a timestamp it was *given* is
expressly allowed. So rows carry a clock time. When the server pushes a formatted
age this adopts it without the page changing shape.

## Renderers

```js
obsTime(ts)          // HH:MM:SS, 24h
obsRadio(mac)        // label from the pushed roster, else the raw MAC
obsNode(entity)      // short name if known, else the raw num
obsAz(o)             // "119°" or an em dash — NEVER "0"
obsHasAz(o)          // tints the row; does not filter
obsNum(v, suffix)    // value or em dash
obsNodeCount()       // distinct nodes ON SCREEN
obsRelayShare(uses)  // bar width relative to the busiest door
obsFeedSummary()     // rows on screen, and how many carry a bearing
```

### There is no `obsVia` — and that is the design

An earlier version rendered an `RF` / `MQTT` column. MQTT arrivals are now
dropped at the mapper (spec §3a), so every row here was heard on air by
construction and the column would always say `RF`. The exclusion lives where it
cannot be forgotten rather than in a value the page has to interpret.

### `obsAz` — em dash, never zero

North is a real bearing. A blank must not read as one, and a zero must not read
as unknown. The same rule the capture side enforces
(`docs/modules/observations.md`).

### `obsNode` looks up by num, not through `nodeById()`

`nodeById()` takes a `!hex` id and threw **`nodeId?.startsWith is not a
function` 182 times** when handed the numeric entity. An observation's `entity`
is opaque to the engine and only *happens* to be a node num here; converting it
to an id would be the page asserting a format the store does not guarantee.

### `obsRelayName()` was removed — the server sends `label`

It looked the name up in `this.nodes`, which is a **filtered** list — 4 entries
when measured — so every relay rendered as a raw number. It was also a
`BROWSER_CONTRACT` breach: a label is a display value and belongs to the server.
`relayUsage()` in `observatory-ws.js` now resolves it.

## The plots — SVG built as a string, not `<template x-for>`

`obsRadarSvg()` and `obsMapSvg()` return markup, and that is **not** a style
choice. The HTML parser treats a `<template>` inside `<svg>` as an SVG-namespaced
element with no `.content`, so Alpine cannot use it as a loop scope: every
binding reports *"ring is not defined"* and the attributes land empty. Thirty
console errors on the first attempt. The frozen mockup builds its SVG as a string
for the same reason.

**Colours come from DaisyUI CSS variables, never Tailwind classes.** Tailwind
here is the in-browser JIT build, and utility classes injected via `x-html` are
never compiled — the first radar rendered as a solid black disc because
`fill-base-200/30` resolved to nothing and SVG defaults to black.
`oklch(var(--b2))` needs no build step and still follows the theme.

The arithmetic in both is *layout* — where on a circle, where in a rectangle. The
kilometres, bearings, ranks and captions were all computed server-side.

### The beam — bearing and beamwidth on the radar

Peter, 2026-08-02: *"the radar sub page does not show the yagi's current bearing
and it's beam width as is done in the main radar page."*

It matters more here than on the main radar now that DISC aims the beam at each
mission's bearing (`docs/modules/dash-mode.md`): this page is where you watch a
discovery happen, and a plot of targets with no indication of where the antenna
is looking cannot show that.

Same two inputs as `_drawRadarBeam()` in `app-radar.js` — `yagiAz`, pushed over
the WS, and the rotator's configured `beam_deg` (default 35). Both are server
values; drawing a wedge from them is layout.

**Drawn before the targets**, so a dot inside the beam stays legible — the wedge
is context, not the subject. `large-arc-flag` is 0 and safe: beamwidth is clamped
to 180, so the wedge can never be the reflex sector.

The readout is `147° · 35°` — where it points, and how wide.

### Map labels — de-collided **and clamped**

Marks arrive already clustered, counted and named (`observatory-ws.js`); the page
places them. Labels sharing a corridor are nudged apart vertically, and the
nudge is **clamped into the viewBox**: pushing collisions downwards walked the
Guernsey stack off the bottom edge and four captions silently vanished. Text
outside the viewBox looks like missing data, not overflow.

`+7` after a distance means seven more nodes sit under that dot. The count is the
server's — a cluster never quietly hides its members.

### Node colour — class from the server, swatch from `C_CLS`

`meshLinks().nodes` arrives pre-classified (`relay` / `endpoint` / `seen`) with a
`weight`. This maps class → fill and weight → radius, and nothing more.

```
relay     oklch(var(--a))        radius 3.5 + weight * 8
endpoint  oklch(var(--p))        radius 3.5
seen      oklch(var(--bc)/0.35)  radius 3.5, opacity 0.5
```

The legend swatches in `tab-observatory.html` use `bg-accent` / `bg-primary` /
`bg-base-content/30` — **these must stay in step with `C_CLS`**. They are Tailwind
classes on real elements, which do compile; the SVG fills cannot be, for the
reason above.

Drawn lightest-weight first so the heavy doors land on top rather than being
buried under the specks.

There is a fallback path for a payload with no `nodes[]` — an older server still
gets a drawn map instead of a blank panel.

### `obsNodeCount()` counts what is on screen, and says so

It describes the list being rendered, not a fact about the mesh. A mesh-wide
count would be a derived claim and belongs to the server — which is why the UI
labels it "on screen".

## Freshness — the board states the age of its evidence

Peter, 2026-08-02: *"if a traceroute was last done 4 days ago, then our entire
page is dead and old data."*

Every panel here derives from `traceroute_history`. `obsFreshness()` renders the
age of the newest attempt and `obsIsStale()` tints it past six hours.

**This deliberately bends the absolute-time rule.** The page computes no relative
times anywhere else — but here the age *is* the message, and `27 Jul 14:02` does
not communicate staleness the way `5 days` does. Computed on render from a server
timestamp, not on a ticking timer.

## `missionActivity` — the discovery feed

What the runner is doing now, what it has just done, and what those routes
revealed. The `found` strings are written by the runner; the page renders them
verbatim and assembles no explanation of its own.

## `togglePinned`

Writes `discovery.pinned` through the config route rather than a bespoke
endpoint — pinning *is* a setting, and one value enforces one pinned target by
construction. No local state; the row re-renders from the next missions push.

Selection recomputes on a timer, so a pin takes effect at the next recompute
rather than instantly, and the panel says so.

## The charts

`obsChartLadder`, `obsChartDaily`, `obsChartSilence`, `obsChartDistance`, sharing
`_obsRateBars` for the two rate charts so they read as a pair rather than two
dialects. SVG strings with DaisyUI variable colours, for the two reasons already
documented on `obsRadarSvg()`.

Every number is server-computed; these scale and position only.

`obsShortDate()` renders `24-06` — day-month, zero padded, no year (Peter:
*"24-06 etc etc"*). **Built by hand, not via `toLocaleDateString`**: a locale
formatter cannot be relied on to give day-first or hyphens, which is the
instability that had already forced an explicit `en-GB`. Hand-formatting removes
the dependency rather than pinning it.

Formatting a timestamp the server supplied is expressly allowed; computing an age
on a timer is not, and this does not.

## `obsChartBands()` and `setObsWindow()`

Task `bands-chart`. Domain 2 half of `rate-by-band-by-day` and `observatory-window`.

**Four LINES, one per distance band — not stacked bars.** These are rates that must be
compared against each other; stacking would imply they sum to something.

**A `rate` of `null` breaks the line rather than dropping it to zero.** The server
suppresses any band-day with fewer than 15 attempts, and a gap reads as "not known"
while a zero reads as "nothing answered" — different claims. The path is emitted in
segments, reopening with `M` after each break.

**It sits in ONE column with the same `viewBox="0 0 520 190"` as every other chart.**
The first version spanned two columns while keeping that viewBox, and SVG scales
uniformly — so every label, stroke and legend entry drew about twice the size of the
charts beside it. Peter: *"why are the fonts so huge, that new chart bears no resemblance
in design, layout, spacing to anything else on the page."* Width is not worth a second
type scale on the same page.

**Colour encodes DISTANCE, and distance is ordered — so it is a sequential ramp in one
hue,** `--p` at 1 / 0.62 / 0.34, with `no pos` outside the ramp in neutral because it is
not a distance at all. Four arbitrary hues would not say "ordered".

It deliberately avoids `--su`/`--wa`/`--er`: `_obsRateBars` already maps those to GOOD and
BAD RATE for the two charts below, and green meaning "good" in one chart and "under 25 km"
in the next is a broken vocabulary on a single page. It also avoids `--s`, which in the
corporate theme is chroma 0.055 — near enough to grey to be indistinguishable from the
`no pos` line beside it.

**End labels anchor inward.** The last date sits at `X = W - 10`, and a centred label
overflowed the 520-unit viewBox — it rendered as `03-0` instead of `03-08`. First label
`start`, last `end`, the rest `middle`.

`setObsWindow(days)` PUTs `observatory.window_days` and does nothing else. The window is
SERVER state: the server re-broadcasts `charts` and every viewer re-renders from that.
No optimistic local state, no per-viewer window — Peter, 2026-08-03: *"the browser is a
presentation layer ONLY, this filtering must be done backend so anyone using the browser
sees the same thing."*

## The board leads with three verdicts

Task `board-panel`. Peter: *"at first glance it has been identical since it was first
built, I see no progress and no evidence that anything is even happening."*

`obsVerdictClass()` colours; `obsSpark()` draws; `obsFrontierRuler()` draws the gap.
**None of the three decides anything** — state and basis are computed by
`db.boardVerdicts()` and this file colours what it is told, per BROWSER_CONTRACT.

Layout is trace → value → context, in that order, matching the sketch Peter drew.

### Referenced, not copied

Peter pointed at the node page as informative and then said: *"dont copy that page, use it
as a ref, i use that page very often because i can see things happening."*

The transferable property is **not** the card layout — it is that every number there is
anchored to NOW: "8m ago", "in 6m 23s", "direct 9m ago". Period aggregates are inherently
less alive, so the loop card leads with a ticking time-since rather than an average. That
is the part worth borrowing.

The stat grammar itself (`stat-title` / `stat-value` / `stat-desc`) is house style already,
and `stat-desc` carrying provenance is exactly where the server's basis string belongs.

### Sparklines break, never zero

A null day breaks the trace rather than dropping to the floor — a gap reads as "not
known", a zero reads as "nothing happened". Same rule as the bands chart. The yield trace
is mostly gaps because of the 5-day blackout, which is correct and not a rendering fault.

### The ruler is a GAP, not a trend

The only glance-graphic here that is not a sparkline, because no sparkline can say "92 of
189, and the notch is over there". That distance is the product.

## `obsFunnel()` — where the candidate pool actually goes

Peter, 2026-08-03: *"I need to be able to see what you see in raw data, but I want to see
it at a glance."*

This was the single most informative thing read from the database during that session that
was not on screen. It explains why a pool of 531 nodes produces a shortlist of 3:

```
3 working now │ 13 cooling·30m │ 46 tried out·6 │ 191 too far·25km step │ 151 silent·14d │ 127 no position
```

**Every segment names the knob that caused it.** "Why is it only trying three things" is
answerable from the page instead of from a query, and each answer points at the setting to
change.

The previous line showed `shown / candidates / cooling / exhausted` — three of the five
exclusions, omitting the two LARGEST. That is how a 25 km step window silently dropping 191
candidates stayed invisible.

Counts are server-computed in `reach.mission`'s summary fact and already rode the existing
`missions` message; this method only lays them out. Segments with a zero count are dropped
so the bar never shows an empty category.

The header line beside it states the three distances together — `aiming past 95.2 km · best
this period 92 km · record 189.1 km` — so the bar being aimed at, the period's achievement
and the ultimate goal are never confused for one another.

## Invariants

- No fetch. Ever.
- Nothing derived that the server could compute.
- A missing value renders as an em dash, never as a zero or a guess.

## Test notes

Live at 1600×1000, all four sub-tabs, both themes, 0 console errors, 2026-08-02.
`ARW1` rendered at 4 hops, −115 dBm, bearing 119° — a distant relayed node with
a bearing, the population that had none before this work.

Map, same session: 220 links drawn, ten captions, all inside the panel in light
and dark. `St. Pierre du Bois 182km +7` is the whole Guernsey cluster under one
label; `?2A0 189km` is the furthest node still waiting on the geocode backfill
and correctly shows its callsign rather than an invented place.

## Out of scope

- Any derivation the server should own.
- The panels still awaiting a feed — they render an empty state naming the phase
  that fills them.
