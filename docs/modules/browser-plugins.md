---
module: browser-plugins
source: src/browser-plugins.js
source_hash: 0e36324cadace7cbc282244e6167e35314aa92b16e155f4bf0beb47ed845c183
updated: 2026-07-31
---

# Module: browser-plugins

## Purpose

**CORE.** The host's browser extension point — generic, and it names no plugin.
The server side already had three of these (`registerNodeSection`,
`registerWsWiring`, `registerConnectReplay`); this is the browser equivalent.

It exists because the alarm's entire Control page was living in core partials
and mixins. Peter, 2026-07-31: *"this must NOT live in core"*.

## Public interface

```js
export function registerBrowserPlugin(descriptor)   // called by a plugin's own server module
export function browserPlugins()                    // introspection/tests only
export function renderPluginTabs(readPartial)       // <template x-if="tab==='X'">…</template>
export function renderPluginNav(readPartial)
export function renderPluginHeader(readPartial)
export function renderPluginScripts()
```

Descriptor: `{ tab, partial, nav, header, scripts[] }`. Core reads nothing else
and interprets none of it.

## The four markers

`index.js`'s `assembleIndex()` fills `<!-- plugin: tabs|nav|header|scripts -->`.

**Marker substitution runs AFTER include substitution, and that is load-bearing.**
The `nav` marker lives inside `drawer-sidebar.html`, so it does not exist in the
document until that partial has been inlined. Substituting first leaves the
marker in place as an HTML comment — the sidebar renders, minus the plugin's
entries, and nothing errors. That was written the wrong way round first.

## Invariants

- **No registrations must render every marker to an empty string.** Verified
  2026-07-31 by unwiring `alarm-browser.js`: no Control nav, no header badge, no
  plugin script tags, no unreplaced markers, **0 console errors**, core nav and
  Overview intact.
- **Plugin scripts are emitted BEFORE `/app.js`.** Proved load-bearing by
  inverting it: the plugin still registered and the nav still rendered, but the
  Control page body collapsed to 1237 chars with the unit picker gone — and
  **zero console errors**. Silent, exactly like `alarm-ws.js`'s dynamic-import
  failure. Never reorder these two tags.
- Core must never name a plugin, a plugin tab, or a plugin path.
- A plugin partial that is missing renders `<!-- missing plugin partial: … -->`
  rather than throwing.

## Out of scope

- What any plugin's markup or mixins do — see that plugin's own spec.
- The server-side hooks (`ws-relay.js`, `node-status.js`).
