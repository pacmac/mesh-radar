// Range test mixin: loading, display, chart, export.
import { fetchJSON } from './app-helpers.js';

export const rangeMixin = {
  loadRangeTest() { /* no-op — log arrives via WS range_test_log on connect */ },

  async clearRangeTest() {
    if (!confirm('Clear all range test data? This cannot be undone.')) return;
    await fetchJSON('/range_test/log', 'DELETE');
    this.rangeLog = [];
    this._rangeStats = null; this._rangeChartCache = null;
  },

  loadRangeTimer() { /* no-op — timer state arrives via WS range_test_timer on connect */ },

  _startRangeCountdown() {
    if (this._rangeCountdown) clearInterval(this._rangeCountdown);
    if (!this.rangeTimer.active) { clearInterval(this._rangeAutoSync); this._rangeAutoSync = null; return; }
    this._rangeCountdown = setInterval(() => {
      if (!this.rangeTimer.endsAt) { clearInterval(this._rangeCountdown); return; }
      const rem = Math.max(0, Math.round((this.rangeTimer.endsAt - Date.now()) / 1000));
      this.rangeTimer = { ...this.rangeTimer, remaining: rem };
      if (rem === 0) {
        clearInterval(this._rangeCountdown);
        this.rangeTimer = { active: false, endsAt: null, nodeId: null, remaining: null };
      }
    }, 1000);
  },

  async startRangeTest(nodeId) {
    if (!nodeId) nodeId = this.activeNodeId;
    if (!nodeId) return;
    try {
      const t = await fetchJSON('/range_test/start', 'POST', { nodeId, durationMin: this.rangeDuration });
      if (t.error) { alert('Failed to start: ' + t.error); return; }
      this.rangeTimer = { active: true, endsAt: t.endsAt, nodeId, remaining: this.rangeDuration * 60 };
      this._startRangeCountdown();
      await fetchJSON('/config/range_test.duration', 'PUT', { value: this.rangeDuration });
    } catch (err) {
      alert('Failed to start range test: ' + err.message);
    }
  },

  async stopRangeTest() {
    if (this._rangeCountdown) clearInterval(this._rangeCountdown);
    if (this._rangeAutoSync)  { clearInterval(this._rangeAutoSync); this._rangeAutoSync = null; }
    this.rangeTimer = { active: false, endsAt: null, nodeId: null, remaining: null };
    await fetchJSON('/range_test/stop', 'POST', {});
  },

  rangeFmtCountdown(sec) {
    if (sec == null) return '';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  },

  filteredRangeLog() {
    let log = this.rangeRxFilter
      ? this.rangeLog.filter(e => e.rx_device === this.rangeRxFilter)
      : [...this.rangeLog];
    if (this.rangeNodeFilter) log = log.filter(e => e.from_num === this.rangeNodeFilter);
    return log;
  },

  rangeLogNodes() {
    const base = this.rangeRxFilter
      ? this.rangeLog.filter(e => e.rx_device === this.rangeRxFilter)
      : this.rangeLog;
    const seen = new Map();
    for (const e of base) {
      if (!seen.has(e.from_num)) seen.set(e.from_num, e.from_name || '');
    }
    return Array.from(seen.entries()).map(([num, name]) => ({ num, name }));
  },

  _loraFreqMHz(rxDevice) {
    const REGION_FREQ = {
      EU_868: 868, US: 915, EU_433: 433, CN: 470, JP: 920, ANZ: 915,
      KR: 920, TW: 923, RU: 868, IN: 865, NZ_865: 865, TH: 923,
      UA_433: 433, UA_868: 868, MY_433: 433, MY_919: 919, SG_923: 923,
    };
    const id = rxDevice || this.rangeRxFilter || this.activeNodeId;
    return REGION_FREQ[this.deviceConfigs[id]?.lora_region] ?? 868;
  },

  rangeEnrich(e) {
    const node = this.nodes.find(n => n.num === e.from_num);
    const distKm = node?._km ?? null;
    const az     = node?._az ?? null;
    let expectedRssi = null, excessLoss = null;
    if (distKm != null && distKm > 0) {
      const freq = this._loraFreqMHz(e.rx_device);
      const fspl = 20 * Math.log10(distKm) + 20 * Math.log10(freq) + 32.4;
      const txNodeId = '!' + (e.from_num >>> 0).toString(16);
      const txCfg = this.deviceConfigs[txNodeId] || {};
      const txPow  = txCfg.tx_power_dbm ?? 22;
      const txEIRP = txPow + (txCfg.gain_dbi ?? 2) - (txCfg.cable_loss_db ?? 0);
      const rxCfg = this.deviceConfigs[e.rx_device] || {};
      const rxGain = (rxCfg.gain_dbi ?? 2) - (rxCfg.cable_loss_db ?? 0);
      expectedRssi = Math.round(txEIRP + rxGain - fspl);
      if (e.rssi != null) excessLoss = parseFloat((expectedRssi - e.rssi).toFixed(1));
    }
    return {
      ...e,
      distKm, az: az != null ? Math.round(az) : null, expectedRssi, excessLoss,
    };
  },

  _rssiColor(rssi) {
    if (rssi == null) return '#444';
    const t = Math.max(0, Math.min(1, (rssi + 130) / 90));
    return `hsl(${Math.round(t * 120)},80%,50%)`;
  },

  rangeChartData() {
    if (this._rangeChartCache !== null) return this._rangeChartCache;
    const enriched = this.filteredRangeLog()
      .map(e => this.rangeEnrich(e))
      .filter(e => e.distKm != null && e.az != null && e.rssi != null);

    const maxDist = enriched.length
      ? Math.max(2, Math.ceil(Math.max(...enriched.map(e => e.distKm)) / 5) * 5)
      : 10;
    const cx = 150, cy = 150, maxR = 118;
    const points = enriched.map(e => {
      const r  = (e.distKm / maxDist) * maxR;
      const az = e.az * Math.PI / 180;
      return {
        x: cx + r * Math.sin(az),
        y: cy - r * Math.cos(az),
        color: this._rssiColor(e.rssi),
        tip: `${e.nodeName}  ${e.rssi} dBm  ${e.distKm.toFixed(1)} km  ${e.az}°`,
      };
    });
    const rings = [0.25, 0.5, 0.75, 1].map(f => ({
      r: f * maxR,
      label: (f * maxDist < 10 ? (f * maxDist).toFixed(1) : Math.round(f * maxDist)) + ' km',
      ly: cy - f * maxR - 3,
    }));

    const bins = Array.from({ length: 36 }, () => []);
    for (const e of enriched) {
      const b = Math.floor(((e.az % 360) + 360) % 360 / 10);
      bins[b].push(e.rssi);
    }
    const r1 = 72, r2 = 128;
    const arcPaths = bins.map((b, i) => {
      const avg  = b.length ? b.reduce((s, v) => s + v, 0) / b.length : null;
      const a1   = (i * 10 - 90) * Math.PI / 180;
      const a2   = ((i + 1) * 10 - 90) * Math.PI / 180;
      const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
      const cos2 = Math.cos(a2), sin2 = Math.sin(a2);
      const d = [
        `M${cx + r1*cos1},${cy + r1*sin1}`,
        `L${cx + r2*cos1},${cy + r2*sin1}`,
        `A${r2},${r2} 0 0,1 ${cx + r2*cos2},${cy + r2*sin2}`,
        `L${cx + r1*cos2},${cy + r1*sin2}`,
        `A${r1},${r1} 0 0,0 ${cx + r1*cos1},${cy + r1*sin1}Z`,
      ].join(' ');
      return { d, color: avg != null ? this._rssiColor(avg) : '#1e1e1e', avg, deg: i * 10 };
    });

    this._rangeChartCache = { points, rings, maxDist, arcPaths, hasData: enriched.length > 0 };
    return this._rangeChartCache;
  },

  rangeRingsSvg() {
    return this.rangeChartData().rings.map(r =>
      `<circle cx="150" cy="150" r="${r.r}" fill="none" stroke="currentColor" stroke-opacity="0.12" stroke-width="1" stroke-dasharray="3,3"/>` +
      `<text x="153" y="${r.ly}" class="fill-current" style="font-size:8px;opacity:0.35">${r.label}</text>`
    ).join('');
  },

  rangePointsSvg() {
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return this.rangeChartData().points.map(pt =>
      `<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="${pt.color}" fill-opacity="0.85" stroke="rgba(255,255,255,0.3)" stroke-width="0.8">` +
      `<title>${esc(pt.tip)}</title></circle>`
    ).join('');
  },

  rangeArcsSvg() {
    return this.rangeChartData().arcPaths.map(seg => {
      const tip = `${seg.deg}° – ${seg.deg+10}°: ${seg.avg != null ? Math.round(seg.avg) + ' dBm avg' : 'no data'}`;
      return `<path d="${seg.d}" fill="${seg.color}" stroke="#0a0a0a" stroke-width="0.6"><title>${tip}</title></path>`;
    }).join('');
  },

  rangeStats() {
    if (this._rangeStats !== null) return this._rangeStats;
    const enriched = this.filteredRangeLog().map(e => this.rangeEnrich(e)).filter(e => e.rssi != null);
    if (!enriched.length) { this._rangeStats = false; return null; }
    const rssis  = enriched.map(e => e.rssi).sort((a, b) => a - b);
    const snrs   = enriched.filter(e => e.snr  != null).map(e => e.snr).sort((a, b) => a - b);
    const losses = enriched.filter(e => e.excessLoss != null).map(e => e.excessLoss).sort((a, b) => a - b);
    const dists  = enriched.filter(e => e.distKm != null).map(e => e.distKm);
    const median = arr => arr[Math.floor(arr.length / 2)];
    this._rangeStats = {
      count: enriched.length,
      medianRssi: median(rssis), bestRssi: rssis[rssis.length - 1], worstRssi: rssis[0],
      medianSnr:  snrs.length  ? parseFloat(median(snrs).toFixed(1))  : null,
      bestSnr:    snrs.length  ? snrs[snrs.length - 1]                 : null,
      medianExcessLoss: losses.length ? parseFloat(median(losses).toFixed(1)) : null,
      maxDistKm: dists.length ? Math.max(...dists).toFixed(1) : null,
    };
    return this._rangeStats;
  },

  exportRangeCsv() {
    const log = this.filteredRangeLog();
    if (!log.length) return;
    const header = 'time,node,seq,dist_km,az_deg,rssi_dbm,snr_db,exp_rssi,excess_loss_db,hops,rx_device';
    const rows = log.map(raw => {
      const e = this.rangeEnrich(raw);
      const t = new Date(e.ts * 1000).toISOString();
      return [
        t, `"${e.nodeName}"`, e.seq ?? '', e.distKm != null ? e.distKm.toFixed(2) : '',
        e.az ?? '', e.rssi ?? '', e.snr ?? '', e.expectedRssi ?? '', e.excessLoss ?? '',
        e.hops ?? '', e.rx_device ?? '',
      ].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `range-test-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
    a.click();
  },
};
