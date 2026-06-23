// Telemetry mixin: tilt sensor display and environmental history charts.
import { fetchJSON } from './app-helpers.js';

function _saveTiltCal(body) {
  fetch('/tilt_cal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

export const telemetryMixin = {
  async loadTiltHistory() {
    if (!this.activeNodeId) return;
    try {
      const rows = await fetchJSON(`/tilt_history?node_id=${encodeURIComponent(this.activeNodeId)}&hours=${this.tiltWindow}`);
      this.tiltHistory = Array.isArray(rows) ? rows : [];
      this._tiltRecomputePeak();
    } catch (_) {}
  },

  async loadEnvHistory(nodeId) {
    if (!nodeId?.startsWith('!')) return;
    const num = parseInt(nodeId.slice(1), 16);
    try {
      const rows = await fetchJSON(`/env_history?num=${num}&hours=${this.envWindow}`);
      const updated = { ...this.envHistory };
      updated[nodeId] = Array.isArray(rows) ? rows : [];
      this.envHistory = updated;
    } catch (_) {}
  },

  async loadEnvHistoryAll() {
    for (const dev of this.availableDevices) {
      if (dev.node_id) await this.loadEnvHistory(dev.node_id);
    }
  },

  // -- Tilt helpers -------------------------------------------------------------

  tiltMaxDeg() { return this.tiltRings[this.tiltRings.length - 1] || 1; },

  tiltApplyZero(pitch, roll) {
    if (!this.tiltZero) return { pitch, roll };
    return { pitch: pitch - this.tiltZero.pitch, roll: roll - this.tiltZero.roll };
  },

  tiltSetZero() {
    const p = this.nodeSelf?.tilt?.pitch ?? 0;
    const r = this.nodeSelf?.tilt?.roll  ?? 0;
    this.tiltZero = { pitch: p, roll: r };
    _saveTiltCal({ zero: this.tiltZero });
    this._tiltRecomputePeak();
  },

  tiltClearZero() {
    this.tiltZero = null;
    this.tiltNorthAngle = null;
    _saveTiltCal({ zero: null, north_angle: null });
    this._tiltRecomputePeak();
  },

  async tiltSetNorth() {
    if (!this.tiltZero) return;
    const p  = this.nodeSelf?.tilt?.pitch ?? 0;
    const r  = this.nodeSelf?.tilt?.roll  ?? 0;
    const dp = p - this.tiltZero.pitch;
    const dr = r - this.tiltZero.roll;
    const t  = Math.sqrt(dp * dp + dr * dr);
    if (t < 0.05) return;
    this.tiltNorthAngle = Math.atan2(dr, dp);
    _saveTiltCal({ north_angle: this.tiltNorthAngle });
    const now = Math.floor(Date.now() / 1000);
    try {
      await fetch('/tilt_history/ncal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: this.activeNodeId, ts: now, window_sec: 120 }),
      });
    } catch (_) {}
    await this.loadTiltHistory();
  },

  tiltClearCal() {
    this.tiltZero = null;
    this.tiltNorthAngle = null;
    _saveTiltCal({ zero: null, north_angle: null });
    this._tiltRecomputePeak();
  },

  tiltClearNorth() {
    this.tiltNorthAngle = null;
    _saveTiltCal({ north_angle: null });
  },

  _tiltRecomputePeak() {
    let max = 0;
    for (const r of this.tiltHistory) {
      const { pitch, roll } = this.tiltApplyZero(r.pitch, r.roll);
      const t = Math.sqrt(pitch * pitch + roll * roll);
      if (t > max) max = t;
    }
    this.tiltPeak = max;
  },

  tiltLogPx(deg, maxPx = 130) {
    if (deg <= 0) return 0;
    const max = this.tiltMaxDeg();
    return maxPx * Math.log(1 + Math.min(Math.abs(deg), max)) / Math.log(1 + max);
  },

  tiltToSvg(pitch, roll, cx = 150, cy = 150, maxPx = 130) {
    const z = this.tiltApplyZero(pitch, roll);
    const t = Math.sqrt(z.pitch * z.pitch + z.roll * z.roll);
    if (t < 0.01) return { x: cx, y: cy };
    const r = Math.min(this.tiltLogPx(t, maxPx), maxPx);
    let svgX = z.roll, svgY = -z.pitch;
    if (this.tiltNorthAngle != null) {
      const a = this.tiltNorthAngle;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rx =  svgX * ca + svgY * sa;
      const ry = -svgX * sa + svgY * ca;
      svgX = rx; svgY = ry;
    }
    return { x: cx + r * svgX / t, y: cy + r * svgY / t };
  },

  tiltPolylinePoints(cx = 150, cy = 150, maxPx = 130) {
    const h = this.tiltHistory;
    if (h.length < 2) return '';
    const step = Math.max(1, Math.floor(h.length / 400));
    return h.filter((_, i) => i % step === 0).map(p => {
      const { x, y } = this.tiltToSvg(p.pitch, p.roll, cx, cy, maxPx);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  },

  tiltRecentDots(cx = 150, cy = 150, maxPx = 130) {
    const h = this.tiltHistory;
    if (!h.length) return [];
    const recent = h.slice(-40);
    return recent.map((p, i) => {
      const { x, y } = this.tiltToSvg(p.pitch, p.roll, cx, cy, maxPx);
      return { x, y, opacity: (i + 1) / recent.length };
    });
  },

  tiltRingsSvg(cx = 150, cy = 150, maxPx = 130) {
    return this.tiltRings.map((deg, i) => {
      const r = this.tiltLogPx(deg, maxPx);
      const last = i === this.tiltRings.length - 1;
      const stroke = i === 0 ? 'rgba(0,255,80,0.65)' : last ? 'rgba(0,255,80,0.55)' : 'rgba(0,255,80,0.42)';
      const sw = (i === 0 || last) ? 1.5 : 1;
      return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    }).join('');
  },

  tiltDotsSvg(fill = 'rgba(0,255,80,1)', opacityScale = 0.55, cx = 150, cy = 150, maxPx = 130) {
    return this.tiltRecentDots(cx, cy, maxPx).map(d =>
      `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="2" fill="${fill}" fill-opacity="${(d.opacity * opacityScale).toFixed(2)}"/>`
    ).join('');
  },

  tiltTicksMinorPath(maxPx = 130) {
    const cx = 150, cy = 150;
    return Array.from({ length: 12 }, (_, i) => {
      if (i % 3 === 0) return '';
      const a = i * 30 * Math.PI / 180;
      const sx = Math.sin(a), cs = Math.cos(a);
      return `M${(cx+maxPx*0.91*sx).toFixed(1)} ${(cy-maxPx*0.91*cs).toFixed(1)}L${(cx+maxPx*sx).toFixed(1)} ${(cy-maxPx*cs).toFixed(1)}`;
    }).join(' ');
  },

  tiltTicksMajorPath(maxPx = 130) {
    const cx = 150, cy = 150;
    return Array.from({ length: 4 }, (_, i) => {
      const a = i * 90 * Math.PI / 180;
      const sx = Math.sin(a), cs = Math.cos(a);
      return `M${(cx+maxPx*0.80*sx).toFixed(1)} ${(cy-maxPx*0.80*cs).toFixed(1)}L${(cx+maxPx*sx).toFixed(1)} ${(cy-maxPx*cs).toFixed(1)}`;
    }).join(' ');
  },

  tiltDotColor(_pitch, _roll) {
    return 'rgba(0,255,80,0.95)';
  },

  // -- Environment history chart helpers ----------------------------------------

  _envScales(rows) {
    let tMin = Infinity, tMax = -Infinity, rhMin = Infinity, rhMax = -Infinity, tsMin = Infinity, tsMax = -Infinity;
    for (const r of rows) {
      const dp = this.dewPoint(r.temperature, r.relative_humidity);
      for (const v of [r.temperature, dp].filter(v => v != null)) {
        if (v < tMin) tMin = v;
        if (v > tMax) tMax = v;
      }
      if (r.relative_humidity != null) {
        if (r.relative_humidity < rhMin) rhMin = r.relative_humidity;
        if (r.relative_humidity > rhMax) rhMax = r.relative_humidity;
      }
      if (r.ts < tsMin) tsMin = r.ts;
      if (r.ts > tsMax) tsMax = r.ts;
    }
    const pad   = Math.max(0.5, (tMax - tMin) * 0.08);
    const rhPad = Math.max(1,   (rhMax - rhMin) * 0.1);
    return {
      tMin: tMin - pad, tMax: tMax + pad,
      rhMin: Math.max(0,   rhMin - rhPad),
      rhMax: Math.min(100, rhMax + rhPad),
      tsMin, tsMax,
    };
  },

  _envX(ts, sc, ox = 36, W = 348) {
    return sc.tsMax === sc.tsMin ? ox + W / 2
      : ox + W * (ts - sc.tsMin) / (sc.tsMax - sc.tsMin);
  },
  _envY(val, sc, oy = 18, H = 200) {
    return oy + H * (1 - (val - sc.tMin) / (sc.tMax - sc.tMin));
  },
  _envYh(rh, sc, oy = 18, H = 200) {
    const lo = sc?.rhMin ?? 0, hi = sc?.rhMax ?? 100;
    return oy + H * (1 - (rh - lo) / (hi - lo));
  },

  envTempPoints(nodeId) {
    const rows = (this.envHistory[nodeId] ?? []).filter(r => r.temperature != null);
    if (rows.length < 2) return '';
    const sc = this._envScales(rows);
    return rows.map(r => `${this._envX(r.ts, sc).toFixed(1)},${this._envY(r.temperature, sc).toFixed(1)}`).join(' ');
  },

  envDpPoints(nodeId) {
    const rows = (this.envHistory[nodeId] ?? []).filter(r => r.temperature != null && r.relative_humidity != null);
    if (rows.length < 2) return '';
    const sc = this._envScales(this.envHistory[nodeId] ?? []);
    return rows.map(r => {
      const dp = this.dewPoint(r.temperature, r.relative_humidity);
      return `${this._envX(r.ts, sc).toFixed(1)},${this._envY(dp, sc).toFixed(1)}`;
    }).join(' ');
  },

  envHumPoints(nodeId) {
    const rows = (this.envHistory[nodeId] ?? []).filter(r => r.relative_humidity != null);
    if (rows.length < 2) return '';
    const sc = this._envScales(this.envHistory[nodeId] ?? []);
    return rows.map(r => `${this._envX(r.ts, sc).toFixed(1)},${this._envYh(r.relative_humidity, sc).toFixed(1)}`).join(' ');
  },

  envChartYLabels(nodeId) {
    const rows = this.envHistory[nodeId] ?? [];
    if (!rows.length) return '';
    const sc = this._envScales(rows);
    return [0, 1, 2, 3, 4].map(i => {
      const val = sc.tMin + (sc.tMax - sc.tMin) * i / 4;
      const y   = (18 + 200 * (1 - i / 4) + 3).toFixed(0);
      return `<text x="33" y="${y}" text-anchor="end" font-size="8" fill="rgba(0,255,80,0.70)" font-family="monospace">${val.toFixed(0)}</text>`;
    }).join('');
  },

  envChartRhLabels(nodeId) {
    const rows = this.envHistory[nodeId] ?? [];
    const sc = rows.length ? this._envScales(rows) : { rhMin: 0, rhMax: 100 };
    return [0, 1, 2, 3, 4].map(i => {
      const rh = sc.rhMin + (sc.rhMax - sc.rhMin) * i / 4;
      const y  = (18 + 200 * (1 - i / 4) + 3).toFixed(0);
      return `<text x="387" y="${y}" text-anchor="start" font-size="8" fill="rgba(80,160,255,0.70)" font-family="monospace">${rh.toFixed(0)}%</text>`;
    }).join('');
  },

  envChartXLabels(nodeId) {
    const rows = this.envHistory[nodeId] ?? [];
    if (rows.length < 2) return '';
    const tsMin = rows[0].ts, tsMax = rows[rows.length - 1].ts;
    return [0, 1, 2, 3, 4].map(i => {
      const ts = tsMin + (tsMax - tsMin) * i / 4;
      const x  = (36 + 348 * i / 4).toFixed(0);
      const d  = new Date(ts * 1000);
      const s  = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
      const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
      return `<text x="${x}" y="238" text-anchor="${anchor}" font-size="8" fill="rgba(0,255,80,0.70)" font-family="monospace">${s}</text>`;
    }).join('');
  },

  dewPoint(tempC, rh) {
    if (tempC == null || rh == null || rh <= 0) return null;
    const a = 17.27, b = 237.7;
    const alpha = (a * tempC) / (b + tempC) + Math.log(rh / 100);
    return (b * alpha) / (a - alpha);
  },
};
