---
module: tab-devices
source: public/partials/tab-devices.html
source_hash: 2ca4ca0eb9d34a9ffbe7bdd057e45f6dba3d5e2b9a3e7f6487036ecf8061578f
updated: 2026-07-03
---

# Module: tab-devices

## Purpose

Devices page HTML template. Renders connected radios, BLE connect flow, and
packet source selection. Presentation only — no logic lives here.

## Scope

**This spec covers the grid-panel redesign of `tab-devices.html` (task
`devices-page-refactor`, step 7).**

Files in scope:
- `public/partials/tab-devices.html` — full rewrite

Files explicitly NOT changed:
- `public/app-devices.js` — logic unchanged; violations noted in BROWSER_ARCH.md
  are deferred pending backend additions
- `public/partials/drawer-sidebar.html` — device switcher in drawer is a separate task
- All other partials and JS files

See `docs/BROWSER_CONTRACT.md` and `docs/BROWSER_ARCH.md` — mandatory for all
browser tasks.

---

## Structure

Page order, top to bottom:

1. Empty state (`!availableDevices.length`)
2. "Connected Radios" section header
3. One accordion card per device (`x-for="dev in availableDevices"`)
4. Packet Sources card (shown when `availableDevices.length > 1`)
5. Connect Device card

### Per-device accordion card

Exactly ONE expand/collapse per device. No nested section toggles.

