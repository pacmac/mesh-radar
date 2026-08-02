---
module: drawer-sidebar
source: public/partials/drawer-sidebar.html
source_hash: 68d000903d64073174fd881f9d90e0ea3a6147306a7d141b9dd9f5e9a8fd8145
updated: 2026-08-02
---

# Module: drawer-sidebar

## Purpose

Sidebar drawer: logo block, active-device indicator + selector, nav menu,
device status footer, toast container. Presentation only.

## Control nav item (task `pac-host-command-surface`, 2026-07-25)

New nav `<li>`, `x-show="pacHostStatus?.available"` — invisible on a stock
install with no pac-host running, matching the header badge's absence-safe
pattern. Positioned above Messages, standard nav-item markup (no unread
badge, unlike Messages/Devices — the Control page has no unread concept).

## Camera sub-tab (task `camera-page`, 2026-07-30)

One `<li>` added to the Control sub-nav between Command and Config, same markup
as its siblings: `setNav('control','camera')`.

**This is a knowing plugin-boundary exception, recorded rather than hidden.** The
Camera page is alarm-only, and this file is core — but the Control sub-nav
already hardcodes all six sub-tabs and `tab-control.html` is already 100% alarm
UI in a core file. There is no hook for a plugin-contributed browser page; the
three hooks built 2026-07-29 (`registerNodeSection`, `registerWsWiring`,
`registerConnectReplay`) are all server-side. Adding Camera here is consistent
with a pre-existing breach at full strength rather than a new one. Peter's
decision, recorded: *"A now"*. A browser plugin-descriptor mechanism is its own
task, logged in the `bugs` ledger.

## Standard-node cleanup (2026-07-23)

The removed custom Config → Radio entry no longer points at a dead sub-tab.
Standard per-radio configuration lives on Devices; Config now links Bridge,
Rotator, Modes, Radar, and Alerts.

## Scope

**STYLE_GUIDE.md compliance (task `navbar-drawer-refactor`).** Covers this
partial plus the navbar portion of `index.html` and the retirement of the
remaining LEGACY selectors in `style.css`.

Files in scope:
- `public/partials/drawer-sidebar.html`
- `public/index.html` (navbar block only)
- `public/style.css` (delete 4 LEGACY rules)
- `public/app.js`, `public/app-devices.js` (remove `info` dead state — the
  drawer firmware line was its last consumer)
- `docs/modules/style-css.md` — updated debt list + hash

## Changes

### drawer-sidebar.html
| Location | Before | After |
|---|---|---|
| Logo wordmark (l.11) | inline `font-family:'Oxanium'` | `font-display` |
| Firmware line (l.12) | `info.metadata.firmware_version` (never populated — always showed "dashboard") | `primaryDevBleState.firmware_version` (pushed, real) |
| Device selector (l.26) | `select-xs` | `select-sm` |
| Toast container (l.116) | inline `style="top:4rem"` | `top-16` class |

### index.html navbar
| Location | Before | After |
|---|---|---|
| Mobile title (l.191) | plain `text-base font-bold tracking-wide` | + `font-display uppercase` (replaces deleted `.navbar .text-lg` intent) |
| Az readout (l.197) | inline `color:rgba(80,200,255,.85)` | `text-info` |
| BLE chip label (l.210) | inline Oxanium + `font-size:0.62rem` | `font-display text-xs` |
| Not-ready tooltip (l.217) | inline `cursor:pointer` | `cursor-pointer` |

### style.css — LEGACY rules deleted (dependents verified)
- `.navbar .text-lg` — zero matches inside the navbar
- `.navbar .text-xs` — replaced by explicit `tracking-widest`/markup classes
  already present on its former dependents
- `.badge-primary.badge[x-text*="live"]` — content-attribute selector; the
  live badge keeps standard `badge-primary`
- `.overflow-x-auto.max-h-\[70vh\]` — zero matches anywhere

### app.js / app-devices.js
- `info: { my_info: {}, metadata: {} }` declaration and `_clearDeviceState`
  reset removed — no consumers remain.

## Invariants

- Nav behavior (setNav, drawer toggle, device selector) unchanged
- No inline styles or raw colors remain in the drawer or navbar
- `serverReachable` dead state left as-is (separate BROWSER_ARCH cleanup)

## Test notes

Playwright both themes (guide §8): sidebar wordmark, fw line shows real
firmware, nav works, navbar chips render, no console errors; every page
smoke-checked after the `info` removal.

## V2 metrics alignment (task `v2-browser-metrics`)

Footer per-device signal bars use `pctBars(deviceBleStates[id]?.signal_pct)`
(V2 removed raw BLE dBm). Navbar BLE chip (index.html) likewise: bars and
tooltip driven by `signal_pct` via `signalBarFill`.

## Navbar BLE chip removed (task `navbar-ble-declutter`)

The navbar BLE signal chip is removed: it displayed only the PRIMARY radio's
link while reading as overall BLE health — redundant and misleading with N
radios. BLE health surfaces: per-device bars + state in the drawer footer,
per-device amber warning badges in the navbar whenever any radio is not
ready, and per-card bars on the Devices page. `signalBarFill` deleted with
its sole consumer.

## Phase C3a

