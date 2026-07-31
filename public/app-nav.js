// Navigation mixin: tab switching, URL routing helpers.
import { persistGet, persistSet } from './app-persist.js';

// Core routes. Plugin routes are merged in below from window.__dashPlugins —
// core names no plugin tab or path (docs/BROWSER_PLUGIN_SPEC.md).
const _PATH_TO_TAB = {
  '/': 'overview', '/overview': 'overview', '/radar': 'radar', '/nodes': 'nodes',
  '/config': 'cfg', '/range': 'range', '/messages': 'messages', '/devices': 'devices',
  '/device-config': 'devices', '/performance': 'perf',
};
const _TAB_TO_PATH = {
  overview: '/', radar: '/radar', nodes: '/nodes',
  cfg: '/config', range: '/range', messages: '/messages', devices: '/devices',
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
    // Tabs are lazy-mounted (x-if): destroy the perf Chart.js instances before
    // leaving perf so its canvases unmount cleanly and re-init fresh on return.
    if (this.tab === 'perf' && t !== 'perf') this.destroyPerfCharts();
    // Same reason as perf: lazy-mounted x-if tabs must release Chart.js
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
    else if (t === 'range') { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
    else if (t === 'messages') this.unreadMessages = 0;
    else if (t === 'perf') { this.adoptPerfLoraCfg(); this.perfHistory = this.perfHistorySlice(); this.$nextTick(() => this.initPerfCharts()); }
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

  // Like d() but uses cfgRadioId for Radio Config tab operations.
  cd(path) {
    const id = this.cfgRadioId || this.activeNodeId;
    return id ? '/' + id + path : path;
  },
};
