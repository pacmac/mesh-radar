---
module: tab-overview
source: public/partials/tab-overview.html
source_hash: 59eff889e3d126e0e2af908fe3d77085dad190f99145d69970d2ff2020e72735
updated: 2026-07-02
---

# Module: tab-overview

## Purpose

Overview page HTML template: device stats bar, Mast Tilt instrument, Enclosure
Environment instrument, Live Event Feed, MQTT Proxy card. Presentation only.

## Scope

Two completed tasks govern this file:

**1. `overview-refactor`** — STYLE_GUIDE compliance (instrument components,
type roles). Presentation classes only.

**2. `overview-data-fix`** — audit findings F1+F2:
- Stats bar rebound from the dead `nodeSelf` derivation to
  `primaryDevBleState` (backend-pushed `device_list`/`device_state` fields:
  `long_name`, `hw_model`, `firmware_version`, `battery_level`, `voltage`,
  `uptime_s`, `channel_utilization`, `air_util_tx`, `node_count`) and to
  `nodeCount`/`nodeTotal` (backend-pushed `node_list`)
- MQTT Proxy card removed entirely (Peter's decision, 2026-07-02); the Live
  Event Feed row becomes single full-width column
- `mqttProxy`/`mqttCfg` state removed (`app.js` declarations,
  `app-devices.js` `_clearDeviceState` resets) — the card was the only reader
- `app-ws.js` node_list handler: when `my_node_num` is known but the self
  node is absent from the (filtered) lists, still seed `nodeSelf.num` so
  `tilt_update`/`telemetry_update` matching works regardless of node filters

Files in scope (data-fix): `public/partials/tab-overview.html`,
`public/app.js`, `public/app-devices.js`, `public/app-ws.js`,
`public/index.html` (navbar MQTT chip removed — fed by the same dead
`mqttProxy` state; discovered in Phase 4 when its binding threw after the
state removal).

Files explicitly NOT changed:
- `public/app-telemetry.js` — chart/tilt math untouched
- `public/partials/drawer-sidebar.html` — its `info.metadata.firmware_version`
  read stays; `info` remains declared until the navbar/drawer task
- `public/style.css` (this task)
- All other partials

### Stats bar bindings (after data-fix)

| Stat | Value | Desc |
|---|---|---|
| Device | `primaryDevBleState.long_name \|\| '–'` | `hw_model` + `firmware_version` |
| Battery | `battery_level` % | `voltage` V |
| Uptime | `fmtUptime(uptime_s)` | since last boot |
| Channel Util | `channel_utilization` % | air tx `air_util_tx` % |
| Mesh Nodes | `nodeCount + ' shown'` | `nodeTotal + ' total'` |
| Config | `ble_state === 'ready' ? 'complete' : 'syncing…'` (unchanged) | `node_count + ' in radio nodedb'` (label clarified) |

## Changes by section

### Stats bar
- Remove dead `text-lg` from each `stat-value` (style.css `1.4rem !important`
  wins anyway). No other change. The `–` placeholders are a data issue owned by
  `browser-criticals`, not this task.

### Mast Tilt panel → `.instrument`
- Container: inline box-shadow → `class="instrument flex flex-col h-full"`
- Header: inline bg/border → `.instrument-header` (flex row, px-3 py-2)
- "MAST TILT" label → `.instrument-label`
- Cal indicators (● N CAL / ● ZEROED) → `.instrument-faint font-mono text-xs`
  (amber one uses `.instrument-value--amber` tint)
- pts counter → `.instrument-faint font-mono text-xs`
- 1H/4H/24H buttons → `.instrument-btn` with `:class="tiltWindow===w &&
  'instrument-btn--active'"` (replaces the `:style` ternary)
- SET ZERO / CLR CAL → `.instrument-btn` + `:class` swap to
  `instrument-btn--red` when armed; SET NORTH → `.instrument-btn
  instrument-btn--amber`
- Body: inline radial gradient → `.instrument-screen`
- SVG: fixed `rgba(0,255,80,…)` strokes/fills → `var(--phos)` +
  `stroke-opacity`/`fill-opacity` attributes; ring-label `font-size="9"` →
  `"10"` (guide §2 SVG floor); amber peak ring → `var(--trace-amber)`;
  JS-generated fragments (`tiltDotsSvg`, tick paths) unchanged
- Readout column: all inline grid/color/size styles → Tailwind
  (`grid grid-cols-[auto_auto]`, `gap-x-3 gap-y-0.5`) with
  `.instrument-label`-tier keys (text-xs) and `.instrument-value text-sm`
  values; PEAK row amber; x/y/z grid `.instrument-faint font-mono text-xs`;
  "rings:" footer `.instrument-faint font-mono text-xs`

### Enclosure Environment panel → `.instrument`
- Container/header/buttons/screen: identical treatment to Mast Tilt
- Live readings: labels `.instrument-label` with trace tint; values
  display-value role (`text-2xl font-mono font-bold tabular-nums`) colored
  `var(--trace-red)` (temp), `var(--trace-amber)` (humidity), `var(--phos)`
  (dew pt, condensation flips to trace-red), `.instrument-faint` (pressure)
- Condensation warning → `text-sm font-mono` in trace-red
- Chart SVG: fixed strokes → `var(--phos)` / `var(--trace-*)` + opacity
  attributes; polyline colors keep exact current hues via the tokens;
  JS-generated label fragments unchanged
- "waiting for history…" → `.instrument-faint font-mono text-xs`

### Live Event Feed
- Feed rows: `text-xs` → `text-sm` (data role — primary content, not caption)
- Timestamp: explicit `font-mono text-xs text-base-content/40` (no longer
  relies on the deleted LEGACY hijack)
- Filter button: `btn-xs` → `btn-sm` (card-header action, not a dense row)
- Dropdown option labels stay `text-xs` → change to `text-sm` (body role)

### MQTT Proxy card
- "Node identity" h3 → section-label recipe
  (`text-xs font-display font-semibold uppercase tracking-wider
  text-base-content/50`)
- Broker value → `font-mono`
- No other changes — key-value rows already comply

### Page container
- Outer stack `gap-3` → `gap-4` (guide §5 page-level spacing); row grids stay
  internal and become `gap-4` for consistency

## style.css deletions (cross-page effect — disclosed)

1. `.text-base-content\/40 { mono 0.68rem }` — LEGACY hijack with 29 accidental
   dependents in 6 partials. After deletion those elements render at their
   declared Tailwind size/font, which is the guide-correct behavior (fixes the
   Devices telemetry keys silently forced into 10px mono). Phase 4 spot-checks
   devices + messages.
2. `.overflow-y-auto.max-h-\[480px\]` rules (×3) — zero matches in any partial;
   dead code.

## Invariants

- Zero changes to any `x-text`, `x-show`, `x-model`, `@click`, `:class` data
  logic — only presentation classes and the `:style`→`:class` button-state
  mechanism (same boolean, same visual states)
- Phosphor/trace colors appear only inside `.instrument` (guide §6)
- No inline `style=` remains except: SVG geometry attributes bound to data
  (`:cx`, `:points`, `:r`, aspect-ratio sizing) and the live-dot transition —
  sanctioned as runtime-computed values (guide §7)
- Both instrument screens stay dark in both themes (guide §6)

## Test notes

Playwright, both themes, 1440×900 (guide §8):
- Overview: tilt panel + env panel render with identical character (dark
  screen, phosphor), all controls at legible sizes; window buttons toggle
  active state; feed rows text-sm; MQTT card unchanged
- Cross-page: devices + messages spot-check after LEGACY deletion — telemetry
  keys/timestamps render at declared sizes, no 10px mono hijack
- 0 console errors on all checked pages
