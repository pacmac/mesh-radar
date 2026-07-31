# Browser plugin boundary — the alarm UI leaves core

Peter, 2026-07-31: *"this must NOT live in core"*. Withdrawing the exception he
granted on 2026-07-29 (*"A now"*), which was granted only because no browser
plugin hook existed.

mcpp task `browser-plugin-boundary`. Companion to `docs/PLUGIN_BOUNDARY_SPEC.md`
(server side, already satisfied) and `docs/BROWSER_CONTRACT.md`.

---

## 1. What is wrong today

The server side is clean — measured 2026-07-31 by commenting out all 9 alarm
wiring lines in `index.js`: node-dash booted, WS carried **zero** `alarm_*` /
`pac_host_*` messages, all 12 core message types intact, alarm routes fell
through to the SPA catch-all as `text/html`.

The browser side is not:

| core file | lines | alarm-bearing |
|---|---|---|
| `public/partials/tab-control.html` | 519 | 94 |
| `public/app-control.js` | 220 | 37 |
| `public/app-align.js` | 63 | 26 |
| `public/app.js` | 432 | 18 |
| `public/app-ws.js` | 711 | 12 |
| `public/partials/drawer-sidebar.html` | 177 | 5 |
| `public/index.html` | 285 | 3 |

**The entire Control page is alarm.** All seven sub-tabs — Summary, Command,
Camera, Config, Stats, Yagi Align, Chat — are pac-host surfaces. There is no
core content in it to keep.

Four couplings, each needing its own hook:

1. `index.html:262` — core names the plugin's partial in an `x-if`
2. `app.js:18,426` — core imports `alignMixin` and lists `controlMixin, alignMixin`
3. `app.js:83-108` — 12 alarm state fields in the core root component
4. `app-ws.js:66-79` — core dispatches 4 plugin message types by name

## 2. The mechanism

`assembleIndex()` (`src/index.js:123-129`) already substitutes
`<!-- include: X -->` at request time and **already degrades gracefully**:

```js
return existsSync(p) ? readFileSync(p, 'utf8') : `<!-- missing partial: ${filename} -->`;
```

So the extension point exists; the defect is only that **core names the file**.
Core will instead emit generic markers filled from a registry, mirroring the
three server hooks that already work (`registerNodeSection`, `registerWsWiring`,
`registerConnectReplay`).

### Server: `registerBrowserPlugin(descriptor)`

New core module `src/browser-plugins.js` — generic, names no plugin:

```js
registerBrowserPlugin({
  tab:     'control',                       // x-if value
  partial: 'plugins/alarm/tab-control.html',
  nav:     'plugins/alarm/nav.html',
  scripts: ['/plugins/alarm/plugin.js'],
})
```

`assembleIndex()` replaces three generic markers in `index.html`:

| marker | filled with |
|---|---|
| `<!-- plugin: tabs -->` | one `<template x-if="tab==='<tab>'">…partial…</template>` per plugin |
| `<!-- plugin: nav -->` | each plugin's nav partial |
| `<!-- plugin: scripts -->` | one `<script type="module" src=…>` per script |

**No registrations → all three markers render empty.** That is the plugin-absent
case and it must stay a no-op.

### Browser: `window.__dashPlugins`

The plugin script pushes a descriptor onto a generic array before Alpine boots:

```js
(window.__dashPlugins ||= []).push({
  mixin:      alarmMixin,        // merged into the Alpine component
  state:      { … },             // merged into the root data object
  wsHandlers: { pac_host_status: fn, alarm_images: fn, … },
})
```

Core consumes it blindly:

- `app.js` — `...(window.__dashPlugins||[]).map(p=>p.mixin)` in the mixin list,
  and `Object.assign(data, ...plugins.map(p=>p.state))` for state
- `app-ws.js` — after every core handler has had its chance, look the event type
  up in each plugin's `wsHandlers` and call it bound to the component

**Load order is load-bearing.** Plugin scripts are emitted BEFORE `/app.js` so
their modules execute first and the array is populated by the time Alpine
evaluates `x-data`. This is the same class of failure as `alarm-ws.js`'s dynamic
import (0 live broadcasts in 110 s, invisible from the UI) and must be tested,
not assumed.

## 3. Files

| file | change |
|---|---|
| **NEW** `src/browser-plugins.js` | the registry + marker rendering. Core, generic. |
| **NEW** `src/alarm-browser.js` | ALARM PLUGIN — one `registerBrowserPlugin` call |
| **NEW** `public/plugins/alarm/plugin.js` | pushes mixin + state + wsHandlers |
| **NEW** `public/plugins/alarm/nav.html` | the Control nav entry |
| **MOVE** `public/partials/tab-control.html` → `public/plugins/alarm/tab-control.html` | |
| **MOVE** `public/app-control.js` → `public/plugins/alarm/app-control.js` | |
| **MOVE** `public/app-align.js` → `public/plugins/alarm/app-align.js` | |
| `src/index.js` | use the registry in `assembleIndex()`; one import of `alarm-browser.js` |
| `public/index.html` | `x-if tab==='control'` line → `<!-- plugin: tabs -->`, plus 2 markers |
| `public/app.js` | remove alarm imports, alarm state, alarm mixins; add generic merge |
| `public/app-ws.js` | remove 4 alarm handlers; add generic plugin dispatch |
| `public/partials/drawer-sidebar.html` | Control block → `<!-- plugin: nav -->` |

## 4. Not changing, and why

- **`src/pac-host.js`, `src/alarm-*.js`** — already plugin-side.
- **`src/ws-relay.js`, `src/node-status.js`** — verified clean; comments only.
- **`public/app-nav.js`** — measured 0 alarm references. The `control` path entry
  is a generic route-name map, not alarm knowledge.
- **`sw.js`** — cache list. Out of scope; logged if it needs the moved paths.

## 5. Invariants

- **Core must not name the alarm in any `public/` file.** The check is a grep,
  and it goes in the test suite.
- **Plugin scripts load before `/app.js`.** A late registration silently never
  merges — the exact failure mode that bit `alarm-ws.js`.
- **Core WS keeps first refusal.** Plugin handlers run only for types core did
  not claim, so a plugin can never shadow a core message.
- **No registrations must be a clean no-op** — no empty nav, no dead `x-if`, no
  console error.
- The Control page's own behaviour is UNCHANGED. This is a move, not a rewrite;
  any behavioural difference is a bug in this task.

## 6. Verification

1. **Plugin-absent, from the BROWSER** — not just the server. Unwire
   `alarm-browser.js`, load every page, assert: no Control nav entry, no console
   errors, core pages render, and `window.__dashPlugins` is empty/absent.
2. **Grep gate** — no `public/` core file matches `alarm|pacHost|pac_host|camera|align`.
3. **Load order proved REACHED** — move the plugin script tag AFTER `/app.js`,
   confirm the Control page breaks, restore. A test that passes either way is
   testing nothing.
4. Control page behaviour identical: Camera renders stored images, Check device,
   Download, transfer progress, Command ledger, Yagi Align.
5. `tests/test_playwright.py` — `/control` green, plugin-boundary audit green.
6. `check_specs.py` — `All specs current.`, count validated == count present.
