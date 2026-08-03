---
module: tab-observatory
source: public/partials/tab-observatory.html
source_hash: 2490f383cf23825670d1120f6ff28a6d25c325bab43035e357371d96d3a9f884
updated: 2026-08-03
---

# Module: tab-observatory

## Purpose

The Observatory page — main menu, below Radar. Renders `observatoryMixin`
(`docs/modules/app-observatory.md`). Presentation only.

Peter, 2026-08-02: *"a new page in the main menu, below radar, so that I can see
the page growing with live data as it is added"*, and on watching me read numbers
out of a terminal: *"you can see data, I see nothing at all."*

## Built whole, populated only by real data

Peter: *"create the page and all of it's elements, but dont populate the data
with dummy data, so that I can see more and more real data appearing as the
feeds develop"* and *"so many fields or lists or tables would be empty now and
only those that are live data are populated."*

So **every panel is present and correctly shaped from the start**, and a panel
with no feed says exactly what it is waiting for and names the phase that
supplies it. No placeholder numbers, no fake rows, nothing that could be
mistaken for a measurement. As each phase lands its panel fills and **nothing
moves**.

| panel | today |
|---|---|
| Furthest verified reach | **live** — `reach.ladder` |
| Doors | **live** — `relay.usage` |
| Bearings recorded / Nodes seen | **live**, on screen |
| Radar | **live** — `reach.target`, full page |
| Map | **live** — `link.observed`, full page, classified and named |
| Missions | **live** — `reach.mission`, ranked and explained |
| Record ladder | **live** — `reach.ladder` |
| Receptions | **live** |

### Missions panel

Rows come ranked, classified and explained. The page renders the server's
`reason` string verbatim — **it must never assemble an explanation out of
numbers** — and colours the class dot: `bg-accent` for `unknown-record`,
`bg-primary` for `record`, `bg-secondary` for `unknown`, muted for `reconfirm`.

The header carries the published exclusions (`19 of 227 candidates · 7 cooling ·
22 exhausted`), and the footnote states plainly that **nothing is dispatched from
this panel**: traceroute dispatch already exists elsewhere and is what the list
is for; the broadcast callout remains unbuilt.

Scrolls at `max-h-80` — verified 853 px of content in a 340 px box, scrolled to
the bottom, all four classes reachable.

### The feed summary line

`obsFeedSummary()` reports rows on screen and how many carry a bearing. Counting
the *rendered list* is expressly allowed — it describes what is on screen, not a
claim about the mesh.

### Map legend

Three swatches, shown only when their count is non-zero, driven by
`meshLinks().legend`. The page counts nothing and names no class — it picks a
swatch colour per class, and those colours **must stay in step with `C_CLS` in
`app-observatory.js`**. Legend swatches are Tailwind classes on real elements, so
they compile; the SVG fills cannot be and use DaisyUI variables instead.

The caption under the map explains the two size encodings — relay radius is
traffic carried, line weight is how often that hop was witnessed — because a
size difference with no stated meaning is decoration.

## Discovery panel — top of the left column

Peter, 2026-08-02: *"I still see no signs of activity on the dashboard, as far as
I can see it is static"*, then on finding it: *"the discovery card should be
above missions, i.e. at the top"* and *"well if it's there it's not very
obvious."*

All three were the same fault. The panel was working — 23 attempts, 22 completed,
a mission in flight — but it sat **third in the right-hand column, below the
fold**, while the left column ended at the Frontier table and left half the board
empty. The one thing on the page that is happening *right now* required
scrolling to find.

It now sits at the **top of the left column**, level with Missions, both above
the fold. Full width was the first attempt and was wrong — Peter: *"no need for
that to be full width, there's very little data / columns in it, it can be 2 col
layout."* Four narrow columns do not earn the whole board.

The status is a badge with a pulsing dot rather than grey micro-text, and the
header carries `24 tried · 0 answered` so the counters move where they can be
seen. The outcome column wraps rather than clipping: in a half-width panel a
truncated result is the one thing that must never be truncated.

Board layout is now balanced — Discovery + Frontier | Missions + Doors.

If a glance cannot tell you whether the mesh is being probed, the panel has
failed at its only job.

## Discovery panel

Peter, 2026-08-02: *"what I expect to see is a table of the discovery mission,
i.e what it's done, doing right now and whether a discovery is in progress."*

Three parts, in that order:

1. **Status line** — `IN PROGRESS`, `idle · 1 every 3 min · 18 queued`, `HELD —
   automatic traceroute is off`, or `stopped`. The panel explains itself when
   nothing is moving, which is what an empty table never does.
2. **In progress** — the single target being pursued, with the radio, the place,
   the distance and the mission's reason.
