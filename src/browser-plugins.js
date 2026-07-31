// CORE. The host's browser-extension point — generic, and it names no plugin.
//
// The server side already had three of these (registerNodeSection,
// registerWsWiring, registerConnectReplay). This is the browser equivalent, and
// it exists because the alarm's entire Control page was living in core partials
// and mixins. Peter, 2026-07-31: "this must NOT live in core".
//
// See docs/BROWSER_PLUGIN_SPEC.md.

/** @typedef {{ tab?: string, partial?: string, nav?: string, scripts?: string[] }} BrowserPlugin */

const _plugins = [];

/** Register a browser-side plugin. Called at import time by a plugin's own
 *  server module; core never calls this and never inspects what it is given
 *  beyond the four generic fields. */
export function registerBrowserPlugin(descriptor) {
  if (descriptor) _plugins.push(descriptor);
}

/** Test/introspection only. */
export function browserPlugins() {
  return _plugins.slice();
}

// -- marker rendering --------------------------------------------------------
// index.html carries three generic markers. With NO plugins registered every one
// of them renders to an empty string, which is the plugin-absent case and must
// stay a clean no-op: no empty nav, no dead x-if, no console error.

/** `<template x-if="tab==='X'">…partial…</template>` per plugin that declares a tab. */
export function renderPluginTabs(readPartial) {
  return _plugins
    .filter(p => p.tab && p.partial)
    .map(p => `<template x-if="tab==='${p.tab}'">${readPartial(p.partial)}</template>`)
    .join('\n');
}

/** Each plugin's nav fragment, in registration order. */
export function renderPluginNav(readPartial) {
  return _plugins
    .filter(p => p.nav)
    .map(p => readPartial(p.nav))
    .join('\n');
}

/** Each plugin's header fragment (status badges etc.), in registration order. */
export function renderPluginHeader(readPartial) {
  return _plugins
    .filter(p => p.header)
    .map(p => readPartial(p.header))
    .join('\n');
}

/** Module script tags.
 *
 *  These are emitted BEFORE /app.js deliberately, and it is load-bearing: the
 *  plugin pushes onto window.__dashPlugins and core reads that array when Alpine
 *  evaluates x-data. A plugin script that ran afterwards would register into an
 *  array nobody reads again — silently, with the page looking fine until the
 *  moment you need the plugin's state. That is exactly how alarm-ws.js failed
 *  (0 live broadcasts in 110 s while connect replay still worked). */
export function renderPluginScripts() {
  return _plugins
    .flatMap(p => p.scripts || [])
    .map(src => `<script type="module" src="${src}"></script>`)
    .join('\n');
}
