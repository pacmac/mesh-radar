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
    this._perfAutoTimer = setInterval(() => {
      this._perfAutoTick();
      setTimeout(() => this.loadPerfHistory(), 8000);
    }, ms);
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

  async loadPerfHistory(toNum = null) {
    this.perfLoading = true;
    try {
      const qs = toNum ? `?to_num=${toNum}&limit=200` : '?limit=200';
      this.perfHistory = await fetchJSON('/traceroute_history' + qs);
    } catch (e) {
      console.warn('[perf] loadPerfHistory failed', e);
    } finally {
      this.perfLoading = false;
    }
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

  // Enrich a history row with calculated fields
  perfEnrich(row) {
    // Prefer position from DB join (to_lat/to_lon), fall back to live node list
    const distKm = (row.to_lat != null && row.to_lon != null)
      ? this._haversineKm(row.to_lat, row.to_lon)
      : this.perfDistKm(row.to_num);
    const direct  = (row.route?.length ?? 0) === 0;
    // snr_towards / snr_back are stored in units of 0.25 dB (Meshtastic proto)
    const snrTx   = row.snr_towards?.[0] != null ? row.snr_towards[0] / 4 : null;
    const snrRx   = direct
      ? (row.snr_back?.[0]  != null ? row.snr_back[0] / 4  : null)
      : (row.snr_back?.[row.snr_back.length - 1] != null ? row.snr_back[row.snr_back.length - 1] / 4 : null);
    const gapTx   = this.perfSnrGap(snrTx, distKm);
    return { ...row, distKm, direct, snrTx, snrRx, gapTx };
  },

  // Aggregate efficiency score: mean SNR gap across recent direct first-hops
  perfScore() {
    const rows = this.perfHistory
      .map(r => this.perfEnrich(r))
      .filter(r => r.snrTx != null && r.distKm != null && r.distKm > 0.1);
    if (!rows.length) return null;
    const gaps = rows.map(r => this.perfSnrGap(r.snrTx, r.distKm)).filter(g => g != null);
    if (!gaps.length) return null;
    return gaps.reduce((a, b) => a + b, 0) / gaps.length;
  },

  // ── SVG chart helpers ─────────────────────────────────────────────────────
  // Chart area: x:[48,546] y:[10,400]  (viewBox 560x430)
  _CHART: { x0: 48, x1: 546, y0: 10, y1: 400 },

  // Determine axis ranges from data + theory
  _perfChartRanges() {
    const { x0, x1, y0, y1 } = this._CHART;
    const enriched = this.perfHistory.map(r => this.perfEnrich(r)).filter(r => r.snrTx != null && r.distKm > 0);
    const maxKm = enriched.length ? Math.max(...enriched.map(r => r.distKm), 5) * 1.1 : 50;

    // Y axis: auto-scale to fit actual SNR, SF decode limit, and reference curve endpoints
    const sfLimit    = this.perfSfSnrLimitDb();
    const theoAtFar  = this.perfTheoChipSnr(maxKm);
    const n3AtFar    = theoAtFar - 10 * Math.log10(maxKm);  // n=3 model at max distance
    const actualSnrs = enriched.map(r => r.snrTx);

    const rawMin = Math.min(...(actualSnrs.length ? actualSnrs : [0]), sfLimit - 3, n3AtFar);
    const rawMax = Math.max(...(actualSnrs.length ? actualSnrs : [0]), theoAtFar, sfLimit + 5);

    // Snap to 5-dB grid with a little padding
    const snrMin = Math.floor((rawMin - 4) / 5) * 5;
    const snrMax = Math.ceil ((rawMax + 4) / 5) * 5;

    const xScale = (km)  => x0 + (km  / maxKm) * (x1 - x0);
    const yScale = (snr) => y1 - ((snr - snrMin) / (snrMax - snrMin)) * (y1 - y0);
    return { maxKm, snrMin, snrMax, xScale, yScale };
  },

  perfChartSnrToY(snr) {
    return this._perfChartRanges().yScale(snr);
  },

  perfChartYLabels() {
    const { snrMin, snrMax, yScale } = this._perfChartRanges();
    const { x0, x1, y0, y1 } = this._CHART;
    const midY = (y0 + y1) / 2;
    let s = '';
    for (let snr = Math.ceil(snrMin / 5) * 5; snr <= snrMax; snr += 5) {
      const y = yScale(snr);
      s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="rgba(0,255,80,0.07)" stroke-width="0.6" stroke-dasharray="3,3"/>`;
      s += `<text x="${x0 - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(0,255,80,0.45)" font-family="monospace">${snr}</text>`;
    }
    s += `<text x="10" y="${midY.toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(0,255,80,0.30)" font-family="monospace" transform="rotate(-90,10,${midY.toFixed(1)})">SNR (dB)</text>`;
    return s;
  },

  perfChartXLabels() {
    const { maxKm, xScale } = this._perfChartRanges();
    const { y0, y1 } = this._CHART;
    const steps = maxKm > 200 ? 5 : maxKm > 50 ? 6 : 5;
    let s = '';
    for (let i = 0; i <= steps; i++) {
      const km = (i / steps) * maxKm;
      const x  = xScale(km);
      s += `<line x1="${x.toFixed(1)}" y1="${y0}" x2="${x.toFixed(1)}" y2="${y1}" stroke="rgba(0,255,80,0.07)" stroke-width="0.6" stroke-dasharray="3,3"/>`;
      s += `<text x="${x.toFixed(1)}" y="${(y1 + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(0,255,80,0.45)" font-family="monospace">${km.toFixed(0)}</text>`;
    }
    s += `<text x="297" y="426" text-anchor="middle" font-size="9" fill="rgba(0,255,80,0.30)" font-family="monospace">Distance (km)</text>`;
    return s;
  },

  // Free-space theoretical chip SNR curve (n=2, best case)
  perfChartFreeCurve() {
    const { maxKm, xScale, yScale, snrMax } = this._perfChartRanges();
    const pts = [];
    for (let i = 1; i <= 80; i++) {
      const d   = (i / 80) * maxKm;
      const snr = Math.min(snrMax, this.perfTheoChipSnr(d));
      pts.push(`${xScale(d).toFixed(1)},${yScale(snr).toFixed(1)}`);
    }
    return pts.join(' ');
  },

  // Log-distance n=3 model curve: FSPL + 10·log10(d) extra loss vs free-space
  perfChartRealCurve() {
    const { maxKm, xScale, yScale, snrMax } = this._perfChartRanges();
    const pts = [];
    for (let i = 1; i <= 80; i++) {
      const d   = (i / 80) * maxKm;
      const snr = Math.min(snrMax, this.perfTheoChipSnr(d) - 10 * Math.log10(d));
      pts.push(`${xScale(d).toFixed(1)},${yScale(snr).toFixed(1)}`);
    }
    return pts.join(' ');
  },

  perfChartScatter() {
    const { xScale, yScale, snrMin, snrMax, maxKm } = this._perfChartRanges();
    const enriched = this.perfHistory.map(r => this.perfEnrich(r)).filter(r => r.snrTx != null && r.distKm > 0);
    let s = '';
    for (const r of enriched) {
      const x   = xScale(Math.min(r.distKm, maxKm));
      const snr = Math.max(snrMin, Math.min(snrMax, r.snrTx));
      const y   = yScale(snr);
      const gap = r.gapTx ?? 99;
      // gap = excess path loss above FSPL: <15 dB good, <35 dB ok, ≥35 dB heavy terrain
      const col = gap < 15 ? 'rgba(74,222,128,0.90)' : gap < 35 ? 'rgba(251,191,36,0.90)' : 'rgba(248,113,113,0.85)';
      const node = r.to_short_name || (this.nodeLabel ? this.nodeLabel(r.to_num) : r.to_num);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${col}"><title>${node} · ${r.distKm.toFixed(1)}km · SNR ${r.snrTx.toFixed(1)}dB · excess ${gap.toFixed(1)}dB</title></circle>`;
    }
    return s;
  },
};