3. **Done** — newest first, and the last column is **what it revealed**, not
   hit/miss. A reply reports hops out and back plus new relays, new links and
   return-only hops; a miss reports `no reply after 90s`, because §4 says silence
   is evidence and a feed showing only successes would misrepresent it as absence
   of attempt.

Above the table, a discovery tally: attempts, replies, new relays, new links,
records. The point is watching the web grow, not a hit counter.

## Sub-tabs

Peter: *"maybe we need a main menu and sub menus for this? … that way debug sub
pages can be added and we still have the main nasa dashboard."*

**Board** is the dashboard. **Receptions** is the raw feed on its own page. The
first version had them sharing one screen, which meant the board could never stay
clean and every future diagnostic would have cost it space. Adding the tenth
debug view now costs the board nothing.

Same `tabs tabs-bordered` shape as `tab-cfg.html` / `tab-control.html`.

## Design reference

`public/_mockup-mission-control.html`, served at
`http://192.168.10.205:8000/_mockup-mission-control.html` — **frozen**. Peter,
twice: *"keep the static page as a reference, do not delete it"*, *"this page
must stay… it is a reference and is stand alone."*

The live page is built by **copying** it, never by editing it. The reference is
never wired to data, never re-pointed, never overwritten by what derives from it
— that freeze is what lets the shipped page be diffed against the agreed design.

## Honesty rules on this page

- **A bearing renders as an em dash when absent, never as 0.** North is a real
  bearing; a blank must not read as one.
- **Relayed packets are shown, not filtered.** The distant nodes worth locating
  are exactly the ones that arrive via relays.
- **The bearing column tints rows rather than filtering them** — hiding the
  bearing-less majority would hide how much traffic carries no bearing, which is
  itself worth seeing.
- **There is no arrival-path column, and there must not be one.** MQTT arrivals
  never enter the store (spec §3a) — they are dropped at the mapper — so every
  row on this page was heard on air by construction. A column reporting that
  would always say the same thing.
- **Empty panels say "waiting for a feed, not for data."**
- Counts labelled "on screen" are the rendered list, not a claim about the mesh.

## Pins and the MANUAL state

Each Missions row carries a pin. Pinning writes `discovery.pinned`, a single
value, so pinning another target **moves** the pin rather than growing a list —
concentration is the point.

The status line reports **`MANUAL · nothing selected`** when the mode is manual
and the queue is empty. That state is the reason a real `manual` mode exists:
an empty queue with no explanation reads as broken, which is the failure this
panel was built to prevent.

## The controls live where the work is

Peter, 2026-08-02: *"I also asked you to add tuning knobs, and the ability to
select a node and favourite it, and to be able to override and select nodes
myself to target. I see none of that either."*

All three existed — on **Config → Discovery** and the **Nodes** page. Neither is
the page he works on. Confirmed not a caching problem: the service worker only
handles `/`, `/app.js`, `/style.css`, `/config.js`, network-first.

**A control the operator cannot find is a control that does not exist.** This was
the second time in one session that something built and Playwright-verified was
invisible in practice, so the rule now is: put it where the work happens.

- A **control strip** at the top of the Discovery panel: mode, window, tries,
  interval, silence cutoff, on/off. Saves on change; values still clamped
  server-side. Config → Discovery keeps the full set with the explanatory text —
  the strip is the subset you reach for mid-session.
- A **crosshair** on every Missions and Frontier row, and the pin beside it. The
  same endpoint the Nodes page uses; a second *place*, not a second mechanism.

## BRG and AGE on every table

Peter: *"something missing from every table is 1: bearing, 2: since. the column
titles can be abbreviated (or use an icon instead) so that the title fits the
data in the column and not the other way around."*

`BRG` and `AGE` on Frontier, Missions and Doors, both server-computed
(`observatory-ws.js`), `AGE` shipped as the short string the column shows plus
raw seconds for tinting: green under a day, muted under a week, warning beyond.

That tint is not decoration — a node heard today answers 16–26% of the time and
one silent over a week 1.8%, so the colour is the single most useful thing in
the row. On Doors it is the early warning that matters most: everything behind a
quiet door goes quiet with it.

## Charts sub-tab

Four charts, each answering a question that was being answered by hand against
the same tables: the record over time, attempts and answers per day, answer rate
by silence, answer rate by distance. A chart nobody has needed is decoration —
that is the selection rule. Full rationale in `docs/OBSERVATORY_CHARTS.md`.

The record chart **steps** rather than slopes: the record is a ratchet that holds
until beaten, and interpolating between rungs would draw a climb that never
happened.

## Charts sub-tab — window selector and the bands chart

Task `bands-chart`.

