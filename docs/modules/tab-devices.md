---
module: tab-devices
source: public/partials/tab-devices.html
source_hash: 6981bc4db400d08787dfea24c36d2066c9addd1fb5dcc45c78219bc15a3fe443
updated: 2026-08-01
---

# Module: tab-devices

## Purpose

Devices page HTML template. Renders connected radios, BLE connect flow, and
packet source selection. Presentation only — no logic lives here.

## Scope

**This spec covers the chassis/strip redesign (task `devices-accordion-layout`,
2026-07-16, mockup approved by Peter).** Supersedes the grid-panel layout: that
design showed all five config panels for every radio permanently — Peter's
verdict was "complete data overload."

Files in scope:
- `public/partials/tab-devices.html` — full rewrite (layout only)

Files explicitly NOT changed:
- `public/app-devices.js` — every handler keeps its exact signature; markup
  relocates, bindings do not change
- `public/partials/tab-cfg.html` — Radio/Channels/Owner migration is the
  follow-up task `radio-config-into-devices`
- `public/app.js` — new UI state is a scoped `x-data`, not app state

See `docs/BROWSER_CONTRACT.md` and `docs/STYLE_GUIDE.md` — both mandatory.

---

## Browser audit fixes (2026-07-23)

- Mobile header and radio strips use compact responsive spacing; node id,
  BLE percentage, and long action text progressively collapse without
  clipping. The six detail tabs become a three-column grid on phones.
- Channel success copy says “saved”, not “saved & verified”; persistence is
  verified after the gateway cache resync in the live acceptance test.
- Vitals expressions use optional access to `deviceBleStates[dev.node_id]`.
  Device disconnect/reconnect no longer emits Alpine exceptions while the
  state entry is temporarily absent.

## Structure

Page order, top to bottom:

1. Page header row: page-title "Connected radios" + `+ Connect radio` button
2. Connect card (`x-show="connectOpen"`, closed by default) — the previous
   Connect Device card content, verbatim
3. Empty state (`!availableDevices.length`)
4. THE CHASSIS: one `card` containing one strip per device (`divide-y`)
5. Packet sources — single-row card (shown when `availableDevices.length > 1`)

### Chassis / strip anatomy

```
Connected radios                              [+ Connect radio]
┌────────────────────────────────────────────────────────────────┐
│▍OMNI Peter Omni RAK !2687afb1 [PRIMARY]  1 node 100%⚡ ▂▄▆36% READY │ ← strip header
│  RAK4631 · fw … · up … · ch … · temp … · MAC · TCP · sync      │ ← vitals caption
├────────────────────────────────────────────────────────────────┤
│▍YAGI Meshtastic f7b4 … [ROTATOR] [Set active]  … stats … READY │ ← expanded strip
│  vitals caption line                                            │
│  ┌ [Settings][Firmware][Maintenance] ──────────────────────┐   │
│  │  active tab content (bg-base-200 rounded-xl p-3)        │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
PACKET SOURCES  ☑ OMNI ☑ YAGI  All radios active
```

### Alpine local state (scoped x-data on the tab root)

`x-data="{ expandedDevice: null, deviceTab: 'settings', connectOpen: false }"`

- **All strips collapsed on page load** (`expandedDevice: null`) — the page is
  a status list first.
- **Exclusive accordion**: header click sets
  `expandedDevice = expandedDevice === dev.addr ? null : dev.addr` and resets
  `deviceTab = 'settings'` — opening one strip closes any other; max one open.
- `connectOpen` toggled by the header button; auto-runs nothing.
- The Settings tab keeps the pre-existing
  `x-data="{ _labelVal…, _tcpVal… }"` input state; vitals line keeps the `_em`
  getter shorthand for `environment_metrics`.

### Strip header (one line, `flex-nowrap`)

Left: chevron (rotates when expanded) · `labelBadge(label, color)` ·
name (`font-display font-semibold truncate`) · mono `node_id` caption ·
`roleBadge('PRIMARY')` / `roleBadge('ROTATOR')`.
Right (`shrink-0`): `Set active` btn-xs (hidden when active) · node count ·
battery % · `pctBars(signal_pct)` + % · `devStateBadge(dev.node_id)`.
The active radio's strip carries a `border-l`-accent (`border-success`,
matching the previous active tint precedent); inactive strips a transparent
border of equal width so text aligns.

### Vitals caption line (always visible, wraps to 2 lines max)

