---
module: tab-observatory
source: public/partials/tab-observatory.html
source_hash: 9c9ad278f6484c6a6e1036858d53e492d8f8f0f98aa1d12bfb7133681224ab9c
updated: 2026-08-04
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


## The board leads with the gap, and the cards are legible

Task `last-hit-card`.

**Order.** Peter, 2026-08-03: *"I think that the frontier full width card should
be at the top."* The gap between where we are and the record is the page's whole
question ("how far can we get"), so it leads. The four verdict cards sit under
it as the supporting detail.

**LAST HIT** joins LOOP / YIELD / FRONTIER — the top row is now
`sm:grid-cols-2 lg:grid-cols-4`. It answers the one thing the other three never
did: *what did we actually reach, and when*.

There is no separate "last frontier hit" card. The furthest answered target IS
the frontier card's own number, so a second card would print `176.2 km` twice
and cost a fifth column. The frontier card gained the location instead.

### Two lines per card, one job each

```
176.2 km                        <- the value
mu7gci office · 166° · Castel   <- where  (locates)
record 189.1 km unbeaten 29d    <- basis  (judges)
```

Both strings are server-built (`BROWSER_CONTRACT`). They were one line first,
which ran to 110 characters, overflowed the card, and repeated the value printed
directly above it.

### The card text was barely legible

Peter: *"the light grey fonts you are using in cards is barely legible."* He was
right, and it was DaisyUI's default compounded by my own `opacity-60`.

`.stat-title` and `.stat-desc` carry a `0.6`-alpha colour **and** an element
opacity (`0.5` / `0.45`), which multiply:

| element | effective alpha before | after |
|---|---|---|
| `stat-title` | **0.30** | 0.75 |
| `stat-desc` | **0.27** | 0.80 |
| secondary line | 0.36 | 0.60 |

`opacity-100` cancels the element opacity so the colour token's own alpha is the
only thing dimming the text, then `text-base-content/{75,80,60}` sets it
deliberately. Applied to every stat card on the board, not just the new one —
the base default was the real problem.

Note on method: two attempts to compute WCAG contrast ratios in-page returned
garbage, because these themes use `oklch()` and neither a regex nor a canvas
`fillStyle` round-trip normalised it. Effective alpha is the figure above because
it is the one actually measured; the ratios were discarded rather than reported.

## Frontier card — the distribution, not the maximum (task `frontier-strip-card`, 2026-08-03)

Peter, 2026-08-03: *"I want the top frontier card to be formatted to show the
current window, and the nodes heard and their distance and maybe signal strength
in each bar as a colour"*, in the grammar of the mission-control mockup's top
strip.

The card was one progress bar carrying two scalars across the full page width.
It now draws `board.frontier.strip` — one bar per positioned node on a distance
axis, 503 of them.

### What the browser does, and what it must not

Everything meaningful arrives pre-computed from `boardVerdicts()`: `km`,
`hit_rate`, `direct`, `snr_db`, `tone`, `label`. The browser performs **display
arithmetic only** — the same licence the radar has:

- `left: km / span * 100%` — position on the axis
- bar height from `hit_rate`, with a floor so a 0% bar is still visible as a
  *placed* node rather than vanishing
- `tone` → CSS class, a lookup, not a judgement
- for `signal` bars only, opacity ramped across the LoRa demodulation range
  (−20 dB floor to +12 dB) — normalising a server-supplied dB number, not
  deciding what counts as strong

**It classifies nothing.** No thresholds, no binning, no deciding which nodes are
interesting. If a future change needs the browser to decide, the decision belongs
in `boardVerdicts()` — see the parked `park-strip-browser-logic`.

### Colour is only honest for 27 of 503

`snr_db` is non-null only where `direct` is true, because `signal_history`
records direct receptions. Non-direct bars take a flat neutral tone and **must
never** be coloured by signal — the RSSI we hold for them describes the relay
that carried them, not the node. A 180 km bar tinted "strong" would claim reach
we do not have.

The legend states the split explicitly, so the card shows how thin our direct
reach actually is rather than hiding it behind a full-width gradient.

### The window is named

The footer said "this period" without ever saying what the period was.
`window_days` now comes down on `frontier` and the card reads "last 7 days"
(`0` → "all time"). The selector on the Charts tab writes the same server-side
`observatory.window_days`, so both pages agree by construction.

