// Navigation mixin: tab switching, URL routing helpers.
import { persistGet, persistSet } from './app-persist.js';

const _PATH_TO_TAB = {
  '/overview': 'overview', '/radar': 'radar', '/nodes': 'nodes',
  '/config': 'cfg', '/range': 'range', '/messages': 'messages', '/devices': 'devices',
  '/performance': 'perf',
};
const _TAB_TO_PATH = {
  overview: '/', radar: '/radar', nodes: '/nodes',
  cfg: '/config', range: '/range', messages: '/messages', devices: '/devices',
  perf: '/performance',
};

export function initTab() {
  if (window.location.pathname.startsWith('/status/')) return 'status';
  return _PATH_TO_TAB[window.location.pathname] ?? persistGet('activeTab', 'overview');
}

export const navMixin = {
  setNav(t, c) {
    // Tabs are lazy-mounted (x-if): destroy the perf Chart.js instances before
    // leaving perf so its canvases unmount cleanly and re-init fresh on return.
    if (this.tab === 'perf' && t !== 'perf') this.destroyPerfCharts();
    if (this.tab === 'status' && t !== 'status') this.destroyStatusCharts();
    this.tab = t;
    persistSet('activeTab', t);
    if (c) { this.cfgTab = c; persistSet('cfgTab', c); }
    this.drawerOpen = false;
    // Status carries a node in its URL; every other tab uses the static map.
    const p = t === 'status' ? '/status/' + this.statusHex(this.statusNum) : (_TAB_TO_PATH[t] || '/');
    if (window.location.pathname !== p) history.pushState({ tab: t }, '', p);
    if (t === 'radar') this.$nextTick(() => this.initRadar());
    else if (t === 'cfg') this.switchCfgTab(c || this.cfgTab || 'radio');
    else if (t === 'range') { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
    else if (t === 'messages') this.unreadMessages = 0;
    else if (t === 'perf') { this.adoptPerfLoraCfg(); this.perfHistory = this.perfHistorySlice(); this.$nextTick(() => this.initPerfCharts()); }
    else if (t === 'status') this.requestNodeStatus();
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