The device selector binds `x-model="activeDevice"`; options carry
`:value="d.addr"` and are keyed by `d.addr` (node_id can be null
pre-sync — keying on it produced duplicate-null Alpine keys). Labels
still render via deviceLabel until C3c bundles.

## Toast redesign — bottom-right, wrapping, structural fix (task `toast-redesign`, 2026-07-25)

Peter: *"the toast that is used everwre is awful, it is 1 line appears at the
top, overflows the viewport and is amateur. should popup bottom right and it
needs to be polished and professional... needs to wrap to multi lines while
still being a proportional size for the viewport."*

**Structural bug found and fixed, more serious than the styling complaint:**
the toast container was nested inside `.drawer-side`, sibling to `<aside>`.
DaisyUI's drawer CSS slides every child of `.drawer-side` off-screen via
`transform` whenever the mobile drawer is closed — the default state on
narrow viewports. A toast in there was **invisible on mobile** any time the
drawer wasn't open, silently, the whole time this app has had toasts. Fixed
by moving the toast container to be a sibling of `.drawer-side` instead of a
child of it — still inside the outer `.drawer` div's `x-data` scope (this
partial's entire top-level content lands there via `index.html`'s include
point), so `toasts`/`dismissToast` remain reachable, but no longer subject to
the drawer's off-canvas transform.

**Styling fixes, all in the container/item classes (no JS change — `showToast()`
in `app-ui.js` already passed `type` through untouched)**:
- Position: `toast-bottom toast-end` (was `toast-top toast-end` + inline `top-16`).
- Width: `max-w-[min(24rem,calc(100vw-2rem))]` — proportional to viewport,
  capped at 24rem on desktop. DaisyUI's base `.toast` rule sets
  `min-width:fit-content` and `white-space:nowrap`, both of which **fight**
  a `max-width` and any wrap attempt on the children — discovered by direct
  measurement (`getBoundingClientRect()`), not by eyeballing a screenshot,
  after an initial "it looks fine" read turned out to be a container
  rendering off the left edge of a 390px viewport. Fixed by explicitly
  overriding both (`min-w-0 whitespace-normal`) on the container.
- Wrap: `break-words` on the message span (was overflowing without it).
- Color map: was `t.type === 'error' ? 'alert-error' : 'alert-success'` —
  a real bug, not just cosmetic: a `warning` or `info` toast (both real,
  used in `app-ws.js`) rendered **green** (`alert-success`), violating
  STYLE_GUIDE §4's fixed status-color vocabulary. Now a full 4-way map
  (`success`/`error`/`warning`/`info` → their matching `alert-*` class).
- Icon glyph per type (✓/✕/⚠/ℹ) for quick scannability without reading color,
  matching the existing icon-per-state precedent in `op-toast.js` (a
  separate, untouched toast implementation — see Out of scope).
- Motion: slide-up + fade entrance/exit (200ms/150ms), reinforcing the new
  bottom anchor.
- Defensive `max-h-[calc(100vh-2rem)] overflow-y-auto` on the container for
  a large simultaneous burst (e.g. several persistent `duration:0` error
  toasts) — added after an initial visual read suggested overflow at 4
  stacked toasts; direct measurement then showed that read was wrong (nothing
  was actually clipped), but the bound is kept anyway as a real, if rare,
  edge case it did not previously guard against.

## Out of scope

`op-toast.js` (vanilla-DOM, used only by `op-flow.js` for device-write
operations) is a **second, separate toast implementation** — already
bottom-right, already wraps correctly. Not touched here; the app has two
parallel toast systems, which is itself a real inconsistency, filed
separately in the bugs backlog rather than merged in this task.

## Sidebar shortcut list: pac-host devices, not favourites (task `devices-shortcut-source`, 2026-07-25)

Peter spotted "B12PAC CAR" (a node someone had starred, unrelated to
pac-host) in this list and asked why — confirmed live the list was sourced
from node-dash's own favourites mechanism (`nodeinfo.favourite`), not
pac-host. His explicit decision after the tradeoff was flagged (this list
is now empty on any install without pac-host running): *"Replace the whole
list with pac-host's roster."*

`<template x-for="f in favourites">` → `<template x-for="d in
controlDevices()">` (`app-control.js`, already `GET /mesh/devices`-sourced,
already ours-only). The star icon (implied a user's deliberate choice, no
longer accurate) is replaced with a status dot reflecting `d.present` —
green when present, dim when known-but-asleep, same semantic `present`
already carries on the Control page's own unit picker.

**The favourites mechanism itself is untouched** — `nodeinfo.favourite`,
`PUT /nodes/:num/favourite`, and the Align target picker
(`app-align.js`'s `alignTargets()`, task `yagi-align-rebuild`, same
session) all still use it. Peter's correction was about this one list's
data source, not a directive to remove general favourites — Align still
needs a general node list, not a pac-host-only one.

Verified live 2026-07-25: sidebar shows exactly BNCH/GARG with green
status dots (both `present`), both themes, clicking still opens the node
focus page. Empty-when-pac-host-unavailable behavior verified by code
review of `controlDevices()`'s existing null-safety (`pacHostStatus?.units
|| []`), not by stopping the live pac-host service mid-session.
