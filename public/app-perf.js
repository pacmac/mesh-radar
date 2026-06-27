// Performance mixin: link budget calculator, traceroute history, RF analytics.

const REGION_FREQ_MHZ = {
  EU_433: 433.175, EU_868: 868.0, US: 915.0, AU_915: 915.0, CN: 470.0,
  JP: 920.0, ANZ: 915.0, KR: 920.0, TW: 923.0, RU: 868.9, IN: 865.0,
  NZ_865: 865.0, TH: 920.0, LORA_24: 2400.0, UA_868: 868.0, MY_919: 919.0,
  SG_923: 923.0, PH_868: 868.0,
};

// LoRa SNR limits (dB) from Semtech datasheets — minimum decodable SNR per SF
const SF_SNR_LIMIT = { 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

// NF for SX1262 (typical) + implementation margin
const RX_NOISE_FIGURE_DB = 6;

export const perfMixin = {
  perfHistory:      [],
  perfLoading:      false,
  perfAutoNodes:    [],   // node nums scheduled for auto-traceroute
  _perfAutoTimer:   null,

  // ── Link budget ──────────────────────────────────────────────────────────

  perfFreqMHz() {
    const region = this.loraCfg?.region ?? 'EU_868';
    return REGION_FREQ_MHZ[region] ?? 868.0;
  },

  perfRxSensitivityDbm() {
    const sf = this.loraCfg?.spread_factor ?? 11;
    const bwKhz = this.loraCfg?.bandwidth ?? 250;
    const bwHz  = bwKhz * 1000;
    const snrLimit = SF_SNR_LIMIT[sf] ?? -17.5;
    // Friis: sensitivity = kTB + NF + SNR_min
    // kT at 290K = -174 dBm/Hz
    const sensitivity = -174 + 10 * Math.log10(bwHz) + RX_NOISE_FIGURE_DB + snrLimit;
    // Boost gain improves NF by ~1.5 dB
    return this.loraCfg?.sx126x_rx_boosted_gain ? sensitivity + 1.5 : sensitivity;
  },

  perfEirpDbm() {
    const cfg   = this.deviceConfigs?.[this.activeNodeId] ?? {};
    const txPwr = this.loraCfg?.tx_power ?? 0;
    const gain  = cfg.gain_dbi      ?? 0;
    const loss  = cfg.cable_loss_db ?? 0;
    return txPwr + gain - loss;
  },

  // Free-space path loss (dB) at distance_km and freq_MHz
  perfFspl(distKm, freqMhz) {
    if (distKm <= 0) return 0;
    return 20 * Math.log10(distKm) + 20 * Math.log10(freqMhz) + 32.45;
  },

  // Thermal noise floor — kTB + NF, no SF demodulation limit included
  // This is the reference the SX126x chip uses for its SNR measurement
  perfNoiseFloorDbm() {
    const bwHz = (this.loraCfg?.bandwidth ?? 250) * 1000;
    return -174 + 10 * Math.log10(bwHz) + RX_NOISE_FIGURE_DB;
  },

  // Minimum decodable SNR for the current spreading factor
  perfSfSnrLimitDb() {
    return SF_SNR_LIMIT[this.loraCfg?.spread_factor ?? 11] ?? -17.5;
  },

  // Theoretical chip-reported SNR in free-space at distKm
  // = EIRP - FSPL(d) - noise_floor
  // Same reference point as the radio's SNR output — directly comparable to actual
  perfTheoChipSnr(distKm) {
    if (distKm <= 0) return 0;
    return this.perfEirpDbm() - this.perfFspl(distKm, this.perfFreqMHz()) - this.perfNoiseFloorDbm();
  },

  // Max range using log-distance model with path loss exponent n
  // n=2 = free space, n=3 = rural outdoor, n=4 = suburban/urban
  perfMaxRangeKm(n = 3) {
    const lb      = this.perfEirpDbm() - this.perfRxSensitivityDbm();
    const freqMhz = this.perfFreqMHz();
    const fspl1km = 20 * Math.log10(freqMhz) + 32.45;
    return Math.pow(10, (lb - fspl1km) / (10 * n));
  },

  // Excess path loss above free-space: how many dB worse than FSPL
  // positive = real world has more loss than free space (always expected)
  perfSnrGap(actualSnr, distKm) {
    if (distKm == null || distKm <= 0 || actualSnr == null) return null;
    return this.perfTheoChipSnr(distKm) - actualSnr;
  },

  perfMargin(actualSnr) {
    if (actualSnr == null) return null;
    return actualSnr - this.perfSfSnrLimitDb();
  },

  _perfMedian(values) {
    const nums = (values || []).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  },

  _perfSnr(raw) {
    // Meshtastic uses signed quarter-dB units. -128 is a sentinel in some route rows.
    if (raw == null || raw <= -127) return null;
    return raw / 4;
  },

  // ── Traceroute history ────────────────────────────────────────────────────

  async loadPerfLoraCfg() {
    if (this.loraCfg?.tx_power != null || !this.activeNodeId) return;
    try {
      const r = await fetchJSON(this.d('/config/lora'));
      if (r?.lora) this.loraCfg = r.lora;
    } catch (e) {
      console.warn('[perf] loadPerfLoraCfg failed', e);
    }
  },

  // ── Auto-traceroute scheduler ─────────────────────────────────────────────
  perfAutoIntervalMin: 5,

  _perfAutoTick() {
    if (!this.perfAutoNodes?.length) return;
    for (const num of this.perfAutoNodes) {
      const nodeId = this.activeNodeId;
      if (!nodeId) continue;
      fetchJSON(`/${nodeId}/traceroute`, 'POST', { to: num, hop_limit: 0 })
        .catch(e => console.warn('[perf] auto-traceroute failed', num, e));
    }
  },

  perfAutoStart() {
    this.perfAutoStop();
    if (!this.perfAutoNodes?.length) return;
    const ms = (this.perfAutoIntervalMin ?? 5) * 60 * 1000;
    // Results arrive via WS route_discovered events — no polling needed
    this._perfAutoTimer = setInterval(() => this._perfAutoTick(), ms);
    persistSet('perfAutoNodes', JSON.stringify(this.perfAutoNodes));
    persistSet('perfAutoIntervalMin', String(this.perfAutoIntervalMin));
  },

  perfAutoStop() {
    if (this._perfAutoTimer) { clearInterval(this._perfAutoTimer); this._perfAutoTimer = null; }
  },

  perfAutoToggleNode(num) {
    const idx = (this.perfAutoNodes ?? []).indexOf(num);
    if (idx === -1) this.perfAutoNodes = [...(this.perfAutoNodes ?? []), num];
    else            this.perfAutoNodes = this.perfAutoNodes.filter(n => n !== num);
  },

  loadPerfHistory() { /* no-op — traceroute_history arrives via WS on connect */ },

  // Distance (km) from home to a lat/lon pair using Haversine
  _haversineKm(lat, lon) {
    if (lat == null || lon == null || !this.homePos?.lat || !this.homePos?.lon) return null;
    const R    = 6371;
    const dLat = (lat - this.homePos.lat) * Math.PI / 180;
    const dLon = (lon - this.homePos.lon) * Math.PI / 180;
    const a    = Math.sin(dLat/2)**2 + Math.cos(this.homePos.lat*Math.PI/180) * Math.cos(lat*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  // Distance (km) from home to a node by num
  perfDistKm(num) {
    // 1. Use pre-computed _km from live node list
    const node = this.nodes.find(n => n.num === num);
    if (node?._km != null) return node._km;
    // 2. Compute from node position (latitude_i is in 1e-7 degrees)
    const lat = node?.position?.latitude_i  != null ? node.position.latitude_i  / 1e7 : null;
    const lon = node?.position?.longitude_i != null ? node.position.longitude_i / 1e7 : null;
    return this._haversineKm(lat, lon);
  },

  _perfNodePoint(row, num) {
    if (num == null) return null;
    if (num === row.to_num && row.to_lat != null && row.to_lon != null) {
      return { lat: row.to_lat, lon: row.to_lon };
    }
    const relay = row.relay_positions?.[num] ?? row.relay_positions?.[String(num)];
    if (relay?.latitude_i != null && relay?.longitude_i != null) {
      return { lat: relay.latitude_i / 1e7, lon: relay.longitude_i / 1e7 };
    }
    const node = this.nodes.find(n => n.num === num);
    if (node?.position?.latitude_i != null && node?.position?.longitude_i != null) {
      return { lat: node.position.latitude_i / 1e7, lon: node.position.longitude_i / 1e7 };
    }
    if (node?.lat != null && node?.lon != null) return { lat: node.lat, lon: node.lon };
    return null;
  },

  _perfDistFromHomeToPoint(point) {
    return point ? this._haversineKm(point.lat, point.lon) : null;
  },

  // Enrich a history row with calculated fields
  perfEnrich(row) {
    const route = Array.isArray(row.route) ? row.route.filter(n => n != null && n !== 0xffffffff) : [];
    const routeHops = route.length;
    const direct = routeHops === 0;
    const targetPoint = this._perfNodePoint(row, row.to_num);
    const targetDistKm = this._perfDistFromHomeToPoint(targetPoint);
    const firstHopNum = direct ? row.to_num : route[0];
    const firstHopPoint = direct ? targetPoint : this._perfNodePoint(row, firstHopNum);
    const firstHopDistKm = this._perfDistFromHomeToPoint(firstHopPoint);
    const metricDistKm = direct ? targetDistKm : firstHopDistKm;
    // snr_towards / snr_back are stored in units of 0.25 dB (Meshtastic proto)
    const snrTx   = this._perfSnr(row.snr_towards?.[0]);
    const snrRx   = direct
      ? this._perfSnr(row.snr_back?.[0])
      : this._perfSnr(row.snr_back?.[row.snr_back.length - 1]);
    const gapTx = this.perfSnrGap(snrTx, metricDistKm);
    const marginTx = this.perfMargin(snrTx);
    const validTx = snrTx != null && metricDistKm != null && metricDistKm > 0.1;
    const confidence = !validTx ? 'low' : direct ? 'high' : 'medium';
    const routeKind = direct ? 'direct' : 'first-hop';
    return {
      ...row,
      route,
      routeHops,
      direct,
      routeKind,
      confidence,
      validTx,
      distKm: metricDistKm,
      metricDistKm,
      targetDistKm,
      firstHopNum,
      firstHopDistKm,
      firstHopName: firstHopNum === row.to_num
        ? (row.to_short_name || (this.nodeLabel ? this.nodeLabel(row.to_num) : row.to_num))
        : (this.nodeLabel ? this.nodeLabel(firstHopNum) : firstHopNum),
      distLabel: direct ? 'target' : 'first hop',
      snrTx,
      snrRx,
      gapTx,
      marginTx,
    };
  },

  perfValidRows(kind = 'all') {
    return this.perfHistory
      .map(r => this.perfEnrich(r))
      .filter(r => r.validTx && (
        kind === 'all' ||
        (kind === 'direct' && r.direct) ||
        (kind === 'first-hop' && !r.direct)
      ));
  },

  perfSummary(kind = 'all') {
    const rows = this.perfValidRows(kind);
    const gaps = rows.map(r => r.gapTx);
    const snrs = rows.map(r => r.snrTx);
    const margins = rows.map(r => r.marginTx);
    return {
      n: rows.length,
      direct: rows.filter(r => r.direct).length,
      relayed: rows.filter(r => !r.direct).length,
      medianGap: this._perfMedian(gaps),
      medianSnr: this._perfMedian(snrs),
      medianMargin: this._perfMedian(margins),
    };
  },

  // Aggregate setup health: median direct headroom. Falls back to first-hop if no direct rows exist.
  perfScore() {
    const direct = this.perfSummary('direct');
    if (direct.medianMargin != null) return direct.medianMargin;
    return this.perfSummary('first-hop').medianMargin;
  },

  perfScoreKind() {
    return this.perfSummary('direct').medianMargin != null ? 'direct RF' : 'first hop';
  },

  perfSetExpert(v) {
    this.perfExpert = !!v;
    persistSet('perfExpert', this.perfExpert ? 'true' : 'false');
    this.destroyPerfCharts();
    this.$nextTick?.(() => this.initPerfCharts());
  },

  perfHealth(margin) {
    if (margin == null) return { label: 'No data', desc: 'Need valid traceroute samples', cls: 'text-base-content/40', badge: 'badge-ghost' };
    if (margin >= 20) return { label: 'Excellent', desc: 'Plenty of signal headroom', cls: 'text-success', badge: 'badge-success' };
    if (margin >= 10) return { label: 'Good', desc: 'Comfortable margin', cls: 'text-success', badge: 'badge-success' };
    if (margin >= 3)  return { label: 'Usable', desc: 'Works, but not much spare margin', cls: 'text-warning', badge: 'badge-warning' };
    if (margin >= 0)  return { label: 'Fragile', desc: 'Close to the decode limit', cls: 'text-warning', badge: 'badge-warning' };
    return { label: 'Failing', desc: 'Below the reliable decode limit', cls: 'text-error', badge: 'badge-error' };
  },

  perfHealthLabel(margin) {
    return this.perfHealth(margin).label;
  },

  perfHealthDesc(margin) {
    return this.perfHealth(margin).desc;
  },

  perfHealthClass(margin) {
    return this.perfHealth(margin).cls;
  },

  perfHealthBadge(margin) {
    return this.perfHealth(margin).badge;
  },

  perfHealthBars(margin, scale = 1.6) {
    const health = this.perfHealth(margin);
    const bars = margin == null ? 0
      : margin >= 20 ? 4
      : margin >= 10 ? 3
      : margin >= 3  ? 2
      : margin >= 0  ? 1
      : 0;
    const cls = margin == null ? 'text-base-content/30'
      : margin >= 10 ? 'text-success'
      : margin >= 0  ? 'text-warning'
      : 'text-error';
    const html = [3, 6, 9, 12].map((h, i) =>
      `<i style="height:${Math.round(h * scale)}px;opacity:${bars > i ? 1 : 0.16}"></i>`
    ).join('');
    return `<span class="sig-bars perf-health-bars ${cls}" title="${health.label} · ${this.perfSignedDb(margin)} headroom">${html}</span>`;
  },

  perfSignedDb(v, digits = 1, compact = false) {
    if (v == null || !Number.isFinite(v)) return '–';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(digits)}${compact ? '' : ' '}dB`;
  },

  perfConfidence(kind = 'all') {
    const n = this.perfSummary(kind).n;
    if (n >= 40) return 'high';
    if (n >= 12) return 'medium';
    if (n > 0) return 'low';
    return 'none';
  },

  perfTrendChange() {
    const buckets = this.perfTrendBuckets().filter(b => b.margin != null);
    if (buckets.length < 2) return null;
    const first = buckets[0].margin;
    const last = buckets[buckets.length - 1].margin;
    return last - first;
  },

  perfTrendChangeLabel() {
    const delta = this.perfTrendChange();
    if (delta == null) return 'No baseline yet';
    const sign = delta > 0 ? '+' : '';
    if (Math.abs(delta) < 1) return `${sign}${delta.toFixed(1)} dB · little change`;
    return `${sign}${delta.toFixed(1)} dB · ${delta > 0 ? 'better' : 'worse'}`;
  },

  perfTrendDirection() {
    const delta = this.perfTrendChange();
    if (delta == null) return 'baseline';
    if (Math.abs(delta) < 1) return 'flat';
    return delta > 0 ? 'better' : 'worse';
  },

  perfTrendDirectionBadge() {
    const d = this.perfTrendDirection();
    if (d === 'better') return 'badge-success';
    if (d === 'worse') return 'badge-error';
    if (d === 'flat') return 'badge-warning';
    return 'badge-ghost';
  },

  perfHistoryTime(ts) {
    if (!ts) return '–';
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const startRow = new Date(d);
    startRow.setHours(0, 0, 0, 0);
    const dayDiff = Math.floor((startToday - startRow) / 86400000);
    return `${hh}:${mm}${dayDiff > 0 ? ' -' + dayDiff : ''}`;
  },

  // ── uPlot chart helpers ───────────────────────────────────────────────────

  _perfChartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'business';
    return {
      text:    dark ? '#e5e7eb' : '#1f2937',
      grid:    dark ? 'rgba(229,231,235,0.18)' : 'rgba(31,41,55,0.16)',
      bg:      dark ? '#111827' : '#ffffff',
      primary: dark ? '#22d3ee' : '#0891b2',
      success: dark ? '#4ade80' : '#16a34a',
      info:    dark ? '#60a5fa' : '#2563eb',
      warning: dark ? '#fbbf24' : '#d97706',
      error:   dark ? '#f87171' : '#dc2626',
    };
  },

  _perfChartSize(el) {
    const r = el?.getBoundingClientRect?.();
    return {
      width:  Math.max(360, Math.floor(r?.width  || 360)),
      height: Math.max(260, Math.floor(r?.height || 260)),
    };
  },

  _perfBaseUplotOptions(el, time = false) {
    const c = this._perfChartTheme();
    const { width, height } = this._perfChartSize(el);
    return {
      width, height,
      cursor: { drag: { x: true, y: true }, focus: { prox: 24 } },
      legend: { show: false },
      scales: {
        x: { time },
        y: {
          auto: true,
          range: (u, min, max) => [
            Math.min(Number.isFinite(min) ? min : 0, 0) - 2,
            Math.max(Number.isFinite(max) ? max : 10, 10) + 2,
          ],
        },
      },
      axes: [
        {
          stroke: c.text,
          grid: { stroke: c.grid, width: 1 },
          ticks: { stroke: c.grid, width: 1 },
          size: 30,
          gap: 4,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
          values: time ? (u, vals) => vals.map(v => this._perfTimeTick(v)) : null,
        },
        {
          stroke: c.text,
          grid: { stroke: c.grid, width: 1 },
          ticks: { stroke: c.grid, width: 1 },
          size: 42,
          gap: 4,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
        },
      ],
    };
  },

  _perfDrawSeries(u, yIdx, color, width = 3, dash = [], points = false) {
    const xs = u.data?.[0] || [];
    const ys = u.data?.[yIdx] || [];
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.setLineDash(dash.map(v => v * dpr));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let open = false;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const yv = ys[i];
      if (!Number.isFinite(yv)) {
        if (open) {
          ctx.stroke();
          ctx.beginPath();
          open = false;
        }
        continue;
      }
      const x = u.valToPos(xs[i], 'x', true);
      const y = u.valToPos(yv, 'y', true);
      if (!open) {
        ctx.moveTo(x, y);
        open = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (open) ctx.stroke();
    ctx.setLineDash([]);

    if (points) {
      for (let i = 0; i < xs.length; i++) {
        const yv = ys[i];
        if (!Number.isFinite(yv)) continue;
        const x = u.valToPos(xs[i], 'x', true);
        const y = u.valToPos(yv, 'y', true);
        ctx.beginPath();
        ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  },

  _perfDrawHeadroomBands(u) {
    const ctx = u.ctx;
    if (!u.bbox) return;
    const left = u.bbox.left;
    const width = u.bbox.width;
    const yMin = u.scales.y.min;
    const yMax = u.scales.y.max;
    const band = (from, to, color) => {
      const lo = Math.max(from, yMin);
      const hi = Math.min(to, yMax);
      if (hi <= yMin || lo >= yMax || hi <= lo) return;
      const y1 = u.valToPos(hi, 'y', true);
      const y2 = u.valToPos(lo, 'y', true);
      ctx.fillStyle = color;
      ctx.fillRect(left, y1, width, y2 - y1);
    };
    ctx.save();
    band(yMin, 0, 'rgba(248,113,113,0.16)');
    band(0, 3, 'rgba(251,191,36,0.16)');
    band(3, 10, 'rgba(250,204,21,0.10)');
    band(10, yMax, 'rgba(74,222,128,0.08)');
    ctx.restore();
  },

  _perfDrawTrend(u) {
    const c = this._perfChartTheme();
    this._perfDrawHeadroomBands(u);
    this._perfDrawSeries(u, 1, c.success, 3, [], true);
    this._perfDrawSeries(u, 2, c.info, 3, [8, 5], true);
  },

  _perfDrawScatter(u) {
    const c = this._perfChartTheme();
    this._perfDrawHeadroomBands(u);
    if (this.perfExpert) {
      this._perfDrawSeries(u, 1, c.primary, 3);
      this._perfDrawSeries(u, 2, c.warning, 2, [8, 5]);
    }
    this._perfDrawSeries(u, 3, c.error, 2, [4, 6]);
    this._perfDrawSeries(u, 4, c.success, 0, [], true);
    this._perfDrawSeries(u, 5, c.info, 0, [], true);
  },

  _perfTimeTick(ts) {
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if ((this.perfTrendWindowHours ?? 24) > 24) {
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
    }
    return `${hh}:${mm}`;
  },

  perfTrendSetWindow(hours) {
    this.perfTrendWindowHours = hours;
    persistSet('perfTrendWindowHours', String(hours));
  },

  perfTrendRows() {
    const rows = this.perfValidRows('all');
    if (!rows.length) return [];
    const maxTs = Math.max(...rows.map(r => r.ts));
    const cutoff = maxTs - ((this.perfTrendWindowHours ?? 24) * 3600);
    return rows.filter(r => r.ts >= cutoff);
  },

  _perfTrendBucketSecs() {
    const hours = this.perfTrendWindowHours ?? 24;
    if (hours <= 4) return 15 * 60;
    if (hours <= 8) return 30 * 60;
    if (hours <= 24) return 60 * 60;
    return 3 * 60 * 60;
  },

  perfTrendBuckets() {
    const bucketSecs = this._perfTrendBucketSecs();
    const buckets = new Map();
    for (const r of this.perfTrendRows()) {
      if (!r.ts) continue;
      const bucket = Math.floor(r.ts / bucketSecs) * bucketSecs;
      const cur = buckets.get(bucket) || { ts: bucket, direct: [], firstHop: [], all: [] };
      (r.direct ? cur.direct : cur.firstHop).push(r.marginTx);
      cur.all.push(r.marginTx);
      buckets.set(bucket, cur);
    }
    return [...buckets.values()].sort((a, b) => a.ts - b.ts).map(b => ({
      ts: b.ts,
      margin: this._perfMedian(b.all),
      directMargin: this._perfMedian(b.direct),
      firstHopMargin: this._perfMedian(b.firstHop),
      directN: b.direct.length,
      firstHopN: b.firstHop.length,
    }));
  },

  perfTrendUplotData() {
    const buckets = this.perfTrendBuckets();
    return [
      buckets.map(b => b.ts),
      buckets.map(b => b.directMargin),
      buckets.map(b => b.firstHopMargin),
    ];
  },

  perfScatterUplotData() {
    const rows = this.perfValidRows('all');
    const maxKm = rows.length ? Math.max(...rows.map(r => r.metricDistKm), 5) * 1.1 : 50;
    const entries = [];
    for (let i = 0; i <= 96; i++) {
      const km = Math.max(0.1, (i / 96) * maxKm);
      entries.push({ x: km });
    }
    rows.forEach((r, idx) => {
      // Tiny deterministic offset avoids duplicate x collapse while remaining visually invisible.
      entries.push({
        x: r.metricDistKm + (idx * 1e-6),
        direct: r.direct ? r.marginTx : null,
        firstHop: r.direct ? null : r.marginTx,
      });
    });
    entries.sort((a, b) => a.x - b.x);
    return [
      entries.map(e => e.x),
      entries.map(e => this.perfTheoChipSnr(e.x) - this.perfSfSnrLimitDb()),
      entries.map(e => this.perfTheoChipSnr(e.x) - 10 * Math.log10(e.x) - this.perfSfSnrLimitDb()),
      entries.map(() => 0),
      entries.map(e => e.direct   ?? null),
      entries.map(e => e.firstHop ?? null),
    ];
  },

  _perfTrendOptions(el) {
    const c = this._perfChartTheme();
    return {
      ...this._perfBaseUplotOptions(el, true),
      hooks: { draw: [u => this._perfDrawTrend(u)] },
      series: [
        {},
        { label: 'Direct RF', stroke: c.success, width: 4, spanGaps: true, points: { show: true, size: 7, width: 2, stroke: c.success, fill: c.bg } },
        { label: 'First hop', stroke: c.info, width: 4, spanGaps: true, points: { show: true, size: 7, width: 2, stroke: c.info, fill: c.bg } },
      ],
    };
  },

  _perfScatterOptions(el) {
    const c = this._perfChartTheme();
    return {
      ...this._perfBaseUplotOptions(el, false),
      hooks: { draw: [u => this._perfDrawScatter(u)] },
      series: [
        {},
        { label: 'Ideal free-space', show: this.perfExpert, stroke: c.primary, width: 4, points: { show: false } },
        { label: 'Typical rural', show: this.perfExpert, stroke: c.warning, width: 3, dash: [8, 5], points: { show: false } },
        { label: 'SF limit', stroke: c.error, width: 3, dash: [4, 6], points: { show: false } },
        { label: 'Direct RF', stroke: c.success, width: 0, points: { show: true, size: 8, width: 2, stroke: c.success, fill: c.success } },
        { label: 'First hop', stroke: c.info, width: 0, points: { show: true, size: 8, width: 2, stroke: c.info, fill: c.info } },
      ],
    };
  },

  initPerfCharts() {
    if (this.tab !== 'perf') return;
    const trendEl = this.$refs?.perfTrendChart;
    const scatterEl = this.$refs?.perfScatterChart;
    if (!trendEl || !scatterEl) return;
    if (!window.uPlot) {
      const msg = '<div class="perf-chart-error">uPlot failed to load</div>';
      trendEl.innerHTML = msg;
      scatterEl.innerHTML = msg;
      console.warn('[perf] uPlot is not loaded');
      return;
    }

    if (!this._perfCharts.trend) {
      trendEl.innerHTML = '';
      this._perfCharts.trend = new window.uPlot(this._perfTrendOptions(trendEl), this.perfTrendUplotData(), trendEl);
    }
    if (!this._perfCharts.scatter) {
      scatterEl.innerHTML = '';
      this._perfCharts.scatter = new window.uPlot(this._perfScatterOptions(scatterEl), this.perfScatterUplotData(), scatterEl);
    }

    if (!this._perfResizeObserver) {
      this._perfResizeObserver = new ResizeObserver(() => this.updatePerfCharts());
      this._perfResizeObserver.observe(trendEl);
      this._perfResizeObserver.observe(scatterEl);
    }
    this.updatePerfCharts();
  },

  updatePerfCharts() {
    if (this.tab !== 'perf') return;
    if (!this._perfCharts?.trend || !this._perfCharts?.scatter) {
      this.initPerfCharts();
      return;
    }
    const trendEl = this.$refs?.perfTrendChart;
    const scatterEl = this.$refs?.perfScatterChart;
    if (!trendEl || !scatterEl) return;

    this._perfCharts.trend.setSize(this._perfChartSize(trendEl));
    this._perfCharts.trend.setData(this.perfTrendUplotData());
    this._perfCharts.scatter.setSize(this._perfChartSize(scatterEl));
    this._perfCharts.scatter.setData(this.perfScatterUplotData());
  },

  destroyPerfCharts() {
    this._perfCharts?.trend?.destroy();
    this._perfCharts?.scatter?.destroy();
    this._perfCharts = {};
    this._perfResizeObserver?.disconnect();
    this._perfResizeObserver = null;
  },
};
