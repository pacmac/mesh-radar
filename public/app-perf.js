// Performance mixin: link budget calculator, traceroute history, RF analytics.
// Chart instances live outside Alpine's reactive scope to prevent proxy recursion.
const _charts = {};

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
  perfFailureEpoch: null,   // unix s when failure recording began (config perf.failure_epoch)
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
    const cfg   = this.deviceConfigs?.[this.perfDev()] ?? {};
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
    const dev = this.perfDev();
    if (this.loraCfg?.tx_power != null || !dev) return;
    try {
      const r = await fetchJSON(`/${dev}/config/lora`);
      if (r?.lora) this.loraCfg = r.lora;
    } catch (e) {
      console.warn('[perf] loadPerfLoraCfg failed', e);
    }
  },

  // ── Auto-traceroute scheduler ─────────────────────────────────────────────
  perfAutoIntervalMin: 5,

  _perfAutoTick() {
    if (!this.perfAutoNodes?.length) return;
    const via = this.perfDev();
    for (const num of this.perfAutoNodes) {
      // Target in the URL (the API's contract); dispatch via the page's
      // selected radio so ITS RF chain is what gets measured.
      const target = '!' + (num >>> 0).toString(16).padStart(8, '0');
      fetchJSON(`/${target}/traceroute`, 'POST', via ? { via } : {})
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

  // Effective perf device: explicit selection, else the primary radio.
  perfDev() {
    const sel = this.perfDevice;
    if (sel && this.availableDevices.some(d => d.node_id === sel)) return sel;
    return this.primaryDeviceId || this.availableDevices[0]?.node_id || '';
  },

  async perfSetDevice(nodeId) {
    this.perfDevice = nodeId;
    persistSet('perfDevice', nodeId);
    this.loraCfg = {};              // force per-device reload of theory constants
    this.perfHistory = [];
    await Promise.all([this.loadPerfLoraCfg(), this.loadPerfHistory()]);
    this.$nextTick(() => this.initPerfCharts());
  },

  // Device-scoped history from REST (per-device contract; the global WS
  // replay is ignored — docs/modules/app-perf.md).
  async loadPerfHistory() {
    const dev = this.perfDev();
    if (!dev) return;
    try {
      const rows = await fetchJSON(`/traceroute_history?device=${encodeURIComponent(dev)}&limit=200`);
      if (Array.isArray(rows)) this.perfHistory = rows;
      if (this.perfFailureEpoch == null) {
        const cfg = await fetchJSON('/config');
        this.perfFailureEpoch = cfg?.['perf.failure_epoch'] ?? null;
      }
    } catch (e) {
      console.warn('[perf] loadPerfHistory failed', e);
    }
  },

  // Success rate over post-epoch attempts only. Pre-epoch rows predate
  // failure recording — counting them would fake a 100% rate.
  perfSuccessRate() {
    if (this.perfFailureEpoch == null) return null;
    const rows = this.perfHistory.filter(r => r.ts >= this.perfFailureEpoch);
    if (!rows.length) return null;
    const ok = rows.filter(r => !r.status || r.status === 'ok').length;
    return { n: rows.length, ok, rate: Math.round((ok / rows.length) * 100) };
  },

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
    // Failure rows (status != 'ok') carry no payload — they render as
    // em-dashes and validTx:false keeps them out of medians/charts.
    if (row.status && row.status !== 'ok') {
      return {
        ...row,
        failed: true, route: [], routeHops: 0, direct: false,
        routeKind: 'failed', confidence: 'low', validTx: false,
        distKm: null, metricDistKm: null, targetDistKm: null,
        firstHopNum: null, firstHopDistKm: null, firstHopName: null,
        distLabel: '', snrTx: null, snrRx: null, gapTx: null, marginTx: null,
      };
    }
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
    this.updatePerfCharts();
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

  perfTrendSetWindow(hours) {
    this.perfTrendWindowHours = hours;
    persistSet('perfTrendWindowHours', String(hours));
    this.updatePerfCharts();
  },

  perfTrendRows() {
    const rows = this.perfValidRows('all');
    if (!rows.length) return [];
    const maxTs = Math.max(...rows.map(r => r.ts));
    const cutoff = maxTs - ((this.perfTrendWindowHours ?? 72) * 3600);
    return rows.filter(r => r.ts >= cutoff);
  },

  _perfTrendBucketSecs() {
    const hours = this.perfTrendWindowHours ?? 72;
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

  // ── Chart.js charts ───────────────────────────────────────────────────────

  _perfTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'business';
    return {
      text:    dark ? '#e5e7eb' : '#1f2937',
      grid:    dark ? 'rgba(229,231,235,0.18)' : 'rgba(31,41,55,0.16)',
      success: dark ? '#4ade80' : '#16a34a',
      info:    dark ? '#60a5fa' : '#2563eb',
      warning: dark ? '#fbbf24' : '#d97706',
      primary: dark ? '#22d3ee' : '#0891b2',
    };
  },

  _perfBandsPlugin() {
    return {
      id: 'perfBands',
      beforeDraw(chart) {
        const { ctx, chartArea, scales: { y } } = chart;
        if (!chartArea || !y) return;
        const { left, right } = chartArea;
        const yMin = y.min, yMax = y.max;
        const yp = v => y.getPixelForValue(Math.min(Math.max(v, yMin), yMax));
        ctx.save();
        for (const [lo, hi, col] of [
          [yMin, 0,    'rgba(248,113,113,0.22)'],
          [0,    3,    'rgba(251,191,36,0.22)'],
          [3,    10,   'rgba(250,204,21,0.14)'],
          [10,   yMax, 'rgba(74,222,128,0.12)'],
        ]) {
          if (lo >= yMax || hi <= yMin) continue;
          const yTop = yp(Math.min(hi, yMax));
          const yBot = yp(Math.max(lo, yMin));
          ctx.fillStyle = col;
          ctx.fillRect(left, yTop, right - left, yBot - yTop);
        }
        ctx.restore();
      },
    };
  },

  _perfChartAxes(c, time) {
    const font = { family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 11 };
    const x = {
      type: 'linear',
      ticks: {
        color: c.text,
        font,
        maxTicksLimit: 8,
        ...(time ? {
          callback(val, index, ticks) {
            if (!ticks.length) return '';
            const rangeMs = ticks[ticks.length - 1].value - ticks[0].value;
            const d = new Date(val);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            if (rangeMs > 24 * 3600 * 1000) {
              return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
            }
            return `${hh}:${mm}`;
          },
        } : {}),
      },
      grid:   { color: c.grid },
      border: { color: c.grid },
    };
    const y = {
      ticks:  { color: c.text, font },
      grid:   { color: c.grid },
      border: { color: c.grid },
    };
    return { x, y };
  },

  _perfTrendDatasets(c) {
    const buckets = this.perfTrendBuckets();
    return [
      {
        label: 'Direct RF',
        data: buckets.map(b => ({ x: b.ts * 1000, y: b.directMargin })),
        borderColor: c.success,
        backgroundColor: c.success,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        spanGaps: true,
      },
      {
        label: 'First Hop',
        data: buckets.map(b => ({ x: b.ts * 1000, y: b.firstHopMargin })),
        borderColor: c.info,
        backgroundColor: c.info,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        borderDash: [8, 5],
        spanGaps: true,
      },
    ];
  },

  _perfScatterRefDatasets(c) {
    if (!this.perfExpert) return [];
    const rows = this.perfValidRows('all');
    if (!rows.length) return [];
    const maxKm = Math.max(...rows.map(r => r.metricDistKm), 1);
    const pts   = 80;
    const ideal = [], rural = [];
    for (let i = 1; i <= pts; i++) {
      const km   = (i / pts) * maxKm * 1.1;
      const base = this.perfTheoChipSnr(km) - this.perfSfSnrLimitDb();
      ideal.push({ x: km, y: base });
      rural.push({ x: km, y: base - 10 * Math.log10(km) });
    }
    return [
      {
        label: 'Ideal (free space)',
        type: 'line',
        data: ideal,
        borderColor: c.primary,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        spanGaps: true,
      },
      {
        label: 'Rural (n=3)',
        type: 'line',
        data: rural,
        borderColor: c.warning,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [8, 5],
        pointRadius: 0,
        spanGaps: true,
      },
    ];
  },

  _perfScatterDatasets(c) {
    const rows     = this.perfValidRows('all');
    const direct   = rows.filter(r =>  r.direct).map(r => ({ x: r.metricDistKm, y: r.marginTx }));
    const firstHop = rows.filter(r => !r.direct).map(r => ({ x: r.metricDistKm, y: r.marginTx }));
    return [
      {
        label: 'Direct RF',
        data: direct,
        backgroundColor: c.success + 'bf',
        pointRadius: 5,
        pointHoverRadius: 7,
      },
      {
        label: 'First Hop',
        data: firstHop,
        backgroundColor: c.info + 'bf',
        pointRadius: 5,
        pointHoverRadius: 7,
      },
      ...this._perfScatterRefDatasets(c),
    ];
  },

  initPerfCharts() {
    if (this.tab !== 'perf') return;
    const trendEl   = this.$refs?.perfTrendChart;
    const scatterEl = this.$refs?.perfScatterChart;
    if (!trendEl || !scatterEl) return;
    if (!window.Chart) { console.warn('[perf] Chart.js not loaded'); return; }
    const c           = this._perfTheme();
    const bandsPlugin = this._perfBandsPlugin();
    if (!_charts.trend) {
      _charts.trend = new window.Chart(trendEl, {
        type: 'line',
        data: { datasets: this._perfTrendDatasets(c) },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: this._perfChartAxes(c, true),
        },
        plugins: [bandsPlugin],
      });
    }
    if (!_charts.scatter) {
      _charts.scatter = new window.Chart(scatterEl, {
        type: 'scatter',
        data: { datasets: this._perfScatterDatasets(c) },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: this._perfChartAxes(c, false),
        },
        plugins: [bandsPlugin],
      });
    }
  },

  updatePerfCharts() {
    if (this.tab !== 'perf') return;
    if (!_charts?.trend || !_charts?.scatter) { this.initPerfCharts(); return; }
    const c = this._perfTheme();
    _charts.trend.data.datasets = this._perfTrendDatasets(c);
    _charts.trend.update('none');
    _charts.scatter.data.datasets = this._perfScatterDatasets(c);
    _charts.scatter.update('none');
  },

  destroyPerfCharts() {
    _charts?.trend?.destroy();
    _charts?.scatter?.destroy();
    _charts = {};
  },

};
