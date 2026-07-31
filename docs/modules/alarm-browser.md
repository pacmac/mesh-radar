---
module: alarm-browser
source: src/alarm-browser.js
source_hash: 0a430d8be0a1780c56444dfe5fd9ca91702c403c64ec5fc26381118cf3a72298
updated: 2026-07-31
---

# Module: alarm-browser

## Purpose

**ALARM PLUGIN — not core.** One `registerBrowserPlugin()` call declaring that
this plugin contributes a `control` tab, a nav fragment, a header badge and one
script. Core learns nothing about what any of them contain.

Delete this file and its single import in `index.js` and the browser has no
Control page at all — no nav entry, no dead `x-if`, no console error.

## Why the whole Control page is here

All seven sub-tabs — Summary, Command, Camera, Config, Stats, Yagi Align, Chat —
are pac-host surfaces. There is no core content in that page. It lived in core
partials only because no browser hook existed until 2026-07-31, a knowing
exception Peter granted on 2026-07-29 (*"A now"*) and withdrew on 2026-07-31
(*"this must NOT live in core"*).

## Dependencies

- `browser-plugins.js` — `registerBrowserPlugin` (host service only)

## Public interface

None. Self-registers on import, exports nothing.

## Assets it declares

| field | file |
|---|---|
| `partial` | `public/plugins/alarm/tab-control.html` |
| `nav` | `public/plugins/alarm/nav.html` |
| `header` | `public/plugins/alarm/header.html` |
| `scripts` | `/plugins/alarm/plugin.js` |

`plugin.js` pushes the browser-side descriptor onto `window.__dashPlugins`:
`mixins` (controlMixin, alignMixin), `state`, `wsHandlers`, `wsObservers`,
`routes`, `subTabs`, `onTab`.

## Invariants

- Core must never import or name this module. The only permitted reference is
  the single import in `index.js`.
- **`wsObservers` read the pushed event payload, never component state.**
  Observers run before core has applied the event — the align-target default
  reads `ev.favourites`, not `this.favourites`.
- Core keeps first refusal on WS types; `wsHandlers` fire only for types core
  did not claim, so a plugin can never shadow a core message.

## Out of scope

- The alarm's server modules (`alarm-images.js`, `alarm-image-api.js`,
  `alarm-ws.js`, `alarm-sections.js`, `pac-host.js`) — each has its own spec.
