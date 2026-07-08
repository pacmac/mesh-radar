---
module: tab-radar
source: public/partials/tab-radar.html
source_hash: 923de1d807554b54a80a260789a0cf234774673b068bbee1eeae99fb74dc47b5
updated: 2026-07-08
---

# Module: tab-radar

## Purpose

Radar page partial: radar scope canvas, RADAR NODES / SCAN CONTACTS list card
(top-left), rotator sidebar, active-node card. Presentation only — all data
comes from mixins (app-radar.js, app-nodes.js, app-ws.js); the partial makes
zero filtering or business decisions.

## Responsibilities

- Render the radar canvas container and its overlays.
- Render the RADAR NODES list: short name, (scan az), az, km, hops badge,
  last-heard time / live yagi signal, signal bars.
- Highlight rows for `yagiPointTarget` (amber) and `passiveTraceNum` (green).

## Dependencies

- `nodesMixin` — `nodeShortName`, `nodeHops`, `sigBars`.
- `radarMixin` — `radarNodeList()`, `_az`/`_km` annotations, `signalAge()`.

## Invariants

- **Legibility floor (task radar-list-legibility, 2026-07-03).** Peter: "stop
  dimming the fonts, they are barely visible." List text uses the phosphor
  green `rgba(0,255,80,α)`; α values must not fall below:
  - node short name: **0.95**
  - az / km / scan-az data columns: **0.80**
  - hops badge (non-direct): **0.70** (direct stays amber `rgba(255,160,0,0.85)`)
  - last-heard time: **0.65**
  - header node count: **0.55**
  Amber yagi-target highlight values are unchanged.
- The radar page is STYLE_GUIDE-exempt visually (phosphor instrument idiom),
  but legibility is non-negotiable.
- Hops badge value comes from `nodeHops(n)` = `n.hops_display`, the
  backend-decided distance (traceroute-verified relay count preferred over
  reported live hops; `ws-relay.enrichEvent`). The badge is styled as
  **verified** (green border) when `nodeHopsIsVerified(n)` is true
  (`n.hops_verified != null`), else plain (reported). The UI picks neither the
  value nor the provenance — it only renders them. This reverses the earlier
  "never from traceroute route length" rule (task
  `radar-hops-verified-vs-reported`): with reliable traceroute data we prefer
  it. The verified border uses `1px solid rgba(0,255,80,0.55)`; the reported
  state uses a transparent border of equal width so the row does not shift.

## Test notes

- Static: grep the RADAR NODES block for the α values above.
- Visual: Playwright screenshot both themes — DEFERRED while Playwright MCP
  is disconnected.

## Radar SVG groups are `x-ignore` (task radar-arm-xeffects-fix, 2026-07-07)

The five `<g>` groups inside `#radar-svg` — `radar-bg-g`, `radar-beam-g`,
`radar-scan-arm-g`, `radar-traceroute-g`, `radar-nodes-g` — are drawn purely
imperatively (`svgElem`/`appendChild`/`innerHTML`) and carry no Alpine
directives, so each is marked `x-ignore`. Alpine must not walk or tear down
these subtrees: the draw functions clear and rebuild them many times per
second, and letting Alpine's mutation observer process that churn throws
continuous `Cannot read properties of undefined (reading '_x_effects')`
errors (~22/s while viewing the radar). `x-show="homePos"` stays on the outer
`#radar-svg` (Alpine-managed); only the inner groups are ignored. Same root
fix as `#rotator_cfg_form`.

## Out of scope

- Radar canvas drawing logic (app-radar.js, spec: app-radar.md).
- Node list membership/filtering (backend node-filter.js).

## Via column (task radar-list-via)

Between km and hops: direct (live hops 0) renders an em-dash; relayed
nodes render `via.short_name` (fallback: last 4 of `via.node_id`, or an
honest `?` when no traceroute exists yet). Tooltip carries the source
("first hop from last traceroute"). Data comes bundled on the node_list —
the partial resolves nothing. Legibility floor applies (0.80 phosphor).
Card width 16–24 rem.
