---
module: app-radar
source: public/app-radar.js
source_hash: 197d9281307806f0ae3e0246a973dbced99a4b7999d9b681588dd7517c95ccbf
updated: 2026-07-02
---

# Module: app-radar

## Purpose

Radar SVG rendering mixin: background/rings, node blips, label arms, target
arm, beam, traceroute overlays. Pure presentation — geometry derived from the
backend-pushed node list and radar context (BROWSER_CONTRACT: display
arithmetic only; no state decisions).

## Task `radar-display` — adaptive scale + rotating label arms

Peter's issues (task goal, 2026-07-02): equi-spaced rings waste the empty
inner/outer bands while ~80% of nodes bunch in one narrow distance band
(measured live: quartiles 22/42.5/48 km; 5 of 13 nodes within 42–49 km);
label arms all leave at the same fixed 45° angle with only length varied.

### 1. Adaptive radial scale (replaces the fixed log curve)

`_radarNorm(km, maxKm)`:
- `radarLogScale` **off** → linear `km/maxKm` (unchanged).
- `radarLogScale` **on** → **piecewise-linear quantile scale**: control
  points at the node-distance quantiles `[0, q25, q50, q75, max]` mapped to
  radius fractions `[0, 0.28, 0.52, 0.76, 0.95]`; interpolate linearly
  between control points. Screen space follows the actual distance
  distribution — the cluster band gets ~half the radius wherever it sits.
- Control distances are rounded (whole km ≥10, half-km below — never
  snapped to preset values: snapping collapsed in-band quartiles to one
  ring and destroyed the adaptivity) and cached in
  `this._radarScalePts`; recomputed only when a control point drifts >15%
  (hysteresis) so the plot does not jitter as nodes come and go. Fewer than
  4 distinct node distances → fall back to the fixed `pow(x, 0.4)` curve.
- This is sanctioned display arithmetic (derived from the displayed list,
  same class as the existing auto-range computation) — no backend state.

### 2. Rings follow the scale

With the adaptive scale on, rings are drawn AT the control distances
(q25/q50/q75/max, rounded, deduplicated) instead of `maxKm·i/4` —
approximately equal screen spacing whose km labels reveal the distribution
(rings crowd in km where nodes crowd, exactly "more space where the cluster
is"). Linear mode keeps the current equi-spaced rings.

`radar.log_scale` default flips to `true` (config-api DEFAULTS) and the
Config → Radar toggle label becomes "Adaptive scale"; linear remains the
opt-out.

### 3. Rotating label arms (constant length, variable angle)

Replaces the cluster/diagLen-rank logic (`CLUSTER_R`/`STEP_DIAG` length
extension at fixed 45°):

- **Placement order:** deterministic — by `_km` then `num` (stable redraws).
- **Candidates:** arm length constant (`BASE_DIAG` diagonal + `HOR_LEN`
  cap). Candidate angles sweep from the preferred angle: 45°, then
  ±alternating steps of 30° through the full circle (12 candidates). The
  horizontal cap and text anchor follow the arm's x-direction.
- **Collision test:** label text bbox (est. 6.5 px/char at 10 px mono) +
  elbow/cap segments tested against all previously placed label bboxes and
  every node dot (r+3). First collision-free candidate wins.
- **Last resort:** if all 12 angles collide, extend the diagonal by one
  `STEP_DIAG` and retry the sweep once; then accept the best-effort angle.
- **Frame stability (per-node angle memory):** chosen angles persist in
  `this._radarLabelAngles` (Map num→angle, declared in app.js state). On
  redraw a node's remembered angle is tried first and kept if still free —
  placement only re-solves when a NEW conflict appears (Peter's
  "recalculate when a new plot falls within an existing node's
  plot/marker/text").

## Files changed

- `public/app-radar.js` — `_radarNorm` quantile branch + `_radarScalePts`
  hysteresis; ring generation from scale control points; label placement
  rewrite in `_drawRadarNodes`.
- `public/app.js` — declare `_radarScalePts: null`, `_radarLabelAngles: null`
  (BROWSER_ARCH undeclared-dynamic-state rule).
- `src/config-api.js` — `'radar.log_scale': true` default.
- `public/partials/tab-cfg.html` — toggle label "Log scale" → "Adaptive
  scale".

NOT changed: traceroute/beam/target-arm drawing, node blip styling,
`radar_context` SSOT handling, backend node list; `_drawRadarTraceroute`
uses the same `_radarNorm` so routes land on the same scale automatically.

## Test notes

Playwright with the live mesh (guide §8 applies to validation even though
the radar page is STYLE_GUIDE-exempt visually):
- Adaptive on: cluster band occupies a visibly larger radial share; rings
  labelled with real km at the quantile distances; no console errors
- Label pass: zero intersecting label bboxes (measure via
  getBoundingClientRect in-page); arms at varied angles; stable across two
  consecutive redraws
- Linear mode: unchanged equi-spaced behavior (regression)

## REQUIREMENT STATUS — adaptive rings are canonical (2026-07-04)

The compressive/quantile ring scale is Peter's standing requirement (task
radar-display goal note, verbatim: rings "should get closer together as
the distance increases", equi-spaced rings are the defect). It is NOT an
optional visualization mode:

- No refactor removes or bypasses `_radarScaleCtrl`/`_radarNorm`. The
  algorithm migrates into the radar-scope library (RADAR_SCOPE_SPEC.md §7)
  carrying the same status.
- The LIN/PWR toggle persists `radar.log_scale`; a single misclick flips
  the page to linear rings, which is indistinguishable from "the feature
  was removed" (this happened 2026-07-04 — git proved the code untouched;
  the config flag was false). If rings look equi-spaced, check the config
  flag FIRST: `PUT /config/radar.log_scale {"value":true}`.
- During SCAN mode with <4 positioned contacts, the pow-0.4 fallback is
  the spec'd degraded mode — not a regression.
