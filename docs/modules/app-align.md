---
module: app-align
source: public/app-align.js
source_hash: 751b1a7b03415b2346ac5bda888f0d28947eef4df1fc224cf6f1213e19f914a1
updated: 2026-07-19
---

# Module: app-align

## Purpose

The mobile Yagi alignment page — used **one-handed at the mast while turning an
antenna**. Companion to `public/align.html`, served at `/align`.

**Presentation layer only.** Per `docs/BROWSER_CONTRACT.md`, this file renders the
align view-model pushed by `src/align-api.js` over `WS /align/events` and computes
**nothing**. Two phones on the same session show byte-identical screens because
both render the same pushed model.

## What the operator needs — three questions

Every element answers one of these, and the **backend** works out the answer:

1. **Is THIS position better than the last?** → `trendDir` / `trendDelta` on the current reading.
2. **Did I find a BETTER position earlier?** → `best`, and each reading's `isBest`.
3. **Is this the BEST?** → `isBest` on the current reading (else the gap the backend supplies).

## The reading

- Big value = **quality** (0–100) with its **label** (Excellent/Good/Fair/Poor) and
  semantic **colour class** — all from the view-model's `current`. Raw dB
  (`rssi`/`snr`) shown small, for the record. The operator does not read dB.
- Trend (`current.trendDir`/`trendDelta`) and the below-best line
  (`current.gapToBest`/`bestN`/`bestAgo`) are pushed, not derived.
- Each press fires a **burst of N** pings (N is a 1–5 control, default from
  `nBurst`); while it runs the button shows `burst.got`/`burst.of` ("gathering
  3/4"). One averaged reading lands, carrying `spread` (± quality) and `got/of`.
- **Bars, one per reading**, newest right: height = `barPct` (backend-computed,
  session-relative). `isBest` → starred + `success`; `isCurrent` → `primary`; rest
  neutral. The tallest bar is the best position — the eyeball answer to Q2.
- Per-radio RX readout: `yagi_q` / `omni_q` (our antennas hearing the device),
  shown as quality; a radio that missed shows a gap, not a zero.

## What the browser is allowed to do (and only this)

- Render/format the pushed fields (`x-text`, `x-for`, `:class`, `:style="height:..."`).
- Hold the **N selector** value (1–5) — raw user input — and send it with
  `POST /align/ping { num, n }`. This is the one value the browser originates
  (BROWSER_CONTRACT §"handle raw user input"); it decides nothing about display.
- Open the WS on load and re-render on each `kind:'align'` frame.

It holds **no derived state**: no best, no trend, no averaging, no bar maths, no
label bands, no quality. If a value is not in the model, it shows nothing — it
never computes a fallback.

## Design — the dashboard's design system, not a new one

`STYLE_GUIDE.md` is canonical (three bespoke attempts were rejected). DaisyUI
semantic classes only — cards, `.stat`, `badge`, `btn`, the type-role table — no
hex/rgba/oklch in markup. No Chart.js; bars are plain DOM. Custom CSS is two layout
declarations (`html,body{height:100%}`, `body{overflow:hidden}`). Controls sit in
the bottom thumb zone. The layout (approved 2026-07-19) is unchanged; this step
only moves computation out of the browser.

## Public interface

Alpine component `alignPage()`: `model` (the last pushed view-model), `nBurst`
(the N selector, browser-held input), `target`, `targets`, `ping()`, `end()`,
`init()`. No derived getters.

## Frame handling (`WS /align/events`)

- `kind:'align'` → replace `model` wholesale and render. Adopt `target` from it.
- No other frame kinds. The socket opens on load so a second phone reflects a
  running session; `_open()` is idempotent (two sockets would double-render).

## Invariants

- **Renders the model; decides nothing.** Enforced by review, not `check_specs`.
- **N is the only browser-originated value**, and it is raw input, not state.
- **PING disabled while `burst.active`** and while no target is selected — but the
  *disabled flag comes from the model where the backend can set it*; the browser
  mirrors it.
- `navigator.wakeLock` held while `running`; `pagehide` beacons `/align/stop`.

## Test notes

- with a pushed model of several readings: bars render at the model's `barPct`,
  best starred, current highlighted, quality label + colour per the model
- pressing PING with N=4 sends `{num, n:4}`; the button shows `got/of` progress
  from pushed `burst` frames; one averaged reading appears
- two browsers on one session render identical screens
- at a true 390×844 viewport, both themes, 0 console errors

## Out of scope

- Any computation of signal, quality, best, trend, or layout scaling — all Node's.
- Dashboard state, nav, drawer; rotator control.