Caption role, values mono: hw_model · fw version · uptime (`fmtUptime`) ·
voltage · ch util / air TX · temp/humidity + dew-point `cond.` badge and
pressure (when `environment_metrics` present) · MAC · TCP port + clients ·
sync seconds. Same `deviceBleStates`/`nodeById` bindings as the old telemetry
grid (F1 rebind preserved) — the grid's key/value cells become inline
`key value` pairs.

### Detail tabs (`x-show="expandedDevice === dev.addr"`)

`join` of three `btn-sm` tabs — Settings / Firmware / Maintenance — switching
`deviceTab`. (Radio / Channels / Owner join this row in the follow-up task.)
Content sits in one `bg-base-200 rounded-xl p-3` surface.

1. **Settings** (`deviceTab==='settings'`) — alias input + colour select +
   Save; TCP port + Save; checkboxes Primary / Rotator / Auto-connect /
   Load nodes on boot. Handlers `saveDeviceCfg`, `saveBleCfg` — verbatim.
2. **Firmware** (`deviceTab==='firmware'`) — the entire OTA block verbatim:
   header (hw_model, version, flash badges, refresh), file list
   (select/prepare/delete), upload + flash row, GitHub fetch expander
   (`otaFetchOpen[dev.node_id]`), reboot note.
3. **Maintenance** (`deviceTab==='maintenance'`) — absorbs the old Radio
   Config and Range Test panels:
   - Row 1: Backup / Restore (file input, inline JSON parse unchanged) /
     Push Position + helper caption.
   - Row 2: Range test — duration select + Start TX, or countdown + Stop TX.
   - Row 3: auto-purge checkbox + time + last-run.
   - Row 4 (actions, `border-t`): Disconnect, Retry Now (conditional) left;
     spacer; **danger cluster right**: Wipe NodeDB and Remove as
     `btn-outline btn-error` — destructive actions isolated and de-shouted
     (Remove was solid `btn-error`, Wipe was `btn-warning`).
   - Set Active leaves Maintenance — it lives in the strip header.

### Packet sources row

One card, `card-body py-3 flex-row flex-wrap`: section label, one
checkbox+`deviceLabel` badge pair per device (same `togglePacketSource`
binding), status caption ("All radios active" / "Active: …").

### Connect card (behind the header button)

Content identical to the old Connect Device card: scan button + found count,
results table (name/address/RSSI/paired/trusted/PIN/Connect/✕ remove),
manual-entry `details`, `bleError` alert. Only the wrapper changed
(`x-show="connectOpen"` + `x-transition`).

## Radio / Channels / Owner tabs (task `radio-config-into-devices`, 2026-07-16)

Config → Radio was per-radio configuration living on the wrong page behind a
duplicate radio selector. Its three sub-tabs move into each device strip as
siblings of Settings/Firmware/Maintenance; expanding a strip IS selecting the
radio, so the selector dies.

Tab row becomes: **Settings · Radio · Channels · Owner · Firmware · Maintenance.**

- **Radio** — the old Device sub-tab verbatim: Antenna card (type/beam/gain/
  cable-loss + `saveAntennaCfg`, `antennaSaved`/`antennaError`), tilt
  calibration block (`nodeSelf.tilt && cfgRadioId === activeNodeId`), the
  schema-info alert, and the `allSections` collapse list (incl. the
  fixed-position sub-panel on `position`).
- **Channels** — the old Channels sub-tab verbatim (psk warning + `channels`
  collapse list).
- **Owner** — the old Owner sub-tab verbatim (`#owner_form` + save).

**Mount-point rule:** the moved content builds forms into element IDs
(`#sec_<name>`, `#ch_<index>`, `#owner_form`), so each moved tab body is
wrapped in `<template x-if="expandedDevice === dev.addr && deviceTab === '…'">`
— with the exclusive accordion this guarantees at most one instance of each ID
in the DOM. x-show would duplicate IDs across strips and break `buildForm`.

**Load contract (each tab click, since x-if destroys the forms on leave):**

```
Radio:    @click="deviceTab='radio';    cfgRadioId=dev.node_id; radioTab='device';   resetRadioCfg()"
Channels: @click="deviceTab='channels'; cfgRadioId=dev.node_id; radioTab='channels'; resetRadioCfg()"
Owner:    @click="deviceTab='owner';    cfgRadioId=dev.node_id; radioTab='owner';    resetRadioCfg()"
```

`resetRadioCfg()` (app-config.js, unchanged) clears `allSections`/`channels`/
`ownerSchema`/`fixedPosition` and reloads for the current `radioTab` —
required because the loaders early-return on cached state and the x-if
unmount destroys the rendered forms while that cache survives.

