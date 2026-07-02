---
module: drawer-sidebar
source: public/partials/drawer-sidebar.html
source_hash: a0e35eaf773963c2e3d570e9fe0d74b0560a0dd94b62737741010d95e4a42509
updated: 2026-07-02
---

# Module: drawer-sidebar

## Purpose

Sidebar drawer: logo block, active-device indicator + selector, nav menu,
device status footer, toast container. Presentation only.

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
