---
module: app-align
source: public/app-align.js
source_hash: 20d51141633e4dbd87a16ea83de576704911a6a485eca59b134d0c41858fe5a7
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

## Layout (portrait phone, top → bottom)

| region | contents |
|---|---|
| header | favourite selector, live dot |
| headline | current YAGI SNR, large; delta-over-omni beneath |
| stat row | **BEST** · **WORST** · **AGE** (`.stat` cards, as the perf page) |
| chart | ~5 min, YAGI solid / OMNI dashed, marks on the axis |
| marks | ① 8.5 ② 12.8★ ③ 6.0 — best starred |
| controls | **MARK** and **STOP** — bottom, thumb zone |

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

- renders at 390×844 (phone portrait) in **both themes**, no horizontal scroll
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
