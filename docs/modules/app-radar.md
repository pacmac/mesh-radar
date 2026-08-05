---
module: app-radar
source: public/app-radar.js
source_hash: 4d98c371d4d63177e223443ee220e4f32bada6c859dbcfaa4848d4a43f88f87f
updated: 2026-08-04
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

## Node blip radius (task `radar-dot-2x`, 2026-07-09)

The plotted node dot radius was doubled — `r = isSelected ? 6 : 4` (was `3 : 2`).
The colored proximity halo (`r + 2`) scales with it; the selection ring (`r: 8`)
and label offset are unchanged.

## Per-hop SNR labels (B72, 2026-08-03)

`_drawRadarTraceroute` labels each adjacent hop with its SNR. Those values arrive
**already in dB with `null` for unmeasured hops**, decoded once at the `app-ws.js`
ingest boundary — this mixin does no arithmetic on them.

It previously divided by 4 here but had **no sentinel guard**, so a hop the
firmware could not measure was drawn as a confident `-32.0`. The existing
`!= null` test now filters those correctly because the sentinel becomes `null`
at ingest. The local is named `snrHopDb`, not `snrRaw` — it is not raw, and the
old name was part of how the bug survived.


## The quantile scale is SERVED (task `radar-scale-to-backend`, 2026-08-04)

This spec previously argued `_radarScaleCtrl` was *"sanctioned display arithmetic
(derived from the displayed list, same class as the existing auto-range
computation) — no backend state"*. Defensible, and it is now superseded.

**The quantiles are a property of the DATA.** The backend already holds every
distance, so computing them on both sides invites disagreement — which is exactly
how the region-frequency table ended up with three drifted copies (B80).

`radar_context.scale` carries `{ max_km, kms[], fracs[] }`, computed in
`ws-relay.js` from `nodeList.nodes[]._km` — the **same field and the same filtered
list** the browser plots, so the rings still describe what is on screen rather
than the whole store.

**Hysteresis moved with it.** The 15% drift guard exists so rings do not jitter as
nodes come and go, and that only works if one side owns the previous value. Split
across the boundary it would fight itself.

`_radarScaleCtrl` is now a lookup. **`_radarNorm` stays** — piecewise-linear
interpolation from a distance to a radius is display, and the fixed `pow(x,0.4)`
fallback still applies when the server sends `null` (fewer than four distinct
distances), which remains the spec'd degraded mode.

The adaptive rings remain **canonical**, per the REQUIREMENT STATUS section above.

### Verified

Served `{max_km:100, kms:[3,31,44], fracs:[0.28,0.52,0.76]}`, matching what the
mixin returns. The curve is still compressive — 1 km→0.093, 5→0.297, 20→0.426,
42→0.723, 60→0.814, 100→0.95, so the first 5 km takes 30% of the radius and the
last 40 km takes 14%. Rings render at 3 / 31 / 44 / 100 km with 21 nodes plotted
and 0 console errors.

Two mistakes on the way, both caught by checking the served payload rather than
assuming: the first version read `n.lat`, which nodes do not carry (they hold
`position` and a precomputed `_km`), so every scale came back null; and the
browser property is `radarCtx`, not `radarContext`.

## Node marks by kind, and the endpoint fade (task `radar-node-icons`, 2026-08-05)

Peter, 2026-08-04:

> the current dash is saturated with every node plotted the same with no
> indication of whether it is a target, a relay / router

> with endpoints we should either be able to hide close ones or have a dimming /
> opacity that starts in the ctr barely visible and the further out they go they
> get more prominent, that will still show all nodes but will focus the eye on the
> distant nodes

### A glyph per kind

`node_kind` is **served** (`src/node-kind.js`, stamped on every `node_list` row).
This file maps the token to a shape and does not work the kind out for itself —
a presentation mapping of a served value, exactly like the TONE map.

| kind | glyph | why |
|---|---|---|
| `endpoint` | crosshair — dot with four gapped ticks | a destination, not a way through |
| `door` | diamond **outline** with a filled core | a way through; distinct from a dot at 8 px |
| `router` | filled dot, dashed orbit, two panel ticks | a declared relay — a dish |
| `own` | small square | our own radios |

An absent or unknown `node_kind` falls back to `endpoint`, so an older payload
degrades to the previous behaviour rather than drawing nothing.

**The door glyph must not assume the backdrop.** The first cut punched a hole in
the diamond with `fill:var(--radar-bg, #000)`. That variable does not exist, so it
resolved to black — fine on the dark radar, a black blob anywhere else. It is now
an outline plus a filled core, drawn only in the node's own colour. Nothing in a
glyph may reference the background.

### The endpoint fade

`markOpacity(kind, norm)` ramps opacity from `ENDPOINT_FADE.near` (0.22) at the
centre to `1.0` at the rim.

Two deliberate constraints:

- **Endpoints only.** Doors and routers stay at full opacity regardless of
  distance. A door 5 km away is the single most important mark on the display —
  66% of everything we transmit leaves through T4 at 5.3 km — so fading it by
  distance would hide the thing the engine depends on. Distance is a proxy for
  "interesting" only among destinations.
- **It follows `norm`, not raw km.** `norm` is the already-computed radial
  position, so the fade uses the same compressive ring scale as the rings
  themselves. Against raw km the entire dense inner band would vanish at once.

`norm` is carried through on the `npos` entries (which the label collision solver
mutates in place, so it survives).

`ENDPOINT_FADE` is a named constant with its rationale at the declaration rather
than an inline literal. If it wants tuning it should become a served knob, not a
browser-side edit.

### Verified 2026-08-05

Rendered at 1600x1000 and looked at, not merely queried:

