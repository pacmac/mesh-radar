// Node Status page mixin (NODE_STATUS_SPEC Phase C). Presentation only:
// requests the node_status WS RPC, renders generic + monitored enrichment,
// manages its Chart.js instances, drives /status/:id navigation.
import { persistSet } from './app-persist.js';

let _statusCharts = {};   // reassigned by destroyStatusCharts() (lazy tab)

// !hex is the node number in hex — parse client-side, no gateway call.
function _idToNum(id) {
  if (id == null) return null;
  const s = String(id);
  const n = s.startsWith('!') ? parseInt(s.slice(1), 16) : parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export const statusMixin = {
  // Parse /status/:id from the URL at boot.
  initStatusNum() {
    const m = /^\/status\/(.+)$/.exec(window.location.pathname);
    this.statusNum = m ? _idToNum(decodeURIComponent(m[1])) : null;
  },

  statusHex(num) {
    return num != null ? '!' + (num >>> 0).toString(16).padStart(8, '0') : '';
  },

  statusIsMonitored(num) {
    return !!(this.monitoredNodes || {})[String(num)];
  },

  statusMasked(field) {
    const m = (this.monitoredNodes || {})[String(this.statusNum)]?.mask;
    return Array.isArray(m) && m.includes(field);
  },

  // Navigate to a node's status page.
  openNodeStatus(num) {
    this.statusNum = num;
    this.setNav('status');
  },

  // Page data stays WS-only (C2) — ask the relay for this node's status.
  requestNodeStatus() {
    if (this.statusNum == null || !this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify({ type: 'node_status', num: this.statusNum }));
  },

  // WS handlers (wired from app-ws.js)
  _onNodeStatus(ev) {
    if (ev.num !== this.statusNum) return;
    this.statusData = ev.error ? null : ev;
    if (this.tab === 'status') this.$nextTick(() => this.initStatusCharts());
  },
  _onNodeStatusUpdate(ev) {
    if (ev.num === this.statusNum && this.tab === 'status') this.requestNodeStatus();
  },

  statusHeartbeat() {
    return this.statusData?.heartbeats?.[0] ?? null;
  },

  // "2m ago" — the liveness headline.
  statusAge(ts) {
    if (!ts) return '—';
    const s = Math.floor(Date.now() / 1000) - ts;
    if (s < 5)     return 'just now';
    if (s < 90)    return s + 's ago';
    if (s < 5400)  return Math.round(s / 60) + 'm ago';
    if (s < 172800) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  },

  // Latest signal sample (most recent message with rssi/snr).
  statusSignal() {
    return this.statusData?.signal?.[0] ?? null;
  },

  // ── Charts (Chart.js) — perf-page lifecycle: destroyed on tab-leave ───────
  initStatusCharts() {
    this.destroyStatusCharts();
    const d = this.statusData;
    if (!d) return;
    const themeGrid = getComputedStyle(document.documentElement)
      .getPropertyValue('--fallback-bc') || 'rgba(128,128,128,.15)';
    const base = {
      type: 'line',
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { intersect: false, mode: 'index' },
        scales: { x: { display: false }, y: { grid: { color: themeGrid + '22' } } },
        plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } },
        elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0.25 } },
      },
    };
    const mk = (ref, datasets, labels) => {
      const el = document.getElementById(ref);
      if (!el) return;
      _statusCharts[ref] = new window.Chart(el, { ...base, data: { labels, datasets } });
    };

    // Environment: temp + humidity (chronological)
    const env = [...(d.env || [])];
    mk('statusEnvChart', [
      { label: '°C',  data: env.map(r => r.temperature),       borderColor: '#f5a623', yAxisID: 'y' },
      { label: '%rh', data: env.map(r => r.relative_humidity), borderColor: '#00d4c8', yAxisID: 'y' },
    ], env.map(r => r.ts));

    // Voltage from heartbeats (reverse: they arrive newest-first)
    const hb = [...(d.heartbeats || [])].reverse();
    mk('statusVbatChart', [
      { label: 'V', data: hb.map(r => r.vbat_v), borderColor: '#f87171' },
    ], hb.map(r => r.ts));

    // Signal rssi/snr (reverse: newest-first)
    const sig = [...(d.signal || [])].reverse();
    mk('statusSigChart', [
      { label: 'RSSI', data: sig.map(r => r.rssi), borderColor: '#00857d' },
      { label: 'SNR',  data: sig.map(r => r.snr),  borderColor: '#996607' },
    ], sig.map(r => r.ts));
  },

  destroyStatusCharts() {
    for (const c of Object.values(_statusCharts)) { try { c.destroy(); } catch {} }
    _statusCharts = {};
  },
};