`best_km` replaces the misleading `window_km` in the header — that value is the
best distance reached *within the window*, never a distance window.

### The axis reads as distance, because it was read as time

Peter, 2026-08-03: *"the target of 189km is shown at the end, that was weeks ago.
this is against time in the x axis doesnt it."*

It is not — x is **distance from us**, and 189.1 sits at 92% because it is the
furthest, not the latest. That misreading was the labelling's fault, not his: the
card this replaced ran "this period" → "all-time" left to right, so a left-to-right
time reading was the trained expectation.

Two fixes, both from the mockup's own grammar:

- position 0 is labelled **`us`**, not `0`. An axis that begins at "us" cannot be
  read as a timeline.
- the card title carries the dimension: *"every positioned node by distance from
  us"*.

A chart whose axis can be misread is not a labelling detail — every conclusion
drawn from it is wrong in the same direction.

### The labels sit on their notches

Peter, twice: *"189km is still at the end."* The second time was still correct,
and the cause was not the notch — it was the **label**.

The header row was `flex justify-between`, which pins `189.1 km record` hard
against the card's right edge no matter where its notch stands. Fixing the axis
scaling moved the notch to 75.6% and left the label at 100%, so the card still
read "the record is the end of the line".

Each label is now absolutely positioned at its own notch and opens **outward** —
best reads leftward from its mark, record rightward from its — so they cannot
collide despite sitting ~5% apart.

Verified by geometry, not by eye: on a 1336.5 px card, `176.4 km` ends at
937.4 px against its notch at 936.3 px; `189.1 km record` begins at 1003.9 px
against its notch at 1002.8 px; 66 px clear between them, and the record label
now ends at 84% of the card instead of at its edge.

### The axes were the wrong way round — TIME on x, DISTANCE on y

Peter said this in his **first** message about the card and I built a distance
ruler anyway, twice, then argued when he repeated it: *"i already told you the x
axis is time not istance. the y axis is distance."*

A distance ruler cannot answer the question the card exists for — **is the
frontier rising?** — and it parks the all-time record near the right edge purely
because the record is a large *number*, which reads as *recent*. Rescaling the
axis, relabelling `0` as `us`, and moving the labels onto their notches were all
fixes to the wrong chart. Every one of them left 189.1 "at the end", because the
axis was the wrong **dimension**.

Now: one **bar** per answered traceroute — standing at *when*, rising to *how far*, the all-time record as
a horizontal **ceiling**, the window's best as a second line, day gridlines on x
and a km scale on y.

Two defects fixed on sight after the first render:

- the reference labels sat ~6% apart on a 96 px plot (~6 px) and overlapped into
  an unreadable smear. Record now rides **above** its line and best **below**
  its own, so they separate by construction however close the values get.
  Measured after: 175 px vs 196 px, 21 px clear.
- there was no y scale at all, which makes a dot's height unreadable — the entire
  point of putting distance on y. Ticks now at 50/100/150/200 km.

Verified live: 63 dots in the DOM over a 7-day window, x labels Jul 28 → Aug 3,
record line at 90.9% and best at 84.8% of the plot height.

### Doors: routers are not clients that happened to relay

Peter, 2026-08-04: *"we are still treating routers and clients the same and they
are all grouped into doors in the dashboard."* He was right — `relayUsage()`
carried label, place, bearing and usage but no role, so the panel could not tell
infrastructure from an accident.

The payload now carries `role`, `kind` (`router` | `relay` | `never`) and
`is_router`, decided server-side. The table gains a **Role** column: declared
routers get an amber badge and an amber label, everything else reads "relay
only" in muted text. The caption counts them — **19 declared routers · 78 relay
only** — instead of a single undifferentiated total.

Why it earns the column: **6 declared routers carry 2865 of our completed routes
(95.1%)**; the 11 observed relays carry 148, and 4 of those are our own radios.
The top four doors by usage — `T4`, `fir`, `TE 5`, `S2` — are all ROUTERs.

The role string is rendered **verbatim** rather than mapped to a friendly label,
so a junk value stays visible (B77: three nodes carry `role = "200.0"`) instead
of being silently folded into "relay only".
