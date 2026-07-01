---
module: tab-devices
source: public/partials/tab-devices.html
source_hash: 05dadd6c3fc992f144da03da9f3891a8baf4feebf61a502e897bac6a30080ac6
updated: 2026-07-01
---

# Module: tab-devices

## Purpose

Devices page HTML template. Renders connected radios, BLE connect flow, and
packet source selection. Presentation only — no logic lives here.

## Scope

**This spec covers a full structural refactor of `tab-devices.html`.**

Files in scope:
- `public/partials/tab-devices.html` — full rewrite

Files explicitly NOT changed:
- `public/app-devices.js` — logic unchanged; violations noted in BROWSER_ARCH.md are deferred pending backend additions
- `public/partials/drawer-sidebar.html` — device switcher in drawer is a separate task
- All other partials and JS files

See `docs/BROWSER_CONTRACT.md` and `docs/BROWSER_ARCH.md` — mandatory for all browser tasks.

---

## New structure

Each connected radio becomes a self-contained accordion card:

```
┌─────────────────────────────────────────────────────────┐
│ ▶  ALIAS  Long Name          [PRIMARY]  [READY]  ▼ dBm  │  ← header, always visible
├─────────────────────────────────────────────────────────┤
│  ▸ Status & Telemetry       (collapsed by default)      │
│  ▸ Device Config            (collapsed by default)      │
│  ▸ Firmware OTA             (collapsed by default)      │
│  ▸ Radio Config             (collapsed by default)      │
│  ▸ Range Test               (collapsed by default)      │
│  ▸ Maintenance              (collapsed by default)      │
└─────────────────────────────────────────────────────────┘
```

All sections are collapsed by default. Alpine local state (`x-data`) on each
card manages which sections are open — pure display preference, no shared state.

### Card header

Always visible. Contains:
- Chevron (rotates when card body is open)
- Alias badge (from `deviceConfigs[dev.node_id]?.label`) or node_id fallback
- Long name / short name
- Role badges: PRIMARY, ROTATOR (when set in deviceConfigs)
- BLE state badge (via existing `devStateBadge(dev.node_id)`)
- RSSI signal bars + dBm value (when `deviceBleStates[dev.node_id]?.ble_rssi` present)
- Active indicator: `border-success` ring or `[ACTIVE]` chip when `dev.node_id === activeNodeId`

Clicking anywhere on the header toggles the card body open/closed.

### Section: Status & Telemetry

Contents unchanged from current — the telemetry grid and BLE/network stats row:
- Hardware model, firmware version, uptime, battery, ch util / air TX
- Nodes seen / packets RX+TX (local_stats)
- Temperature, humidity, dew point, pressure (environment_metrics)
- BLE RSSI, node count, sync time, BLE address, TCP port/clients

### Section: Device Config

A structured form replacing the current inline cramming:

```
Alias     [________]   Colour  [▼ Colour…]  [Save]

TCP port  [_____]  [Save]

☐ Primary    ☐ Rotator    ☐ Auto-connect    ☐ Load nodes on boot
```

Fields and handlers unchanged — same `saveDeviceCfg` / `saveBleCfg` calls.

### Section: Firmware OTA

Contents unchanged — file list, upload button, flash button, GitHub fetch
expander. No logic changes.

### Section: Radio Config

Contents unchanged — Backup, Restore, Push Position buttons. No logic changes.

### Section: Range Test

Contents unchanged — duration selector + Start TX / Stop TX. No logic changes.

### Section: Maintenance

Groups the remaining actions that were previously scattered at the bottom:

```
[Set Active]  [Wipe NodeDB]  [Retry Now]  [Disconnect]  [Remove]

☐ Auto-purge daily at [02:00]   · Last: never
```

"Retry Now" and "Disconnect" and "Remove" are conditionally visible as now.
"Set Active" button wording and disabled state unchanged — violation noted in
BROWSER_ARCH.md but deferred.

---

## Sections that do NOT change

- **Packet Sources card** — unchanged, stays below the radio accordion list
- **Connect Device card** — unchanged, stays at the bottom

---

## Alpine local state shape (per-card x-data)

Each device card gets its own `x-data` with:

```js
{
  open: false,           // card body visible
  sections: {
    status: false,       // Status & Telemetry
    config: false,       // Device Config
    ota: false,          // Firmware OTA
    radio: false,        // Radio Config
    range: false,        // Range Test
    maintenance: false,  // Maintenance
  },
  _labelVal: '',         // bound to alias input (init from deviceConfigs)
  _tcpVal: '',           // bound to TCP port input (init from dev.tcp_port)
}
```

Initialization happens via `x-init` — reads current values from parent scope
(`deviceConfigs[dev.node_id]?.label`, `dev.tcp_port`). No shared state mutations.

---

## Invariants

- The card header is the only expand/collapse toggle for the card body
- Section toggles are independent of each other — any combination can be open
- No state is shared between card instances — each card is fully self-contained
- No logic moved from `app-devices.js` to the template or vice versa
- `devStateBadge()`, `sigBars()`, `nodeById()`, `labelBadge()`, `roleBadge()` etc.
  are called identically to the current implementation
- The outer `x-for="dev in availableDevices"` loop is preserved unchanged

---

## Decision violations in scope (display only — NOT fixed here)

The following violations are rendered as-is; they are deferred to the backend
additions task (`browser-ui-issues` / `BROWSER_ARCH.md` step 1):

- "Set Active" button computes label and disabled state from `dev.node_id === activeNodeId`
- `activeNodeId` is currently owned by the browser

---

## Test notes

Phase 1 is complete; this is a browser task (Phase 2 scope). No backend tests apply.

Manual verification:
- Each device card renders with correct name/badges/state
- Card body toggles on header click
- All 6 sections toggle independently
- Device Config: alias save, colour save, TCP save, all 4 checkbox flags save correctly
- OTA: file list, upload, flash, GitHub fetch all work identically to before
- Radio Config: backup downloads, restore reads JSON and posts, push position works
- Range Test: start/stop work as before
- Maintenance: all buttons trigger correct operations; Retry Now only visible in reconnecting/failed state
- Auto-purge checkbox and time input save correctly
- Packet Sources card still appears with >1 radio
- Connect Device card still works: scan, table, connect, remove, manual entry
- No regressions in other tabs (nodes, messages, radar, cfg)
