# radar-scope — founding specification

**Status:** handoff document. Written inside node-dash (task
`radar-scope-founding-spec`, 2026-07-03) to seed the new `radar-scope`
repository. A fresh session working inside that repo builds from this spec;
this file is copied there as `SPEC.md` and becomes the repo's root contract.

**One sentence:** a zero-dependency, single-file, framework-agnostic polar
plotting instrument — uPlot's discipline applied to a radar scope.

---

## 1. Positioning and non-goals

radar-scope renders a polar instrument surface: range rings, radial distance
scale, sweep, target blips, collision-free labels, and optional overlay
layers. It is presentation only.

**Non-goals — rejected permanently unless this spec is revised:**

- No data acquisition, filtering, or business logic. The host decides *which*
  targets exist; the scope decides only *how to draw them*. (This is the
  library equivalent of node-dash's BROWSER_CONTRACT.)
- No framework dependency or wrapper (no Alpine/React/Vue adapters in core).
- No canvas. SVG substrate — see §3.
- No npm publish, no public repo initially. Local repo first; publishing is
  packaging, deferred until the API survives its second consumer.
- No feature lands in core that node-dash does not need today. Only the
  *seams* (layer hooks) are built ahead of need.

## 2. Repository

- **Name:** `radar-scope`. Local-first (private), public later.
- Suggested location: sibling of other projects (owner creates; the build
  session works only inside it, mirroring node-dash's own scope rule).
- Layout:

```
radar-scope/
  SPEC.md              ← this document
  CLAUDE.md            ← scope rule (this repo only), /idiot config, spec infra
  src/                 ← library source (may be split into modules)
  dist/radar-scope.js  ← single-file ESM build artifact, the ONLY thing consumers take
  demo/                ← static demo page, synthetic data; doubles as dev harness
  test/                ← unit tests for the pure math (scale, label placement)
  README.md, CHANGELOG.md, LICENSE (MIT suggested — owner decides)
```

- Semver from the first tag. Breaking the constructor/options contract is a
  major.
- The demo page is the development harness: library work must never require
  node-dash or a live mesh. Demo scenarios double as acceptance fixtures
  (§7).

## 3. Substrate decision: SVG

Deliberate divergence from uPlot (canvas). Rationale: target counts are tens,
not hundreds of thousands; SVG gives free per-element hit-testing (node
click/hover), crisp text at any DPI, and CSS filters for phosphor glow.
Canvas would force manual hit-testing and shader-style glow for zero benefit
at this scale. The scope **owns** its SVG entirely: it creates it inside the
host element and no outside code touches its internals.

The proven layer structure (from node-dash `tab-radar.html`):

```
svg (viewBox 0 0 600 600, overflow visible)
  defs: radial background gradient, rimGlow / blipGlow filters, circular clipPath
  g.bg          — gradient disc, range rings, ring labels, bearing ticks
  g.layers…     — one <g> per registered layer plugin (beam, scan arm, …), clip as requested
  g.targets     — blips, label arms, label text (always topmost)
```

## 4. Public API

```js
import RadarScope from './radar-scope.js';

const scope = new RadarScope(hostEl, {
  size:   600,                      // px; or omit and call setSize()/use ResizeObserver
  maxRange: 100,                    // outer ring value (km or any unit — unit-agnostic)
  scale:  { type: 'adaptive-quantile' } // | 'linear' | { fn: (r, maxRange) => 0..1 }
  labels: { placement: 'rotating-arm' } // | 'none'
  theme:  { /* §6 — every default matches node-dash's phosphor idiom */ },
  layers: [beamLayer(), scanArmLayer()],   // §5
  on:     { targetclick(t, evt){}, targethover(t, evt){} },
});

scope.setTargets([{ id, az, range, label, kind, color, ringColor, stale }]);
scope.setMaxRange(km);
scope.setSize(px);
scope.setTheme(partialTheme);       // merge-patch
scope.getLayer(name);               // handle for layer-specific calls (e.g. beam.setAz)
scope.destroy();                    // removes DOM, observers, timers — leak-free
```

Target fields: `id` (stable key — angle memory hangs off it), `az` degrees
clockwise from north, `range` in the same unit as `maxRange`, `label` text,
`kind`/`color`/`ringColor` presentation hints, `stale` dims the blip.
Anything the host wants back on events rides along untouched (targets are
not cloned).

**Instance purity:** no module-level state. All memory (`_scalePts`,
`_labelAngles`) lives on the instance. Multiple scopes per page must work —
this is a hard requirement, not a nicety. (In node-dash today this state
hangs off the Alpine app object; it moves into the class.)

## 5. Layer plugin contract

Core = surface + targets + labels. Everything else is a layer:

```js
const layer = {
  name: 'beam',
  clip: true,                       // wrap in the circular clipPath?
  init(ctx)    {},                  // once; ctx below
  draw(ctx)    {},                  // on every scope render pass
  destroy(ctx) {},
  // layers may expose their own methods; host reaches them via scope.getLayer(name)
};
// ctx: { g,            — the layer's own <g>
//        norm(range),  — current range → 0..1 radius fraction (the live scale)
//        polar(az, range) → {x, y},
//        C, R,         — center px, usable radius px
//        theme, maxRange, targets }
```

First-party layers shipped **with node-dash, not in the lib**: YAGI beam
wedge (az + beamwidth, 1.2 s eased rotation), scan arm, traceroute path
overlay, active-target highlight. They are the reference implementations of
the contract; a future dashboard writes its own. If a second consumer later
wants one of them, it graduates into the repo under `layers/` as a separate
file — never into core.

## 6. Theme

All visual constants arrive through one options object, defaulting to the
node-dash phosphor idiom so the migration render-matches:

```js
theme: {
  phosphor:   'rgb(0,255,80)',   // single hue; alphas derived below
  bgStops:    ['rgba(0,30,8,1)', 'rgba(0,15,4,1)', 'rgba(0,5,2,1)'],
  gridAlpha:  0.06 – 0.22,       // ring/tick alphas (exact table from tab-radar/app-radar)
  labelFont:  "'Oxanium', monospace",
  dataFont:   "'JetBrains Mono', monospace",
  accent:     'rgba(255,160,0,…)', // amber — attention only
}
```

SVG text inside the instrument uses viewBox units — this is exempt from any
host CSS rem/em regime *by construction* (it scales with the viewBox). That
is the physical resolution of node-dash's style-guide exemption debate: the
instrument is exempt because it's a component that owns its rendering; the
host page obeys its own rules.

## 7. The two core algorithms (port faithfully — these are proven in production)

### 7.1 Adaptive quantile radial scale (`app-radar.js:222-262`)

Screen radius follows the *actual distance distribution* so the dominant
cluster band gets ~half the radius wherever it sits:

1. Collect target ranges `0 < r ≤ maxRange`, sorted.
2. Fewer than 4 distinct values (0.1 precision) → **fallback**: `min((r/maxRange)^0.4, 1)`.
3. Control points at the 25/50/75 quantiles; snap each: `r ≥ 10 → round(r)`,
   else `round(r*2)/2`. **Never snap harder** — coarse "nice numbers"
   collapse quartiles inside the cluster band and destroy adaptivity
   (learned the hard way; regression test this).
4. De-duplicate; drop points ≥ maxRange.
5. **Hysteresis:** keep previous control points unless count/maxRange changed
   or any point drifted >15% — kills ring jitter as targets come and go.
6. Radius fractions spread evenly 0.28 → 0.76 (single point → 0.52); outer
   edge pins at 0.95 for maxRange.
7. `norm(r)` = piecewise-linear through `(0,0), (kms[i], fracs[i]), (maxRange, 0.95)`.
8. Rings are drawn **at the control-point ranges** (plus outer), so ring
   labels are round numbers by construction.

Linear mode (`scale: 'linear'`): `min(r/maxRange, 1)` — kept as an option
(node-dash exposes it as a toggle).

### 7.2 Rotating-arm label placement (`app-radar.js:357-412`)

Constant arm length, rotating angle — length extension is last resort:

1. Project all targets to px. Each label = diagonal arm at `armAngle`
   (0°=up, clockwise) of length `BASE_DIAG`, then a horizontal cap away from
   the plot; text hangs off the cap. Text box ≈ `len(text) × 6.5px × 12px`
   (monospace estimate).
2. Deterministic order: by range ascending, then id — placement must be
   reproducible frame to frame.
3. Per-target **angle memory** keyed by id (default 45°): a settled label
   re-solves only when a new plot collides with it. Memory is dropped when
   the target leaves the plot.
4. Candidate sweep: preferred angle, then ±30°, ±60°, … ±150°, 180°.
5. Collision = AABB overlap with any placed label box, or box within 4px of
   any target blip.
6. Only if the full sweep fails at `BASE_DIAG`, retry the sweep at
   `BASE_DIAG + STEP_DIAG`. If that fails too, accept the preferred angle
   (overlap tolerated rather than exploding arm length).

Both algorithms are pure functions of (targets, previous instance state) —
they are the primary unit-test surface. Fixtures to port: dense cluster at
8–12 km among 0.5–100 km spread → cluster occupies ≥40% of radius, zero
label overlaps; scale stability under ±10% range jitter (hysteresis holds);
<4 distinct ranges → fallback curve.

## 8. Demo harness scenarios (acceptance fixtures)

Empty scope · 1 target · 2 colinear targets · 40-target cluster (the
node-dash reality: ~80% of targets in one narrow band) · 100 spread targets ·
targets entering/leaving every 2 s (jitter/hysteresis check) · beam layer
sweeping · theme override (non-phosphor skin proves nothing is hardcoded).

## 9. node-dash integration & migration (strangler-fig — executed in node-dash, later)

1. Lib repo reaches: demo scenarios pass, unit tests green, `dist/radar-scope.js` builds.
2. node-dash **vendors** the dist file at `public/lib/radar-scope.js`
   (version header, committed; upgrade = copy + commit). No build step, no npm.
3. New flag-gated page (`/radar2` or feature flag) renders the same mixin
   data through the lib. The existing radar page stays untouched as the
   oracle.
4. Parity criteria (all must pass before cutover): same target set plotted;
   ring placement within tolerance; zero label overlaps; beam/scan-arm/
   traceroute behavior; click/hover parity; both themes; zero console
   errors; Playwright screenshot comparison.
   Divergences are classified *intent* (lib spec wins, note it) vs
   *regression* (fix the lib) — no bug-for-bug parity chasing.
5. Cutover: flip flag, delete old render code from `app-radar.js` (mixin
   shrinks to a data adapter), delete the old SVG shell.
6. Only then: `radar-typography-compliance` — the surviving page chrome
   (node list card, control bar, sidebar) converts its 16 hardcoded px font
   sizes to rem per STYLE_GUIDE, and the guide's radar exemption is reworded
   to name the *component*, not the page.

## 10. Handoff notes for the build session

- Reference implementation: node-dash `public/app-radar.js` (render +
  algorithms; lines cited above) and `public/partials/tab-radar.html`
  204-226 (SVG shell, defs, layer groups). Read-only reference — the lib is
  a fresh implementation against this spec, not a file copy; the mixin's
  Alpine couplings (`this.radarNodes`, `this.deviceConfigs`,
  `yagiPointTarget`, theme reads) must dissolve into targets/options/layers.
- Known intent-vs-accident: the quantile snap rule and hysteresis threshold
  are intent (tested behavior); exact alpha values are idiom (theme
  defaults); `normKm = 0.92` for range-unknown targets is a pragmatic perch,
  keep it; per-device dot/ring colors (`app-radar.js:418-424`) are host
  presentation hints — model as `color`/`ringColor` on the target, not
  device logic in the lib.
- The build session should start by writing the repo's CLAUDE.md and spec
  infra (mirroring node-dash's /idiot config), then implement §7 with tests
  before any DOM code.