- crosshairs visible on MOHS, FYU, 7mrb, exw1, SR#9, GZG/WEI/OVEA
- door diamonds confirmed in the DOM for the two `door` nodes (BNCH, TA2m)
- opacities ramp across the set: 0.23, 0.45, 0.52, 0.62, 0.67, 0.76, 0.91, 1.0
- 0 console errors

**Known:** the radar surface renders dark under both DaisyUI themes — it carries
its own styling and does not follow `data-theme`. Setting `data-theme=corporate`
changed the attribute and left the radar unchanged. Not altered here; recorded so
the next reader does not think the theme switch is broken.

## Cluster overlay and layers (task `radar-cluster-overlay`, 2026-08-05)

Peter, 2026-08-04:

> the same radar only with different overlays

> sort of clouds, or blobs etc showing the extent of them

> I may only want to see a target node and see the cluster, router and doors only
> without the clutter of all the other nodes

Everything drawn is **served** — hull polygon, name, purity, verdict and tone all
come from `GET /clusters` (`src/clusters.js`). This file projects lat/lon to
screen and maps a served tone to a colour. It decides nothing about what a
cluster is, where it ends, or whether it is solved.

### Two readings of one radar, not one pile

The first cut drew all 52 blobs with two lines of label each **on top of** the
nodes. That was measurably worse than the saturation it was meant to fix — 104
overlapping text lines. Recorded rather than quietly tuned away, because it is
the failure mode this feature exists to prevent.

The fix is not a magic threshold, it is that clusters and endpoints are two
*readings*:

| endpoints layer | clusters render as |
|---|---|
| **on** | quiet context — outline only (`fill .05 / stroke .28`), **no labels**, and 2-member groups suppressed entirely |
| **off** | the subject — filled (`.14 / .65`), named, with purity |

Labels therefore arrive exactly when there is room for them, and no number had to
be invented for it.

### Who gets a label

Only clusters with **≥3 members**, and only in the cluster-first reading. A
two-member group is barely a place; its label costs more than it informs, and 17
of the 52 are two-member. They still *draw* — the extent stays visible — they
just do not shout their name. Measured effect: 104 labels → 70.

### Layers

`radarLayers` holds `clusters / doors / routers / endpoints`. Which layers are
**visible** is a browser view preference (persisted to `localStorage`); what each
layer **contains** is served. `own` is always drawn — hiding our own radios would
remove the reference point everything else is measured from.

The filter is applied at draw time, not to `radarNodes`, so the node table and
the plotted count keep showing the whole picture. Hiding a layer is a view
choice, not a data change.

### The load is lazy and order-independent

`initRadar()` early-returns when `homePos` is not ready on a cold URL load and
never retries, so hanging the cluster fetch off it meant the overlay silently
never appeared — verified: `clusterData` stayed null while the endpoint returned
52. The fetch now happens on first draw and redraws itself, which works whatever
order init and the WS arrive in.

Clusters change on the order of hours, so they are fetched once and redrawn from
cache rather than re-fetched per redraw.

### Verified 2026-08-05, by looking

- endpoints on: 35 blobs, **0 labels**, nodes legible
- endpoints off: 52 blobs, 70 labels; `cluster-k · 15 / solved 92.3% of 13`,
  `cluster-m · 14 / mixed 66% of 9`, `cluster-h · 5 / solved 100% of 2` all read
  cleanly
- 0 console errors

**KNOWN, NOT FIXED:** in the cluster-first reading the labels still collide in the
dense south-west and northern regions. The node labels solve this with a
collision solver (`_solveLabel`); the cluster labels do not use it yet. That is
the obvious next step and it is not done.

## Terrain relief layer (2026-08-05)

Peter: *"what I am looking at is the terrain, i.e the hills and valleys that
surround me"*, and *"I can already see by looking at the node distribution that we
have walls / dead zones, my gut feeling is these will most likely correlate with
terrain."*

The grid is **served** (`src/terrain.js`, `elev_m[bearing][ring]`). This paints it.

**Painted to a canvas, not drawn as SVG.** 180 bearings × 45 rings is 8,100 cells;
as SVG paths that is 8,100 DOM nodes rebuilt on every radar redraw. One `<image>`
costs one element, and it repaints only when the projection changes — the terrain
itself is static.

**It must use `_radarNorm`.** Painting terrain linearly while the nodes sit on the
compressive quantile scale would put a ridge in the wrong place relative to the
nodes behind it — which is exactly the comparison the layer exists to support.

Colour: low ground stays dark, height is a warm glow, alpha ramped on `t²` so flat
ground stays flat. Deliberately quiet — the radar is a dark phosphor surface and
the node marks must remain the brightest thing on it. Null elevations (sea, or
outside coverage) draw nothing rather than as land.

Sits directly above the background and below everything else, at `opacity 0.55`.
Toggled by the `terrain` layer.

### Verified 2026-08-05

Grid loaded (180 bearings, −1 to 484 m), image painted (64 KB at 2000 km range,
343 KB at 50 km). Ridge structure visible: the south-west band, higher ground
west and north-west, darker low ground east.

**KNOWN — coarse at range.** Ring radii are quadratic, so samples crowd near home
and thin out badly past ~30 km, giving visible radial streaking at the rim. That
is the right trade for RF (the near field decides whether we get out at all) but
it is not a pretty relief map. More rings, or a second linear pass at range, would
fix it.

**KNOWN — the auto range is blown out by one bad node.** `MLBR` reports 1681 km,
which drives auto-range to a 2000 km ring and crushes 60 km of terrain to a smudge.
`clusters.js` already applies a 500 km plausibility ceiling; the radar does not.
Not fixed here — it is a separate defect and belongs in its own task.