```
┌──────────────────────────────────────────────────────────────┐
│ ▶ ALIAS  Long Name  !nodeid  [PRIMARY] [ROTATOR]   ▂▄▆ dBm   │ ← header (toggle)
│                                       [READY] [Active]       │
├──────────────────────────────────────────────────────────────┤
│  nodes · BLE addr · TCP port · sync        (stats row)       │ ← Status & Telemetry
│  Hardware  Uptime  Battery  ChUtil  ...    (telemetry grid)  │   ALWAYS VISIBLE
├──────────────────────────────────────────────────────────────┤
│  ┌────────────────────────┐  ┌────────────────────────────┐  │
│  │ DEVICE CONFIG          │  │ OTA FIRMWARE               │  │ ← panel, x-show="open"
│  └────────────────────────┘  │  (sm:row-span-3)           │  │
│  ┌────────────────────────┐  │                            │  │
│  │ RADIO CONFIG           │  │                            │  │
│  └────────────────────────┘  │                            │  │
│  ┌────────────────────────┐  │                            │  │
│  │ RANGE TEST             │  └────────────────────────────┘  │
│  └────────────────────────┘                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ MAINTENANCE (sm:col-span-2)                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Alpine local state

Per-card `x-data="{ open: true }"` — one flag, open by default. Section flags
from the previous design are removed.

The Device Config section card carries its own
`x-data="{ _labelVal: …, _tcpVal: … }"` for its two text inputs (form field
state — permitted by BROWSER_CONTRACT).

Two telemetry grid cells use a local `x-data` getter `_em` as a shorthand for
`nodeById(dev.node_id)?.environment_metrics` (pure display convenience).

### Header (always visible, `@click="open = !open"`)

- Chevron, rotates 90° when open
- Label badge via `labelBadge(label, color)` when set
- Long/short name, monospace `node_id`
- Role badges via `roleBadge('PRIMARY')` / `roleBadge('ROTATOR')`
- Right-aligned: RSSI bars + dBm (`sigBars`), state badge (`devStateBadge`),
  `Active` badge when `dev.node_id === activeNodeId`
- Card border tinted `border-success/40` when active

### Status & Telemetry (always visible — NOT inside `x-show="open"`)

- Stats row: node count, BLE address, TCP port + clients, sync seconds
- Telemetry grid (`grid-cols-2 sm:grid-cols-4`): hardware + firmware, uptime,
  battery + voltage, ch util / air TX, nodes seen (local_stats), packets RX/TX
  (local_stats), temp/humidity, pressure/dew point + condensation badge

### Panel grid (`x-show="open"`, `grid-cols-1 sm:grid-cols-2 gap-3`)

Section cards are `bg-base-200 rounded-xl p-3` with an uppercase
`text-xs font-semibold text-base-content/40 tracking-wide` label. Order:

1. **Device Config** (left, row 1) — alias input + colour select + save;
   TCP port input + save; checkboxes: Primary, Rotator, Auto-connect,
   Load nodes on boot. Handlers: `saveDeviceCfg`, `saveBleCfg` — unchanged.
2. **OTA Firmware** (right column, `sm:row-span-3`) — header with hw_model +
   running version + flash progress badges + refresh button; file list with
   select/prepare/delete; upload + flash row; GitHub fetch expander
   (`otaFetchOpen[dev.node_id]` — global map, pre-existing). Handlers:
   `loadOtaFiles`, `uploadOtaFile`, `flashOta`, `prepareOtaVersion`,
   `deleteOtaFile`, `loadOtaReleases`, `otaAssetsForDevice`,
   `downloadOtaAsset` — unchanged.
3. **Radio Config** (left, row 2) — Backup, Restore (file input), Push
   Position. Handlers: `backupRadioConfig`, radio_restore POST,
   `pushFixedPosition` — unchanged.
4. **Range Test** (left, row 3) — duration select + Start TX, or countdown +
   Stop TX when `rangeTimer.active && rangeTimer.nodeId === dev.node_id`.
5. **Maintenance** (`sm:col-span-2`) — Set Active, Wipe NodeDB, Retry Now
   (conditional), Disconnect, Remove (conditional); auto-purge checkbox +
   time + last-run.

## Consistency pass (task `devices-consistency`)

**Telemetry rebind (F1 pattern):** the four main telemetry cells (Hardware,
Uptime, Battery, Ch util/Air TX) and the OTA hw_model fallbacks previously
read `nodeById(dev.node_id)` — the *filtered* node list — so they emptied
whenever node filters excluded the radios. They now bind to
`deviceBleStates[dev.node_id]` pushed fields (`hw_model`, `uptime_s`,
`battery_level`, `voltage`, `channel_utilization`, `air_util_tx`).
Nodes-seen / packets (local_stats) and temp/pressure (environment_metrics)
cells keep `nodeById` — no per-device pushed source exists — and hide
gracefully when absent.

**Control sizes (guide §5):** section-card controls move from `-xs` to `-sm`
(Device Config inputs/select/saves/checkboxes, Radio Config buttons, Range
Test select + Start/Stop, Maintenance buttons + auto-purge controls, OTA
upload + Flash). Dense repeating contexts keep `-xs`: OTA file-list rows
(select/prepare/delete), GitHub-fetch panel internals, header refresh icon.

**Text roles:** stats row and telemetry values to `text-sm` (data role);
cell keys stay caption (`text-xs text-base-content/40`).

## Bug fix in the grid-panel revision

The step-7 draft added a "Refresh" button calling `loadDevices()` — **that
function does not exist** (device list is WS-pushed). The button is removed;
the section header keeps only the "Connected Radios" title.

## Sections that do NOT change

- **Packet Sources card** — unchanged
- **Connect Device card** — unchanged (scan, results table, manual entry,
  error alert)

## Invariants

- Exactly one toggle per device card; no nested section toggles
- Status & Telemetry renders regardless of `open`
- No state shared between card instances
- No logic moved between template and `app-devices.js`
- All colors via DaisyUI semantic tokens — no raw hex/rgba
- Outer `x-for="dev in availableDevices" :key="dev.addr"` loop preserved

## Decision violations in scope (display only — NOT fixed here)

Rendered as-is; deferred to the backend-additions task per BROWSER_ARCH.md:

- "Set Active" label/disabled computed from `dev.node_id === activeNodeId`
- `activeNodeId` currently owned by the browser
- Flash button disabled-state computed from `devBleState() !== 'ready'` and
  file `ota_ready` (pre-existing pattern, unchanged)

## Test notes

Browser task (Phase 2 scope) — no backend tests apply.

Manual/Playwright verification:
- Card renders with header, always-visible telemetry, open panel by default
- Header click collapses/expands panel only — telemetry stays
- Grid: two columns ≥sm, OTA occupies right column full height,
  Maintenance spans both columns; single column on narrow viewports
- No "Refresh" button; no `loadDevices` reference anywhere
- All handlers fire (spot-check: alias save, OTA refresh, range start disabled
  when not ready)
- Packet Sources and Connect Device cards unchanged and functional
- No Alpine console errors

## V2 metrics alignment (task `v2-browser-metrics`)

- Card-header BLE signal: `pctBars(signal_pct)` + `signal_pct %` — V2 replaced
  raw BLE dBm (`ble_rssi`, removed) with `signal_pct` 0–100.
- Stats row sync time reads `sync_duration_s` (V2 name; `ready_secs` never existed).
- "Nodes seen" / "Packets RX/TX" cells removed — `local_stats` is not in the V2
  `node_info` contract; the cells could never render.

## Phase C3a

Set Active passes `dev.addr` to selectDevice. The active-badge compare
(`dev.node_id === activeNodeId`) still works — activeNodeId is derived.
