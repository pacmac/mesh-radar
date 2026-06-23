// Node list management mixin: sorting, filtering, grouping, node helpers.
import { fetchJSON, rssiPercent } from './app-helpers.js';
import { FILTER_CFG_KEY } from './app-forms.js';

export const nodesMixin = {
  sortNodes(key, keepDir) {
    if (!keepDir) {
      this.nodeSort.dir = this.nodeSort.key === key ? -this.nodeSort.dir : -1;
    }
    this.nodeSort.key = key;
    const dir = this.nodeSort.dir;
    const getVal = (n) => {
      switch (key) {
        case 'long_name':  return n.user?.long_name || n.user?.short_name || '';
        case 'short_name': return n.user?.short_name || '';
        case 'id':         return n.user?.id || String(n.num ?? 0);
        case 'battery':    return n.device_metrics?.battery_level ?? -1;
        case 'snr':        return this.signalQuality(n.rssi, n.snr).pct;
        case 'rssi':       return rssiPercent(n.rssi ?? -999);
        case 'km':         return this.nodeKm(n) ?? 9999;
        case 'az':         return this.nodeAz(n) ?? -1;
        case 'hops':       return this.nodeHops(n) ?? 999;
        case 'last_heard': return n.last_heard ?? 0;
        default:           return n[key] ?? '';
      }
    };
    this.nodes.sort((a, b) => {
      const av = getVal(a), bv = getVal(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  },

  saveNodeFilter(key, val) {
    this.nodeFilters[key] = val;
    const cfgKey = FILTER_CFG_KEY[key];
    if (cfgKey) fetchJSON(`/config/${cfgKey}`, 'PUT', { value: val }).catch(() => {});
  },

  toggleNodeRole(role, checked) {
    const ALL = ['CLIENT','CLIENT_BASE','CLIENT_MUTE','ROUTER','ROUTER_CLIENT','ROUTER_LATE','TRACKER','SENSOR','REPEATER'];
    let cur = this.nodeFilters.nodeRoles.length ? [...this.nodeFilters.nodeRoles] : [...ALL];
    cur = checked ? [...new Set([...cur, role])] : cur.filter(r => r !== role);
    this.saveNodeFilter('nodeRoles', cur.length === ALL.length ? [] : cur);
  },

  filteredNodes() {
    return this.nodes;
  },

  allMsgNodes() {
    const base = this._knownNodes.length ? this._knownNodes : this.nodes;
    const nums = new Set(base.map(n => n.num));
    const extra = Object.values(this.msgNodeCache).filter(n => !nums.has(n.num));
    return [...base, ...extra].sort((a, b) => {
      const an = (a.user?.long_name || a.user?.short_name || '').toLowerCase();
      const bn = (b.user?.long_name || b.user?.short_name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  },

  setNodeSource(src) {
    this.nodeSource = src;
    fetchJSON('/config/node_filters.node_source', 'PUT', { value: src }).catch(() => {});
  },

  nodeById(nodeId) {
    if (!nodeId?.startsWith('!')) return null;
    const num = parseInt(nodeId.slice(1), 16);
    return this.deviceNodes[nodeId] ?? this.nodes.find(n => n.num === num) ?? null;
  },

  nodeGroupLabel(n) {
    const key = this.nodeSort.key;
    const now = Date.now() / 1000;
    switch (key) {
      case 'last_heard': {
        const lh = n.last_heard;
        if (!lh) return 'Unknown';
        const age = now - lh;
        if (age < 120)   return 'Just now';
        if (age < 300)   return '5 min';
        if (age < 900)   return '15 min';
        if (age < 1800)  return '30 min';
        if (age < 3600)  return '1 hour';
        if (age < 10800) return '3 hours';
        if (age < 21600) return '6 hours';
        if (age < 86400) return 'Today';
        return 'Older';
      }
      case 'snr': {
        const sq = this.signalQuality(n.rssi, n.snr);
        return sq.none ? 'No signal' : sq.label;
      }
      case 'hops': {
        const h = this.nodeHops(n);
        if (h == null) return 'Unknown';
        if (h === 0)   return 'Direct';
        if (h === 1)   return '1 hop';
        if (h === 2)   return '2 hops';
        if (h === 3)   return '3 hops';
        return '4+ hops';
      }
      case 'km': {
        const km = this.nodeKm(n);
        if (km == null) return 'No position';
        if (km < 2)    return '< 2 km';
        if (km < 5)    return '2–5 km';
        if (km < 10)   return '5–10 km';
        if (km < 25)   return '10–25 km';
        if (km < 50)   return '25–50 km';
        if (km < 100)  return '50–100 km';
        return '> 100 km';
      }
      case 'long_name': {
        const name = n.user?.long_name || n.user?.short_name || '';
        if (!name) return 'Unnamed';
        const c = name[0].toUpperCase();
        if (c <= 'E') return 'A–E';
        if (c <= 'J') return 'F–J';
        if (c <= 'O') return 'K–O';
        if (c <= 'T') return 'P–T';
        if (c <= 'Z') return 'U–Z';
        return 'Other';
      }
      default: return null;
    }
  },

  groupedNodes() {
    const nodes = this.filteredNodes();
    const groups = [];
    let curLabel = null;
    for (const n of nodes) {
      const label = this.nodeGroupLabel(n) ?? '—';
      if (label !== curLabel) {
        curLabel = label;
        groups.push({ label, nodes: [] });
      }
      groups[groups.length - 1].nodes.push(n);
    }
    const multi = groups.length > 1;
    return groups.map(g => ({ ...g, showHeader: multi }));
  },

  activeFilterCount() {
    const f = this.nodeFilters;
    return [
      this.nodeSource !== 'both',
      f.maxHops !== 99,
      f.maxAge  !== 0,
      f.namedOnly, f.hasPos, f.hideMqtt, f.hasSignal, f.hasTelem,
      f.nodeRoles?.length > 0,
    ].filter(Boolean).length;
  },

  resetNodeFilters() {
    this.nodeSource = 'both';
    this.nodeFilters = {
      maxHops: 99, maxAge: 0, namedOnly: false, hasPos: false,
      hideMqtt: false, hasSignal: false, hasTelem: false, msgOnly: false, nodeRoles: [],
    };
    fetchJSON('/config', 'PUT', {
      'node_filters.node_source': 'both',
      'node_filters.max_hops':    99,
      'node_filters.max_age':     0,
      'node_filters.named_only':  false,
      'node_filters.has_pos':     false,
      'node_filters.hide_mqtt':   false,
      'node_filters.has_signal':  false,
      'node_filters.has_telem':   false,
      'node_filters.msg_only':    false,
      'node_filters.roles':       [],
    }).catch(() => {});
  },

  nodeShortName(num) {
    const n = this.nodes.find(n => n.num === num)
           ?? this._knownNodes.find(n => n.num === num)
           ?? this.msgNodeCache[num];
    return n?.user?.short_name || ('!' + (num & 0xFFFF).toString(16).toUpperCase());
  },

  nodeLongName(num) {
    const n = this.nodes.find(n => n.num === num)
           ?? this._knownNodes.find(n => n.num === num)
           ?? this.msgNodeCache[num];
    return n?.user?.long_name || n?.user?.short_name || ('!' + (num & 0xFFFF).toString(16).toUpperCase());
  },

  avatarColor(num) {
    const h = ((num >>> 0) * 2654435761 >>> 0) % 360;
    return `hsl(${h},55%,45%)`;
  },

  nodeHops(n) {
    const tr = n?.last_traceroute;
    if (tr?.route != null) return tr.route.length;
    return n?.hops_away ?? n?.hops ?? null;
  },

  signalQuality(rssi, snr) {
    const pct = window.signalQuality(rssi, snr);
    if (pct === 0 && rssi == null && snr == null) return { pct: 0, label: 'No signal', cls: 'text-base-content/30', badgeCls: 'badge-ghost', none: true };
    const label    = pct >= 76 ? 'Excellent' : pct >= 51 ? 'Good' : pct >= 26 ? 'Fair' : 'Poor';
    const cls      = pct >= 76 ? 'text-success' : pct >= 51 ? 'text-success' : pct >= 26 ? 'text-warning' : 'text-error';
    const badgeCls = pct >= 76 ? 'badge-success' : pct >= 51 ? 'badge-success' : pct >= 26 ? 'badge-warning' : 'badge-error';
    return { pct, label, cls, badgeCls, none: false };
  },

  sigQualColor(pct) {
    if (pct >= 75) return 'oklch(0.72 0.20 145)';
    if (pct >= 50) return 'oklch(0.80 0.18 115)';
    if (pct >= 25) return 'oklch(0.78 0.17 65)';
    if (pct > 0)   return 'oklch(0.68 0.20 38)';
    return 'rgba(255,255,255,0.08)';
  },

  nodeKm(n) { return n._km ?? null; },
  nodeAz(n) { return n._az ?? null; },
  rssiPercent(rssi) { return rssiPercent(rssi); },
};