A window strip sits above the grid: `all time / 1d / 7d / 30d / 60d` as a `join` of
buttons, the active one driven by `charts.window_days` from the server rather than by
local state. Beside it, two numbers that answer different questions and are labelled as
such — `record` (all-time, the thing to beat) and `best in window`.

The bands chart spans both columns (`xl:col-span-2`) and leads the grid, because it is
the only chart that separates a change in target mix from a change in performance.

## Logs sub-tab

Task `logs-page`. Peter, 2026-08-03: *"we need a logs sub page, it is a log of real time
events as well as changes in logic etc… from that table a timeline could also be
generated."*

Three panels from one table:

- **Event log** — filterable by `all` / `changes` / `probes` / `tasks`. Severity colours
  the summary; `notice` and `fault` stand out against `info`.
- **Probe traces** — grouped by `probe_id` and **reversed to read forwards**. The log reads
  newest-first, but a trace is a sequence and reversing it would make the narrative
  nonsense.
- **The pipeline** — every declared hook with its scope, name, purpose and modes. Served by
  the server, not inferred here. This is the direct answer to "the logic is hidden": the
  system states what it executes without anyone reading code.

**Every string is written by the hook that made the decision.** The page filters, groups
and lays out; it composes nothing.

### What it surfaced immediately

```
12:13:12  aim-antenna  could not aim at 106° — beam held by another user
```

A mission deferred because the garage alarm held the rotator. That left no trace anywhere
before this page existed, which is exactly the class of thing it is for.

Verified 2026-08-03 at 1600×1000 in both themes; 36 events, 9 hooks, 2 probe traces, and
the grid genuinely scrollable (1258 px of content in 812 px).

## Invariants

- Nothing fetched. Everything arrives over the WS.
- No panel invents a value to look populated.
- Relay labels come from the server (`relay_usage.label`), never a browser
  lookup — `this.nodes` is filtered and produced raw numbers.

## Test notes

Live at 1600×1000, both sub-tabs, both themes, 0 console errors, 2026-08-02.
Doors rendered `T4 / fir / TE 5 / S2 / TivN` with targets-behind and
traffic-carried; the outbound-only subset of those figures reproduces the
hand-computed values from the same evening exactly.

## Out of scope

- Any derived value the server should own.
- The panels awaiting a feed — each fills in its own task.


## Type does not go inside a stretched SVG

Task `frontier-ruler-type-scale`. Peter, 2026-08-03: *"the frontier and the other
new stats card text is huge and disproportional with everything else on the
page."*

The frontier ruler was one `<svg viewBox="0 0 520 40">` holding **both** the bar
and its labels. Stretched to the card width it rendered **1309 px wide — a 2.52x
uniform scale** — so `font-size: 11` painted at **27.7 px**, larger than the
biggest stat value on the page (23.8 px) and more than double body text
(12.75 px). The `9 px` caption painted at 22.7 px.

The same scale caused the collision: the two value labels were positioned in
520-unit space with no knowledge of how wide they would actually paint, so
"175.7 km" and "189.1 km" ran through each other into an unreadable smear.

**The rule, which is the actual fix:** SVG is for geometry, whose whole purpose
is to scale. Type must not scale — it belongs to the page's type ramp. So text
is rendered as HTML, always, and `viewBox` units are reserved for shapes.

This is the second time the defect shipped. It was called out first on the bands
chart (*"why are the fonts so huge, that new chart bears no resemblence id
design"*), which was fixed as an instance. Fixing the instance again rather than
naming the rule would have guaranteed a third.

### What replaced it

Three HTML rows, no `viewBox` anywhere:

```
175.7 km                                  189.1 km record
[==========================o===========|=========]
this period                                     all-time
```

- Rows 1 and 3 are `flex justify-between`. The ends **cannot collide by
  construction** — no clamp to get wrong.
- Row 2 is the geometry: a track, a `--p` fill to `window_km`, a dot at its head,
  a notch at `record_km`, positioned by percentage so it stays responsive.
- Every size is `text-xs` (12.75 px), already used by `stat-desc`. Nothing new
  was introduced into the type scale.
- `obsFrontierRuler()` (returned an SVG string) became `obsFrontierPct()`
  (returns two percentages). The 8% headroom past the record is kept, so the
  notch never sits on the edge reading as "we are at the end".

The stat cards were deliberately **not** touched: they measure 23.8 px
consistently with each other and with the rest of the site, so they were not the
disproportion. The ruler was.

### The check that keeps it fixed

Effective size, not declared size:

```js
declaredFontSize * (renderedWidth / viewBoxWidth)
```

Requirement: **no SVG text on the page exceeds 13 px effective.** Verified 0
violations after the change, with all four ruler labels at 12.75 px and no
overlap (first label ends at x=328, next begins at x=1456).