## Channels tab: the banner told the operator the wrong thing (task `channel-config-editor-broken`, 2026-08-01)

The warning above the channel list used to read:

> "Editing **psk** on the primary channel can break mesh connectivity. Bytes
> fields are locked — unlock only if you know what you're doing."

Every clause is defensible and the conclusion it leads to is backwards. It
presents **locked** as the safe state. Locked is the state that wipes the key:
`collectForm` skips disabled inputs, so a locked PSK is never submitted, and
`channelWriteBody()` used to fill it in from mesh-gw's cache — which is stale
until the radio reconnects. On 2026-08-01 that cache held no PSK for a radio
whose PSK was `AQ==`, so any save on that form would have written an empty key.
See `docs/modules/app-config.md` → "A channel PUT never carries a PSK the
operator did not supply" for the measurement.

The banner now says what is true: the value shown is a cached read that is stale
until the radio reconnects, an empty box does **not** mean the radio has no key,
and a save must supply one.

**An inline error sits under the Save button**, alongside the existing
"Saved ✓", bound to `opErr('ch_' + ch.index + '_' + cfgRadioId)` — already
populated by `asyncOp` (`app-ui.js`) when `channelWriteBody()` throws. No new
state. A toast alone would be wrong: it vanishes, and this message is an
instruction the operator has to act on before the save can succeed.

## Invariants

- **The chassis card is `shrink-0`** (task `devices-chassis-scroll-fix`,
  Peter-reported): it carries `overflow-hidden` for corner clipping, which
  resolves the flex child's `min-height:auto` to 0 — without `shrink-0` the
  card shrinks to the viewport inside the page's `flex-col overflow-y-auto`
  and clips tall tab content (Radio: 2281px clipped to 717px) instead of
  making the page scroll.
- All strips collapsed on load; at most one expanded; expanding resets the
  tab to Settings
- The strip header and vitals line render regardless of expansion
- Every handler call, ops key, and `:disabled` expression is carried over
  verbatim — zero logic change
- All colors via DaisyUI semantic tokens; type per STYLE_GUIDE §3 roles
- Outer `x-for="dev in availableDevices" :key="dev.addr"` loop preserved

## Device-control identity — MAC-keyed (task `device-controls-mac-migration`, 2026-07-09)

All gateway device operations are keyed on the **BLE MAC = `dev.addr`** (V2),
never the removed V1 `dev.ble_address` nor `dev.node_id`:

- **Auto-connect / TCP-port** → `saveBleCfg(dev.addr, …)` → `PATCH /ble_devices/{MAC}`
- **Disconnect** → `disconnectDevice(dev.addr)` → `DELETE /devices/{MAC}`
- **Remove** → `bleRemove(dev.addr)` → `DELETE /device/{MAC}` (node-dash
  removal op since task `remove-button-repoint`); button `x-show` gates on `dev.addr`
- **Retry** → `POST /devices/{MAC}/retry`
- **OTA** → `flashOta(dev.node_id, dev.addr, …)`
- **Not changed:** `wipeNodeDb`/`backupRadioConfig` use `/{node_id}/…` routes.

`opLoading` keys may still use `dev.node_id` — local UI keys, not gateway ids.

## V2 metrics alignment (task `v2-browser-metrics`)

- BLE signal: `pctBars(signal_pct)` + `signal_pct %` (raw dBm removed in V2).
- Sync time reads `sync_duration_s`.
- Telemetry binds `deviceBleStates` pushed fields (F1 rebind), not the
  filtered `nodeById` — except environment_metrics, which has no pushed source.

## Phase C3a

Set Active passes `dev.addr` to `selectDevice`. Active compare
(`dev.node_id === activeNodeId`) still works — activeNodeId is derived.

## Decision violations in scope (display only — NOT fixed here)

- "Set active" visibility computed from `dev.node_id === activeNodeId`
- Flash disabled-state computed from `devBleState() !== 'ready'` + `ota_ready`

## Test notes

Playwright, both themes, 1440×900 (guide §8):
- Load → pure list: every strip collapsed, headers one line, vitals caption
  beneath, active radio has the accent edge
- Click strip → expands with Settings tab; click another → first closes
  (exclusive); click same → closes (all collapsed again)
- Tabs switch; Maintenance shows backup/range/purge + isolated danger cluster
- `+ Connect radio` reveals the connect card; scan/manual controls present
- Packet sources row renders with both radios
- 0 unexpected console errors in both themes
