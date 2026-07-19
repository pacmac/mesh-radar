---
module: app-align
source: public/app-align.js
source_hash: 137aeef325093139fcbb62ef97d09b09b5d36691c853d4d492a0bdee488f7992
updated: 2026-07-19
---

# Module: app-align

## Purpose

The mobile Yagi alignment page — used **one-handed at the mast while turning an
antenna**, not at a desk. Companion to `public/align.html`.

Standalone document served at `/align`, following the `public/debug.html`
precedent (`index.js:233`). It loads none of the dashboard's `app-*` modules and
subscribes to `WS /align/events`, not `/events`.

> **Status, stated plainly: NOT PROVEN TO WORK.** The page renders, the endpoints
> answer, the WS delivers status frames, and the loop dispatches — but **no sample
> has ever reached the page**. Every check run so far tested rendering or
> plumbing. Nothing below is evidence the feature works end to end.

## Responsibilities

- Render: target selector, current reading, peak-hold meter, three stat cards,
  one chart with two curves, marked positions, MARK and START/STOP
- Hold session state: samples, marks, best/worst, probe count
- Compute nothing the server can compute (BROWSER_CONTRACT). `delta` and `direct`
  arrive pre-computed; `running`/`target`/`warning` are server-owned. Session
  best/worst/age/marks ARE the browser's — properties of this alignment session,
  not of the data.

## Design — uses the dashboard's design system, does not invent one

`STYLE_GUIDE.md` is canonical. An earlier cut of this page invented its own visual
language (custom `px` sizes, raw `oklch()`, bespoke components) and was rejected.
It also broke outright: DaisyUI 4.12 exposes theme colours as **OKLCH
components**, so `hsl(var(--bc) / .14)` is invalid CSS and the browser silently
dropped every border and background — the page rendered as bare HTML.

Current markup uses only:

| element | recipe |
|---|---|
| cards | `card bg-base-100 shadow-sm border border-base-300` (§5 card anatomy) |
| section labels | `text-xs font-display font-semibold uppercase tracking-wider text-base-content/50` |
| readings | `.stat` + `stat-title` / `stat-value text-2xl font-mono tabular-nums` |
| data values | `text-sm font-mono tabular-nums` |
| state / marks | `badge badge-lg` with semantic colour variants |
| controls | `btn btn-lg`, `btn-primary` / `btn-error` / `btn-outline` |

Colour is DaisyUI semantic classes only — no hex, no `rgba()`, no `oklch()` in
markup.

**Custom CSS is three declarations**, all layout, none visual:
`html,body{height:100%}`, `body{overflow:hidden}` and
`.chart-fill > canvas{position:absolute;inset:0}` — the Chart.js containment
pattern. Without it Chart.js sizes the canvas from content and pushes the controls
off screen, a bug this page has already had.

### Deliberate deviation from the guide

Readings use `grid grid-cols-3`, **not** `.perf-stats-grid`. That grid is
`repeat(auto-fit, minmax(11.5rem, 1fr))`, so on a 390 px phone it collapses to one
card per row and spends ~230 px on three numbers, starving the trace. Same `.stat`
component, phone-appropriate columns.

### Layout

Flex column, **not** grid rows. The `warning` block is conditional, and with
`grid-template-rows` the positional `1fr` landed on whichever child was fifth —
marks, when no warning showed — ballooning marks into a dead void while the trace
stayed tiny. Flex gives leftover space to the element that asks for it regardless
of index.

Order: target + state · warning (conditional) · signal card (reading, activity
line, peak-hold meter) · three stat cards · trace (`flex-1 min-h-0`) · marks ·
controls.

## Public interface

Alpine component `alignPage()` exposing: `targets`, `target`, `running`,
`warning`, `samples`, `marks`, `best`, `worst`, `spread`, `ageSec`, `activity`,
`probes`, `livePct`, `peakPct`, `fromPeak`, `levelClass`, `ageClass`,
`bestMarkN`, `start()`, `stop()`, `mark()`.

## State

Session state, reset on START: `samples[]` (rolling 5 min), `marks[]`, `best`,
`worst`, `probes`.

**`running`, `target` and `warning` are NOT owned here** — they come from the
server's status frame. Setting `running` locally is what made two browsers
disagree about one server-side session.

Chart.js instance held at **module scope, never on Alpine state** — a live chart
on reactive state gets wrapped in a Proxy and breaks (`app-node-status.js`
lesson). `buildChart()` reuses an existing instance via `Chart.getChart(el)`
because `init()` can run twice and a second construction throws "Canvas is
already in use".

## Invariants

- **The browser decides nothing about the session.** `running`/`target`/`warning`
  come from the server, and the socket opens on page LOAD so a second phone
  reflects a session already running.
- **AGE derives from the newest SAMPLE timestamp**, never from "the socket looks
  open". Over a mobile link the socket dies silently (bugs #10) and a frozen curve
  is worse than a blank one.
- **Activity must always be visible.** `activity` reports probes sent and time
  since last reply, so "working, waiting" is distinguishable from "broken".
- Controls at the bottom — the top of a phone is unreachable one-handed.
- BEST/WORST reset on START.
- Chart updates in place (`update('none')`, `animation:false`); never
  destroy-and-rebuild.
- Meter scale is FIXED (`-20 … +12`) and never auto-ranges — a self-remapping
  meter moves when the signal does not.
- `navigator.wakeLock` held while running, released on stop.

## Test notes

**Verified — rendering and layout ONLY:**
- renders at 390×844 in both themes, 0 console errors, no scroll
- no overlap: trace / marks / controls measured by bounding box
- stat cards sit three-across at 390 px
- with an injected sweep: peak marker held at 98% while live sat at 56%,
  `13.2 dB below peak`, PEAK 11.2, WORST −14, SPREAD 25.2, one mark chip

**NOT verified — the feature itself:**
- no sample has ever arrived from a real traceroute
- the two-curve design is unproven on air — whether both radios' receptions reach
  `onResult` separately has never been observed live
- `fromPeak`, `levelClass` bands and the stale/dead AGE transitions have only been
  exercised with injected data
- the dead-man stop has never been triggered by a real disconnect
- cross-browser sync was verified only by two WS clients receiving identical
  status frames, never with two real sessions

## Out of scope

- Any dashboard state, nav or drawer — this is not an SPA route
- Deciding whether a reading is direct — the server sends `direct`
- Rotator control. PASV is assumed; the page neither points nor parks it.
