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
        case 'snr':        return this.signalQuality(n.rssi, n.snr, n).pct;
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
        const sq = this.signalQuality(n.rssi, n.snr, n);
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

  nodeLabel(num) {
    if (num == null) return '';
    const n = this.nodes.find(n => n.num === num)
           ?? this._knownNodes.find(n => n.num === num)
           ?? this.msgNodeCache[num];
    return n?.display_name || n?.user?.short_name || '';
  },

  nodeShortName(num) { return this.nodeLabel(num); },

  nodeLongName(num) {
    if (num == null) return '';
    const n = this.nodes.find(n => n.num === num)
           ?? this._knownNodes.find(n => n.num === num)
           ?? this.msgNodeCache[num];
    return n?.user?.long_name || n?.user?.short_name || this.nodeLabel(num);
  },

  avatarColor(num) {
    const h = ((num >>> 0) * 2654435761 >>> 0) % 360;
    return `hsl(${h},55%,45%)`;
  },

  nodeHops(n) {
    // Backend-decided display distance (ws-relay.enrichEvent): traceroute-
    // verified relay count preferred over reported live hops. The UI does NOT
    // choose the source — presentation layer only (BROWSER_CONTRACT).
    return n?.hops_display ?? null;
  },

  nodeHopsIsVerified(n) {
    // Whether nodeHops came from a traceroute — for badge styling only.
    return n?.hops_verified != null;
  },

  nodeHopsFresh(n) {
    // Backend-decided: is the verifying traceroute still fresh (vs stale/cached)?
    // Drives green (fresh) vs amber (stale) dot. No age math in the UI.
    return !!n?.hops_fresh;
  },

  // Toggle only — no local mutation. The star re-renders from the re-broadcast
  // node_list, so what you see is always what the server holds (the same rule
  // that fixed the message feed).
  async toggleFavourite(n) {
    if (!n?.num) return;
    try {
      await fetchJSON(`/nodes/${n.num}/favourite`, 'PUT', { favourite: !n.favourite });
    } catch (e) {
      this.showToast(e.message || 'Could not update favourite', 'error', 0);
    }
  },

  // Discovery target — the Observatory's own flag, not the sidebar star.
  // Same no-optimistic-state rule: the icon re-renders from the re-broadcast
  // node_list, so what you see is always what the server holds.
  async toggleObsTarget(n) {
    if (!n?.num) return;
    try {
      await fetchJSON(`/nodes/${n.num}/obs_target`, 'PUT', { obs_target: !n.obs_target });
    } catch (e) {
      this.showToast(e.message || 'Could not update discovery target', 'error', 0);
    }
  },

  // RENDERS A SERVED VERDICT. This applied >=76/51/26 to produce
  // "Excellent / Good / Fair / Poor" while sigQualColor beside it used
  // >=75/50/25 — a node at 75% read "Good" in the excellent colour. Two
  // threshold sets on one screen, both live.
  //
  // The bands now live in src/signal-verdict.js and arrive on the node as
  // `signal { pct, label, tone, none }`. Mapping a tone to CSS is this file's
  // job; deciding what counts as "Good" is not (BROWSER_CONTRACT: "if a display
  // differs based on a condition, that condition is evaluated in Node.js").
  //
  // The rssi/snr arguments are kept so every call site is unchanged; the node's
  // served verdict is preferred and they are the fallback for a node that has
  // not been enriched yet.
  signalQuality(rssi, snr, node = null) {
    const TONE = {
      success: { cls: 'text-success',           badgeCls: 'badge-success' },
      warning: { cls: 'text-warning',           badgeCls: 'badge-warning' },
      error:   { cls: 'text-error',             badgeCls: 'badge-error'   },
      muted:   { cls: 'text-base-content/30',   badgeCls: 'badge-ghost'   },
    };
    const v = node?.signal;
    if (v) {
      const t = TONE[v.tone] ?? TONE.muted;
      return { pct: v.pct ?? 0, label: v.label, cls: t.cls, badgeCls: t.badgeCls, none: !!v.none };
    }
    // Not yet enriched — say so rather than inventing a band.
    const t = TONE.muted;
    return { pct: 0, label: 'No signal', cls: t.cls, badgeCls: t.badgeCls, none: true };
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
