// Radar SVG rendering mixin.
// Mode rules:
//   PASV (0): nodes, route overlays (aged fade), animated dots on active trace, green crosshairs on traced node
//   ACTV (1): nodes, route overlay for targeted node (animated dots), red crosshairs, target arm
//   SCAN (2): nodes only, NO route overlays, target arm shows scan position
import { fetchJSON, svgElem, ageColor, themeColor, geocodeNode, haversine, bearing } from './app-helpers.js';
import { FF } from './feature-flags.js';

export const radarMixin = {
  get targetNode() {
    if (!this.yagiPointTarget) return null;
    return this.nodes.find(n => n.num === this.yagiPointTarget) || null;
  },

  get passiveNode() {
    if (!this.passiveTraceNum) return null;
    return this.nodes.find(n => n.num === this.passiveTraceNum) || null;
  },

  async initRadar() {
    if (this._initRadarRunning) return;
    this._initRadarRunning = true;
    try {
      if (!this.homePos) return;
      this.refreshRadar();
      this.geocodeNodes();
      if (this.yagiAz != null) this._animateBeam(this.yagiAz);
    } finally {
      this._initRadarRunning = false;
    }
  },

  refreshRadar() {
    this.radarNodes = this.nodes;
    this.drawRadar();
  },

  drawRadar() {
    if (!this.homePos) return;
    const NICE_KM = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000, 2000];
    const maxKm = this.radarRange === '0'
      ? (() => {
          const dataMax = this.radarNodes.length ? Math.max(...this.radarNodes.map(n => n._km ?? 0)) : 0;
          return NICE_KM.find(n => n >= dataMax) ?? dataMax * 1.15;
        })()
      : Number(this.radarRange);
    // ── [V2] SSOT_ROUTE_RENDER — build ctx from backend state, pass to draw fns
    const ctx = FF.SSOT_ROUTE_RENDER ? this._buildRadarCtx() : null;
    // ─────────────────────────────────────────────────────────────────────────
    this._drawRadarBg(maxKm);
    this._drawTargetArm(ctx);
    this._drawRadarBeam();
    this._drawRadarTraceroute(maxKm, ctx);
    this._drawRadarNodes(maxKm, ctx);
  },

  _buildRadarCtx() {
    const rc = this.radarCtx ?? {};
    return {
      mode:             rc.mode             ?? this.rotatorMode,
      tracerouteNode:   rc.traceroute_node   ?? null,
      tracerouteActive: rc.traceroute_active ?? false,
      targetArmAz:      (rc.mode ?? this.rotatorMode) !== 0
                          ? (this.rotatorStatus?.target ?? null)
                          : null,
      activeCard:       rc.active_card      ?? null,
    };
  },

  _drawTargetArm(ctx) {
    const ag = document.getElementById('radar-scan-arm-g');
    if (!ag) return;
    ag.innerHTML = '';
    // ── [V1] LEGACY — remove when SSOT_ROUTE_RENDER verified ─────────────────
    if (!ctx) {
      if (this.rotatorMode === 0) return;
      const target = this.rotatorStatus?.target;
      if (target == null) return;
    // ── [V2] SSOT — backend sends target_arm_az, null means no arm ───────────
    } else {
      if (ctx.targetArmAz == null) return;
    }
    // ─────────────────────────────────────────────────────────────────────────
    const target = ctx ? ctx.targetArmAz : this.rotatorStatus?.target;
    const CX = 300, CY = 300, MAX_R = 230;
    const rad = (target - 90) * Math.PI / 180;
    const line = svgElem('line', {
      x1: CX, y1: CY,
      x2: (CX + MAX_R * 1.05 * Math.cos(rad)).toFixed(1),
      y2: (CY + MAX_R * 1.05 * Math.sin(rad)).toFixed(1),
      style: 'stroke:rgba(255,160,0,0.75);stroke-width:1.5;stroke-dasharray:6,4',
    });
    ag.appendChild(line);
  },

  _drawRadarTraceroute(maxKm, ctx) {
    const tg = document.getElementById('radar-traceroute-g');
    if (!tg) return;
    tg.innerHTML = '';
    const home = this.homePos;
    if (!home) return;

    const CX = 300, CY = 300, R = 256;

    const numToXY = (num, trRelayPos) => {
      if (num == null) return { x: CX, y: CY };
      const node = this.nodes.find(n => n.num === num);
      const pos  = node?.position ?? trRelayPos?.[String(num)];
      if (!pos?.latitude_i) return null;
      const lat = pos.latitude_i / 1e7, lon = pos.longitude_i / 1e7;
      const km = haversine(home.lat, home.lon, lat, lon);
      const az = bearing(home.lat, home.lon, lat, lon);
      const norm = this._radarNorm(km, maxKm);
      const rad = az * Math.PI / 180;
      return { x: CX + Math.sin(rad) * norm * R, y: CY - Math.cos(rad) * norm * R };
    };

    const nodeColor = (num) => `hsl(${((num * 137.508) % 360).toFixed(0)},80%,65%)`;

    for (const node of this.nodes) {
      const tr = node.last_traceroute;

      // ── [V1] LEGACY — remove when SSOT_ROUTE_RENDER verified ─────────────
      let isHighlighted, isLocked, isAnimated;
      if (!ctx) {
        if (this.rotatorMode === 2) return; // SCAN: no overlays
        const isTargeted = this.rotatorMode === 1 && node.num === this.yagiPointTarget;
        if (this.rotatorMode === 1 && !isTargeted) continue; // ACTV: targeted only
        const isPassive  = this.rotatorMode === 0 && node.num === this.passiveTraceNum;
        if (!tr && !isPassive) continue;
        isHighlighted = isTargeted || isPassive;
        isLocked      = isTargeted;
        isAnimated    = isHighlighted;
      // ── [V2] SSOT — static route always drawn; animate only while in flight
      } else {
        if (!tr) continue;
        isHighlighted = node.num === ctx.tracerouteNode; // opacity/stroke boost when focused
        isLocked      = isHighlighted;
        isAnimated    = isHighlighted && ctx.tracerouteActive;
      }
      // ───────────────────────────────────────────────────────────────────────

      const ageSec = tr?.ts ? (Date.now() - tr.ts) / 1000 : 0;
      const fade = isHighlighted ? 0.90
        : (ageSec < 3600 ? 0.30 : Math.max(0.10, 0.30 - (ageSec - 3600) / (23 * 3600) * 0.20));

      const col = nodeColor(node.num);

      const rg = svgElem('g', { style: `opacity:${fade.toFixed(2)};cursor:crosshair` });
      if (!isLocked) {
        rg.addEventListener('mouseenter', () => { rg.style.opacity = 1; });
        rg.addEventListener('mouseleave', () => { rg.style.opacity = fade; });
      }

      const chain  = [null, ...(tr?.route ?? []), node.num];
      const snrs   = tr?.snr_towards ?? [];
      const points = chain.map(n => numToXY(n, tr?.relay_positions));
      const known  = chain.map((_, i) => points[i] ? i : -1).filter(i => i >= 0);
      const sw     = isHighlighted ? 2.5 : 2;

      for (let k = 0; k < known.length - 1; k++) {
        const ai = known[k], bi = known[k + 1];
        const p1 = points[ai], p2 = points[bi];
        const adjacent = (bi === ai + 1);
        rg.appendChild(svgElem('line', {
          x1: p1.x.toFixed(1), y1: p1.y.toFixed(1),
          x2: p2.x.toFixed(1), y2: p2.y.toFixed(1),
          style: `stroke:${col};stroke-width:${sw};stroke-linecap:round;stroke-dasharray:${adjacent ? '0,4' : '0,7'}`,
        }));
        if (adjacent) {
          const snrRaw = snrs[ai] ?? null;
          if (snrRaw != null) {
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const lbl = svgElem('text', {
              x: mx.toFixed(1), y: (my - 4).toFixed(1),
              style: `fill:${col};font-size:8px;font-family:'Oxanium',monospace;text-anchor:middle`,
            });
            lbl.textContent = `${snrRaw / 4 >= 0 ? '+' : ''}${(snrRaw / 4).toFixed(1)}`;
            rg.appendChild(lbl);
          }
        }
      }

      for (let i = 1; i < chain.length - 1; i++) {
        const p = points[i];
        if (!p) continue;
        rg.appendChild(svgElem('circle', {
          cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3,
          style: `fill:${col};stroke:${col};stroke-width:1`,
        }));
      }

      if (isAnimated) {
        const knownPts = known.map(i => points[i]);
        if (knownPts.length >= 2) {
          const pathD = 'M ' + knownPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ');
          const N = 3, dur = 1.8;
          const phase0 = (Date.now() / 1000) % dur;
          for (let d = 0; d < N; d++) {
            const phase = (phase0 + d * dur / N) % dur;
            const dot = svgElem('circle', { r: '2.5', cx: '0', cy: '0', style: `fill:${col}` });
            const anim = svgElem('animateMotion', {
              path: pathD, dur: `${dur}s`,
              begin: `-${phase.toFixed(3)}s`,
              repeatCount: 'indefinite', calcMode: 'linear',
            });
            dot.appendChild(anim);
            rg.appendChild(dot);
          }
        }
      }

      tg.appendChild(rg);
    }
  },

  _radarNorm(km, maxKm) {
    if (!km || !maxKm) return 0;
    const f = this.radarLogScale
      ? Math.pow(km / maxKm, 0.4)
      : km / maxKm;
    return Math.min(f, 1.0);
  },

  _drawRadarBg(maxKm) {
    const bg = document.getElementById('radar-bg-g');
    if (!bg) return;
    const CX = 300, CY = 300, R = 256;
    const G0 = 'rgba(0,255,80,0.06)', G1 = 'rgba(0,255,80,0.22)', G2 = 'rgba(0,255,80,0.40)';
    const G3 = 'rgba(0,255,80,0.45)', G4 = 'rgba(0,255,80,0.95)';
    bg.innerHTML = '';
    bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R, style: 'fill:url(#radarBg)' }));
    const scanG = svgElem('g', { 'clip-path': 'url(#radarClip)', style: 'pointer-events:none' });
    for (let yy = CY - R; yy < CY + R; yy += 4)
      scanG.appendChild(svgElem('line', { x1: CX - R, y1: yy, x2: CX + R, y2: yy, style: 'stroke:rgba(0,0,0,0.10);stroke-width:1' }));
    bg.appendChild(scanG);
    const NICE_RING = [0.5, 1, 2, 5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000, 2000];
    const ringKms = this.radarLogScale
      ? (() => {
          return [0.25, 0.5, 0.75, 1.0].map(f => {
            const rawKm = maxKm * Math.pow(f, 2.5);
            return NICE_RING.find(n => n >= rawKm * 0.7) ?? Math.round(rawKm);
          }).filter((k, i, a) => k > 0 && k <= maxKm && a.indexOf(k) === i);
        })()
      : this.radarRange === '0'
        ? (() => {
            const inner = NICE_RING.filter(k => k < maxKm).slice(-3);
            return [...inner, maxKm];
          })()
        : [1, 2, 3, 4].map(i => maxKm * i / 4);
    ringKms.forEach((km, idx) => {
      const r = this._radarNorm(km, maxKm) * R;
      bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r, style: `fill:none;stroke:${G1};stroke-width:0.9;stroke-dasharray:5 5` }));
      const lbl = svgElem('text', { x: CX + 5, y: CY - r + 12, style: `fill:${G3};font-size:10px;font-family:'Oxanium',monospace;letter-spacing:0.05em` });
      lbl.textContent = (km < 10 ? km.toFixed(km % 1 ? 1 : 0) : km) + ' km';
      bg.appendChild(lbl);
    });
    if (this.radarCrosshair) {
      bg.appendChild(svgElem('line', { x1: CX, y1: CY - R, x2: CX, y2: CY + R, style: `stroke:${G1};stroke-width:0.7;stroke-dasharray:2 8` }));
      bg.appendChild(svgElem('line', { x1: CX - R, y1: CY, x2: CX + R, y2: CY, style: `stroke:${G1};stroke-width:0.7;stroke-dasharray:2 8` }));
      const d45 = R * 0.707;
      bg.appendChild(svgElem('line', { x1: CX - d45, y1: CY - d45, x2: CX + d45, y2: CY + d45, style: `stroke:${G0};stroke-width:0.6;stroke-dasharray:2 10` }));
      bg.appendChild(svgElem('line', { x1: CX + d45, y1: CY - d45, x2: CX - d45, y2: CY + d45, style: `stroke:${G0};stroke-width:0.6;stroke-dasharray:2 10` }));
    }
    for (let deg = 0; deg < 360; deg += 10) {
      const isMajor = deg % 30 === 0, tickLen = isMajor ? 11 : 5;
      const rad = deg * Math.PI / 180;
      const ox = CX + Math.sin(rad) * R, oy = CY - Math.cos(rad) * R;
      const ix = CX + Math.sin(rad) * (R - tickLen), iy = CY - Math.cos(rad) * (R - tickLen);
      bg.appendChild(svgElem('line', { x1: ox, y1: oy, x2: ix, y2: iy, style: `stroke:rgba(0,255,80,${isMajor ? 0.70 : 0.38});stroke-width:${isMajor ? 1.2 : 0.8}` }));
    }
    bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R, style: `fill:none;stroke:${G2};stroke-width:1.5;filter:url(#rimGlow)` }));
    bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R + 6, style: 'fill:none;stroke:rgba(0,255,80,0.10);stroke-width:3' }));
    bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R + 10, style: 'fill:none;stroke:rgba(0,255,80,0.04);stroke-width:2' }));
    for (const [label, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      const t = svgElem('text', { x: CX + dx * (R + 22), y: CY + dy * (R + 22) + 5, style: `fill:${G4};font-size:13px;font-weight:700;font-family:'Oxanium',monospace;text-anchor:middle;letter-spacing:0.1em` });
      t.textContent = label;
      bg.appendChild(t);
    }
  },

  _drawRadarBeam() {
    const beamG = document.getElementById('radar-beam-g');
    if (!beamG || this.yagiAz == null) return;
    const CX = 300, CY = 300, R = 256;
    const rotId = this.rotatorDeviceId();
    const bw = Math.max(1, Math.min(rotId ? (this.deviceConfigs[rotId]?.beam_deg ?? 5) : 5, 180));
    const HW = (bw / 2) * Math.PI / 180;
    const wx1 = CX + Math.sin(-HW) * R, wy1 = CY - Math.cos(-HW) * R;
    const wx2 = CX + Math.sin(HW) * R,  wy2 = CY - Math.cos(HW) * R;
    const az = Math.round(this._radarBeamAz ?? this.yagiAz);
    beamG.innerHTML = `<path d="M ${CX} ${CY} L ${wx1.toFixed(1)} ${wy1.toFixed(1)} A ${R} ${R} 0 0 1 ${wx2.toFixed(1)} ${wy2.toFixed(1)} Z" style="fill:rgba(80,200,255,0.14);stroke:none;clip-path:url(#radarClip)"/><line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - R}" style="stroke:rgba(80,200,255,0.85);stroke-width:1;opacity:0.9"/><text x="${CX}" y="${CY - R - 15}" style="fill:rgba(255,50,50,0.95);font-size:11px;font-weight:700;font-family:'Oxanium',monospace;text-anchor:middle;dominant-baseline:middle;pointer-events:none">${az}°</text>`;
  },

  _drawRadarNodes(maxKm, ctx) {
    const ng = document.getElementById('radar-nodes-g');
    if (!ng) return;
    ng.innerHTML = '';
    const nodes = this.radarNodes;
    const CX = 300, CY = 300, R = 256;
    const G4 = 'rgba(0,255,80,0.95)', AMBER = 'rgba(255,200,40,0.90)', LABEL = 'rgba(255,140,0,0.55)';
    const CLUSTER_R = 22, BASE_DIAG = 12, STEP_DIAG = 14, HOR_LEN = 16;
    const selectedNum   = this.radarSelected?.num;
    const lastHeardNum  = this.lastHeardNum;
    // ── [V1] LEGACY ──────────────────────────────────────────────────────────
    const pointTarget   = !ctx ? this.yagiPointTarget  : null;
    const isActv        = !ctx ? this.rotatorMode === 1 : false;
    // ── [V2] SSOT ────────────────────────────────────────────────────────────
    const ctxTraceNode  = ctx?.tracerouteNode ?? null;
    const ctxCardMode   = ctx?.activeCard?.mode ?? null; // 'actv' | 'pasv' | null
    // ─────────────────────────────────────────────────────────────────────────

    const npos = nodes.map(node => {
      if (node._az == null) return null;
      const az = node._az * Math.PI / 180;
      const normKm = node._km != null ? this._radarNorm(node._km, maxKm) : 0.92;
      return { x: CX + Math.sin(az) * normKm * R, y: CY - Math.cos(az) * normKm * R, diagLen: BASE_DIAG, isRight: null };
    });
    const clusterOf = new Array(npos.length).fill(-1);
    for (let i = 0; i < npos.length; i++) {
      if (!npos[i] || clusterOf[i] >= 0) continue;
      const members = [i]; clusterOf[i] = i;
      for (let j = i + 1; j < npos.length; j++) {
        if (!npos[j] || clusterOf[j] >= 0) continue;
        const dx = npos[i].x - npos[j].x, dy = npos[i].y - npos[j].y;
        if (dx * dx + dy * dy < CLUSTER_R * CLUSTER_R) { members.push(j); clusterOf[j] = i; }
      }
      if (members.length > 1) members.forEach((idx, rank) => { npos[idx].diagLen = BASE_DIAG + rank * STEP_DIAG; npos[idx].isRight = rank % 2 === 0; });
    }

    nodes.forEach((node, ni) => {
      if (!npos[ni]) return;
      const { x, y, diagLen } = npos[ni];
      const isRight = npos[ni].isRight !== null ? npos[ni].isRight : x >= CX;
      const devColor = this.deviceConfigs[node._device]?.color;
      const dotColor = devColor ? (themeColor(devColor) ?? ageColor(node.last_heard, this.heatmapMaxAge)) : ageColor(node.last_heard, this.heatmapMaxAge);
      const devices = node._devices || (node._device ? [node._device] : []);
      const otherDev = devices.find(d => d !== node._device);
      const ringColor = otherDev && devices.length >= 2
        ? (this.deviceConfigs[otherDev]?.color ? themeColor(this.deviceConfigs[otherDev].color) : null)
        : null;
      const isSelected   = node.num === selectedNum;
      const isLastHeard  = node.num === lastHeardNum;
      const g = svgElem('g', { class: 'radar-node' + (isSelected ? ' radar-node-selected' : ''), style: 'cursor:pointer' });

      if (isLastHeard) {
        const rs = `stroke:${AMBER};stroke-width:1.2`;
        g.appendChild(svgElem('circle', { cx: x, cy: y, r: 13, style: `fill:none;${rs};stroke-dasharray:3 4` }));
        g.appendChild(svgElem('line', { x1: x-17, y1: y, x2: x-7,  y2: y, style: rs }));
        g.appendChild(svgElem('line', { x1: x+7,  y1: y, x2: x+17, y2: y, style: rs }));
        g.appendChild(svgElem('line', { x1: x, y1: y-17, x2: x, y2: y-7,  style: rs }));
        g.appendChild(svgElem('line', { x1: x, y1: y+7,  x2: x, y2: y+17, style: rs }));
      }

      // ── [V1] LEGACY — Crosshairs: ACTV red + signal overlay; PASV green ────
      if (!ctx) {
        if (node.num === pointTarget && isActv) {
          this.appendCrosshair(g, x, y);
          if (this.yagiSignal.num === node.num && this.signalAge() != null && this.signalAge() < 30) {
            this.appendPulseRing(g, x, y);
          }
          if (this.yagiSignal.num === node.num && (this.yagiSignal.rssi != null || this.yagiSignal.snr != null)) {
            const sig = this.yagiSignal;
            const age = this.signalAge();
            const stale = age != null && age >= 30;
            const col = stale ? 'rgba(120,100,60,0.7)' : 'rgba(255,140,0,0.95)';
            const parts = [];
            if (sig.rssi != null) parts.push(`${sig.rssi} dBm`);
            if (sig.snr  != null) parts.push(`${sig.snr >= 0 ? '+' : ''}${sig.snr.toFixed(1)} dB`);
            if (age != null) parts.push(`${age}s`);
            const sigTxt = svgElem('text', { x, y: y + 32, style: `fill:${col};font-size:9px;font-weight:600;font-family:'Oxanium',monospace;text-anchor:middle;pointer-events:none;filter:url(#rimGlow)` });
            sigTxt.textContent = parts.join(' · ');
            g.appendChild(sigTxt);
          }
        } else if (node.num === this.passiveTraceNum && this.rotatorMode === 0) {
          this.appendCrosshair(g, x, y, 'rgba(0,255,80,0.80)');
        }
      // ── [V2] SSOT — colour from ctx.activeCard.mode, node from ctx.tracerouteNode
      } else if (node.num === ctxTraceNode) {
        const xhColor = ctxCardMode === 'actv' ? undefined : 'rgba(0,255,80,0.80)';
        this.appendCrosshair(g, x, y, xhColor);
        if (ctxCardMode === 'actv') {
          if (this.yagiSignal.num === node.num && this.signalAge() != null && this.signalAge() < 30) {
            this.appendPulseRing(g, x, y);
          }
          if (this.yagiSignal.num === node.num && (this.yagiSignal.rssi != null || this.yagiSignal.snr != null)) {
            const sig = this.yagiSignal;
            const age = this.signalAge();
            const stale = age != null && age >= 30;
            const col = stale ? 'rgba(120,100,60,0.7)' : 'rgba(255,140,0,0.95)';
            const parts = [];
            if (sig.rssi != null) parts.push(`${sig.rssi} dBm`);
            if (sig.snr  != null) parts.push(`${sig.snr >= 0 ? '+' : ''}${sig.snr.toFixed(1)} dB`);
            if (age != null) parts.push(`${age}s`);
            const sigTxt = svgElem('text', { x, y: y + 32, style: `fill:${col};font-size:9px;font-weight:600;font-family:'Oxanium',monospace;text-anchor:middle;pointer-events:none;filter:url(#rimGlow)` });
            sigTxt.textContent = parts.join(' · ');
            g.appendChild(sigTxt);
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      if (isSelected)
        g.appendChild(svgElem('circle', { cx: x, cy: y, r: 8, style: `fill:none;stroke:${G4};stroke-width:1.5;stroke-dasharray:4 3` }));
      const r = isSelected ? 3 : 2;
      if (ringColor)
        g.appendChild(svgElem('circle', { cx: x, cy: y, r: r + 2, style: `fill:${ringColor};opacity:0.85` }));
      g.appendChild(svgElem('circle', { cx: x, cy: y, r, style: `fill:${dotColor};filter:url(#blipGlow)` }));
      const title = svgElem('title');
      title.textContent = node.user?.long_name || node.display_name || '';
      g.appendChild(title);
      const label = node.display_name || node.user?.short_name || '';
      const diagSign = isRight ? 1 : -1;
      const elbowX = x + diagSign * diagLen, elbowY = y - diagLen;
      const capX   = elbowX + diagSign * HOR_LEN;
      g.appendChild(svgElem('line', { x1: x + diagSign * 3, y1: y - 2, x2: elbowX, y2: elbowY, style: `stroke:${LABEL};stroke-width:1;pointer-events:none;filter:url(#rimGlow)` }));
      g.appendChild(svgElem('line', { x1: elbowX, y1: elbowY + 0.5, x2: capX, y2: elbowY + 0.5, style: `stroke:${LABEL};stroke-width:1.5;pointer-events:none` }));
      const txt = svgElem('text', { class: 'radar-node-label', x: capX + diagSign * 3, y: elbowY + 4, style: `fill:${LABEL};font-size:10px;font-weight:400;font-family:'Oxanium',monospace;pointer-events:none;text-anchor:${isRight ? 'start' : 'end'};filter:url(#rimGlow)` });
      txt.textContent = label;
      g.appendChild(txt);
      g.addEventListener('click', (e) => { e.stopPropagation(); this.radarSelected = node; this.openNodeInfo(node); });
      ng.appendChild(g);
    });

    const hSize = 7;
    ng.appendChild(svgElem('polygon', { points: `${CX},${CY-hSize} ${CX+hSize},${CY} ${CX},${CY+hSize} ${CX-hSize},${CY}`, style: `fill:${G4};filter:url(#blipGlow)` }));
    ng.appendChild(svgElem('line', { x1: CX-16, y1: CY, x2: CX-hSize-1, y2: CY, style: `stroke:${G4};stroke-width:1.2` }));
    ng.appendChild(svgElem('line', { x1: CX+hSize+1, y1: CY, x2: CX+16, y2: CY, style: `stroke:${G4};stroke-width:1.2` }));
    ng.appendChild(svgElem('line', { x1: CX, y1: CY-16, x2: CX, y2: CY-hSize-1, style: `stroke:${G4};stroke-width:1.2` }));
    ng.appendChild(svgElem('line', { x1: CX, y1: CY+hSize+1, x2: CX, y2: CY+16, style: `stroke:${G4};stroke-width:1.2` }));
  },

  radarNodeList() {
    const nodes = this.radarNodes.filter(n => n._az != null);
    return this.scanMode
      ? [...nodes].sort((a, b) => (b._scanSnr ?? -999) - (a._scanSnr ?? -999))
      : [...nodes].sort((a, b) => (a._az ?? 0) - (b._az ?? 0));
  },

  scanNodeList() {
    return [...this.nodes].sort((a, b) => (b._scanSnr ?? -999) - (a._scanSnr ?? -999));
  },

  openNodeInfo(node) {
    const radarNode = this.radarNodes.find(r => r.num === node.num);
    const lat = node.position?.latitude_i  != null ? node.position.latitude_i  / 1e7 : null;
    const lon = node.position?.longitude_i != null ? node.position.longitude_i / 1e7 : null;
    this.nodeInfo = { ...(radarNode ?? node), _lat: lat, _lon: lon };
    this.tracerouteResult = null;
    this.$nextTick(() => this.$refs.nodeInfoDialog?.showModal());
    if (!this.nodeInfo._address && node.num) {
      geocodeNode(node.num).then(addr => {
        if (addr && this.nodeInfo?.num === node.num)
          this.nodeInfo = { ...this.nodeInfo, _address: addr };
      });
    }
  },

  async sendTraceroute(node) {
    if (!node?.num) return;
    this.tracerouteResult  = null;
    this.traceroutePending = true;
    const nodeId = '!' + (node.num >>> 0).toString(16).padStart(8, '0');
    fetchJSON(`/${nodeId}/traceroute`, 'POST', {}).catch(() => { this.traceroutePending = false; });
  },

  tracerouteNodeName(num) {
    return this.nodeLabel(num);
  },

  toggleRadarCrosshair() {
    this.radarCrosshair = !this.radarCrosshair;
    this.saveRadarPref('crosshair', this.radarCrosshair);
    this.drawRadar();
  },

  async geocodeNodes() {
    this.geocoding = true;
    for (const node of [...this.radarNodes]) {
      if (node._address || !node.num) continue;
      if (!node.position?.latitude_i && !node._km) continue;
      const addr = await geocodeNode(node.num);
      if (!addr) continue;
      const idx = this.radarNodes.findIndex(r => r.num === node.num);
      if (idx >= 0) this.radarNodes[idx] = { ...this.radarNodes[idx], _address: addr };
      if (this.radarSelected?.num === node.num)
        this.radarSelected = { ...this.radarSelected, _address: addr };
    }
    this.geocoding = false;
  },

  saveRadarPref(key, value) {
    const cfgKeyMap = {
      max_range_km: 'radar.max_range_km',
      log_scale:    'radar.log_scale',
      crosshair:    'radar.crosshair',
    };
    const cfgKey = cfgKeyMap[key];
    if (cfgKey) fetchJSON(`/config/${cfgKey}`, 'PUT', { value }).catch(e => console.warn('saveRadarPref', e));
  },

  updateHomePos() {
    // homePos is set by the server via node_list WS events
  },

  async pointAtNode(node) {
    if (node._az == null) return;
    await fetchJSON('/rotator/move', 'POST', { az: node._az });
    if (this.tab === 'radar') this.drawRadar();
  },

  async manualTarget(num) {
    if (this.rotatorMode !== 1) return;
    await fetchJSON('/rotator/target', 'POST', { num }).catch(() => {});
  },

  signalAge() {
    void this._sigTick;
    if (!this.yagiSignal.ts) return null;
    return Math.round((Date.now() - this.yagiSignal.ts) / 1000);
  },

  _pingSignal() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } catch (_) {}
  },
};
