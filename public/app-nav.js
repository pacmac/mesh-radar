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
  return _PATH_TO_TAB[window.location.pathname] ?? persistGet('activeTab', 'overview');
}

export const navMixin = {
  setNav(t, c) {
    this.tab = t;
    persistSet('activeTab', t);
    if (c) { this.cfgTab = c; persistSet('cfgTab', c); }
    this.drawerOpen = false;
    const p = _TAB_TO_PATH[t] || '/';
    if (window.location.pathname !== p) history.pushState({ tab: t }, '', p);
    if (t === 'radar') this.$nextTick(() => this.initRadar());
    else if (t === 'cfg') this.switchCfgTab(c || this.cfgTab || 'radio');
    else if (t === 'range') { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
    else if (t === 'messages') this.unreadMessages = 0;
    else if (t === 'perf') { this.loadPerfLoraCfg(); this.loadPerfHistory(); }
  },

  // Build a device-scoped URL using the active device.
  d(path) {
    return this.activeNodeId ? '/' + this.activeNodeId + path : path;
  },

  // Like d() but uses cfgRadioId for Radio Config tab operations.
  cd(path) {
    const id = this.cfgRadioId || this.activeNodeId;
    return id ? '/' + id + path : path;
  },
};
