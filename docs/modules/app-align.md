---
module: app-align
source: public/app-align.js
source_hash: 84ea836b5930313d3ba26dc820ed2820746d6c57c1325275c6953d1e1afac3cd
updated: 2026-07-19
---

# Module: app-align

## Purpose

The mobile Yagi alignment page — used **one-handed at the mast while turning an
antenna**, not at a desk. Companion to `public/align.html`.

Standalone document served at `/align`, following the `public/debug.html`
precedent (`index.js:233`). It loads none of the dashboard's `app-*` modules and
subscribes to `WS /align/events`, not `/events`.

## Responsibilities

- Render: target selector, big current reading, three stat cards, one chart with
  two curves, position marks, START/STOP and MARK
- Hold the session: samples, marks, best/worst
- Compute nothing the server can compute (BROWSER_CONTRACT) — `delta` and
  `direct` arrive pre-computed. Session-scoped best/worst/age ARE the browser's,
  because they are properties of *this* alignment session, not of the data.

## Layout — a field instrument, not a dashboard page

Read at arm's length, in sunlight, one-handed, while turning an antenna. One
loud element, everything else deliberately quiet.

CSS **grid** with explicit rows — `auto auto auto 1fr auto auto`. This is not a
style choice: a `flex:1` chart with no definite height lets Chart.js size the
canvas from content and push the controls off-screen, which is exactly what
happened in the first cut. The trace row is `1fr` with `min-height:0`, and the
canvas is `position:absolute; inset:0` inside a `position:relative` wrapper —
the standard Chart.js containment pattern.

| row | contents |
|---|---|
| 1 | target selector + LIVE/STALE/IDLE state |
| 2 | server `warning`, only when present |
| 3 | **readout + peak-hold meter** — the signature |
| 4 | WORST · SPREAD · AGE — small, quiet supporting figures |
| 5 | trace: ~5 min, YAGI solid / OMNI dashed (`1fr`, cannot overflow) |
| 6 | marks, then MARK / START-STOP in the thumb zone |

### The peak-hold meter (signature element)

Borrowed from field-strength meters: the live level moves, a marker **holds** at
the session best. Closing the gap between them IS the alignment task, so the
operator reads position rather than numbers. Fixed scale
`SCALE_MIN -20 … SCALE_MAX +12` dB SNR — **never auto-ranging**, because a
self-remapping meter moves when the signal does not, destroying the one thing it
is being read for. Fill colour is signal-coded (`success` ≥5, `warning` ≥-5,
`error` below), so the colour states link quality rather than decorating.

Verified rendering with an injected sweep: live 56% amber, peak held at 98%,
`PEAK 11.2`, WORST -14, SPREAD 25.2 — and the live/peak gap visible at a glance.

## Public interface

Alpine component `alignPage()` exposing: `targets`, `target`, `running`,
`samples`, `marks`, `best`, `worst`, `ageSec`, `start()`, `stop()`, `mark()`.

## State

Session state only, reset on START: `samples[]` (rolling 5 min), `marks[]`,
`best`, `worst`. Chart.js instance held at **module scope, not on Alpine state** —
storing a live chart on reactive state wraps it in a Proxy and breaks it
(`app-node-status.js` learned this the hard way).

## Invariants

- **The MARK button is the point of the page.** The chart is signal vs *time*;
  the operator thinks in *position*. Marks convert time into numbered positions so
  "go back to ②" replaces recalling where the antenna was 40 s ago.
- **AGE is derived from the newest sample's timestamp**, never from "the socket
  looks open". Green <15 s, amber <30 s, red beyond. Over a mobile link the socket
  dies silently (bugs #10) and a frozen curve is worse than a blank one — it is a
  lie the operator will act on.
- **Controls at the bottom.** The top of a phone is unreachable one-handed with an
  antenna in the other.
- **Solid vs dashed, not colour alone** — direct sunlight defeats hue.
- **BEST/WORST reset on START** — they mean "this session at this mast".
- Chart updates in place (`chart.update('none')`, `animation:false`); never
  destroy-and-rebuild. Rebuilding on each sample is what caused the
  destroy-during-animation crashes on the node focus page.
- Theme recolour via MutationObserver must cover **every** axis and tick, not just
  the dataset — that omission recurred three times on the node focus page.
- `navigator.wakeLock` held while running, released on stop. Released is the safe
  default; a page that holds it after stop drains the phone in a pocket.

## Test notes

- renders at 390×844 (phone portrait) in **both themes**, no scroll at all
- **no overlap**: measured geometry — trace ends 728, marks 736-770, controls
  778-836 in an 844 viewport. The first cut overlapped the controls; assert on
  bounding boxes, not on the elements existing
- the peak marker holds while the live bar falls (inject a descending sweep)
- meter never auto-ranges: the same dB always maps to the same width
- a sample with `omni: null` leaves the dashed curve gapped, does not crash
- AGE crosses green → amber → red as samples stop
- MARK appends a numbered entry; the highest-delta mark carries the star
- START resets best/worst/marks
- STOP releases the wake lock and closes the socket
- the page loads **zero** dashboard `app-*` modules — asserted by grep

## Out of scope

- Any dashboard state, nav, or drawer — this is not an SPA route
- Deciding whether a reading is direct — the server sends `direct`
- Rotator control. PASV is assumed and the rotator does not self-move; the page
  neither points nor parks it.
