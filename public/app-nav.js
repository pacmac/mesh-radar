// Navigation mixin: tab switching, URL routing helpers.
import { persistGet, persistSet } from './app-persist.js';

// Core routes. Plugin routes are merged in below from window.__dashPlugins —
// core names no plugin tab or path (docs/BROWSER_PLUGIN_SPEC.md).
const _PATH_TO_TAB = {
  '/': 'overview', '/overview': 'overview', '/radar': 'radar', '/nodes': 'nodes',
  '/config': 'cfg', '/range': 'range', '/performance': 'perf',
};
const _TAB_TO_PATH = {
  overview: '/', radar: '/radar', nodes: '/nodes',
  cfg: '/config', range: '/range',
  perf: '/performance',
};
for (const plugin of (window.__dashPlugins || [])) {
  for (const [tab, p] of Object.entries(plugin.routes || {})) {
    _PATH_TO_TAB[p] = tab;
    _TAB_TO_PATH[tab] = p;
  }
}

// /node/!hexid is parameterised, so it cannot live in the static map. A route
// (rather than transient tab state) means a focused node survives reload and is
// linkable — which is what "focus on this node" implies.
const _NODE_PATH_RE = /^\/node\/!([0-9a-f]+)$/i;

export function nodeNumFromPath(pathname = window.location.pathname) {
  const m = _NODE_PATH_RE.exec(pathname);
  return m ? parseInt(m[1], 16) : null;
}

export function initTab() {
  if (nodeNumFromPath()) return 'node';
  const saved = persistGet('activeTab', 'overview');
  const routed = _PATH_TO_TAB[window.location.pathname];
  if (routed) {
    if (!Object.hasOwn(_TAB_TO_PATH, saved)) persistSet('activeTab', routed);
    return routed;
  }
  if (Object.hasOwn(_TAB_TO_PATH, saved)) return saved;
  persistSet('activeTab', 'overview');
  return 'overview';
}

export function tabFromPath(pathname = window.location.pathname) {
  if (nodeNumFromPath(pathname)) return 'node';
  return _PATH_TO_TAB[pathname] ?? null;
}

export const navMixin = {
  setNav(t, c) {
    // The perf tab no longer holds Chart.js instances — its plots were all of
    // traceroute_history and went with it (2026-08-17, spec
    // docs/modules/traceroute-removal-browser.md), so there is nothing to
    // destroy on leave.
    // The trace-retire timers are UI-only and must not fire against a radar that
    // has been torn down. Cleared on leave; the feed re-establishes state on the
    // next event, and a retired trace simply stays drawn until then.
    if (this.tab === 'radar' && t !== 'radar' && this._traceRetire) {
      for (const id of Object.keys(this._traceRetire)) clearTimeout(this._traceRetire[id]);
      this._traceRetire = {};
    }
    // Lazy-mounted x-if tabs must release Chart.js
    // instances on leave or their canvases leak.
    if (this.tab === 'node' && t !== 'node') this._destroyNodeCharts();
    this.tab = t;
    persistSet('activeTab', t);
    // 'radio' shim only applies to the Config sub-tab, not Control's — see
    // cfgTab's own comment in app.js for why the legacy value needs mapping.
    const cfg = t === 'cfg' ? (c === 'radio' ? 'bridge' : c) : null;
    if (cfg) { this.cfgTab = cfg; persistSet('cfgTab', cfg); }
    // Plugin tabs may own a sub-tab. Core does not know which tabs those are or
    // what their sub-tab state is called — the plugin declares both.
    for (const plugin of (window.__dashPlugins || [])) {
      const st = plugin.subTabs?.[t];
      if (st && c) { this[st.stateKey] = c; persistSet(st.persistKey || st.stateKey, c); }
    }
    this.drawerOpen = false;
    const p = _TAB_TO_PATH[t] || '/';
    if (window.location.pathname !== p) history.pushState({ tab: t }, '', p);
    if (t === 'radar') this.$nextTick(() => this.initRadar());
    else if (t === 'cfg') this.switchCfgTab(cfg || this.cfgTab || 'bridge');
    // `this._startRangeAutoSync()` used to be called here and IS DEFINED NOWHERE
    // in public/ — opening Range threw `TypeError: this._startRangeAutoSync is
    // not a function`, which aborted setNav before the plugin onTab loop below.
    // The tab still switched and its two loaders had already run, which is how a
    // hard throw survived unnoticed. Removed 2026-08-18, spec
    // docs/modules/range-tab-autosync-removal.md.
    //
    // NOT REPLACED WITH AN IMPLEMENTATION: "auto sync" means a poll, and range
    // state already arrives on the WS (range_test_log, range_test_timer, both
    // replayed on connect). Writing the function to satisfy the call would add
    // the timer the standing rule forbids.
    else if (t === 'range') { this.loadRangeTest(); this.loadRangeTimer(); }
    else if (t === 'perf') { this.adoptPerfLoraCfg(); }
    // Plugin tab activation, AFTER the core chain — the plugin decides what
    // entering its own tab means. Placing this inside the else-if chain splits
    // it and is a syntax error; that is how it was first written.
    for (const plugin of (window.__dashPlugins || [])) plugin.onTab?.[t]?.call(this, c);
  },

  // Build a device-scoped URL using the active device. MAC-addressed:
  // always valid, whereas a node_id 404s pre-sync (IDENTITY.md §2).
  d(path) {
    const key = this.activeDevice || this.activeNodeId;
    return key ? '/' + key + path : path;
  },
};
