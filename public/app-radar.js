// Radar SVG rendering mixin.
// Mode rules:
//   PASV (0): nodes, route overlays (aged fade), animated dots on active trace, green crosshairs on traced node
//   ACTV (1): nodes, route overlay for targeted node (animated dots), red crosshairs, target arm
//   SCAN (2): nodes only, NO route overlays, target arm shows scan position
import {fetchJSON, svgElem, ageColor, themeColor,  haversine, bearing } from './app-helpers.js';
import { persistGet, persistSet } from './app-persist.js';

// ── Node marks: a shape per KIND, and distance-based emphasis ────────────────
//
// Peter, 2026-08-04: "the current dash is saturated with every node plotted the
// same with no indication of whether it is a target, a relay / router ... and in
// many cases I may only want to see a target node and see the cluster, router and
// doors only without the clutter."
//
// The KIND is decided in Domain 1 (`node_kind`, see src/node-kind.js). This file
// only chooses a glyph for it — a presentation mapping of a served token, exactly
// like the TONE map. It must never work the kind out for itself.
//
// ENDPOINT FADE. Peter, same conversation: "have a dimming / opacity that starts
// in the ctr barely visible and the further out they go they get more prominent,
// that will still show all nodes but will focus the eye on the distant nodes."
//
// Applied to ENDPOINTS ONLY. Doors and routers are infrastructure: a door 5 km
// away is the single most important mark on the display — 66% of everything we
// send leaves through T4 at 5.3 km — so fading it by distance would hide the
// thing the whole engine depends on. Distance is only a proxy for "interesting"
// among destinations.
const ENDPOINT_FADE = { near: 0.22, far: 1.0 };

/** Opacity for a node mark. `norm` is the already-computed 0..1 radial position,
 *  so the fade follows the SAME compressive scale as the rings rather than
 *  raw km — otherwise everything inside the dense inner band would vanish. */
function markOpacity(kind, norm) {
  if (kind !== 'endpoint') return 1;
  const t = Math.max(0, Math.min(1, Number(norm) || 0));
  return ENDPOINT_FADE.near + (ENDPOINT_FADE.far - ENDPOINT_FADE.near) * t;
}

/** The glyph for a kind, as SVG children appended to the node's group.
 *  Deliberately built from primitives: legible at 8 px, no external assets, and
 *  it inherits the node's existing colour so age/device colouring still reads. */
function kindGlyph(kind, x, y, r, colour, opacity) {
  const out = [];
  const st = (extra) => `stroke:${colour};fill:none;opacity:${opacity};${extra || ''}`;
  if (kind === 'door') {
    // A way THROUGH: a diamond, open at the sides. Reads as a gateway rather
    // than as another dot, and stays distinct at small sizes.
    // OUTLINE + CORE, not a filled shape with a background-coloured hole punched
    // in it. The first cut used `fill:var(--radar-bg, #000)` for the hole and
    // that variable does not exist — so on the light theme it would have drawn a
    // black dot on a pale background. Nothing here may assume the backdrop.
    const d = r + 2.5;
    out.push(svgElem('path', { d: `M${x} ${y - d} L${x + d} ${y} L${x} ${y + d} L${x - d} ${y} Z`,
                               style: `fill:none;stroke:${colour};stroke-width:1.6;opacity:${opacity};filter:url(#blipGlow)` }));
    out.push(svgElem('circle', { cx: x, cy: y, r: Math.max(1.2, r - 2),
                                 style: `fill:${colour};opacity:${opacity}` }));
  } else if (kind === 'router') {
    // Declared relay: a dish. Body plus two panels.
    out.push(svgElem('circle', { cx: x, cy: y, r: r - 0.5, style: `fill:${colour};opacity:${opacity}` }));
    out.push(svgElem('path', { d: `M${x - r - 3} ${y - r - 1} L${x - r + 1} ${y - r - 1}`, style: st('stroke-width:1.6') }));
    out.push(svgElem('path', { d: `M${x + r - 1} ${y + r + 1} L${x + r + 3} ${y + r + 1}`, style: st('stroke-width:1.6') }));
    out.push(svgElem('circle', { cx: x, cy: y, r: r + 3, style: st('stroke-width:0.8;stroke-dasharray:2 2') }));
  } else if (kind === 'own') {
    out.push(svgElem('rect', { x: x - r, y: y - r, width: r * 2, height: r * 2,
                               style: `fill:${colour};opacity:${opacity}` }));
  } else {
    // ENDPOINT — a crosshair, as asked for. A destination, not a way through.
    const g = r + 3;
    out.push(svgElem('circle', { cx: x, cy: y, r: r - 1.2, style: `fill:${colour};opacity:${opacity}` }));
    out.push(svgElem('path', { d: `M${x - g} ${y} L${x - r + 0.5} ${y} M${x + r - 0.5} ${y} L${x + g} ${y}`
                                + ` M${x} ${y - g} L${x} ${y - r + 0.5} M${x} ${y + r - 0.5} L${x} ${y + g}`,
                               style: st('stroke-width:1') }));
  }
  return out;
}
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
      // Fetched once on entry and redrawn from cache. Clusters change on the
      // order of hours (a node has to move, or a new anchor be seeded), so
      // re-fetching them on every radar redraw would be pure waste.
      this._loadClusters().then(() => this.drawRadar());
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
    // AUTO-RANGE IGNORES IMPLAUSIBLE POSITIONS.
    //
    // One node — MLBR — reports 1681 km, which drove auto-range to a 2000 km ring
    // and crushed every real node, the terrain and the reach shape into a smudge
    // at the centre. A single bad GPS fix should not decide what the whole
    // display shows.
    //
    // clusters.js has applied a 500 km ceiling since it was written (the same
    // 1681 km row is why); the radar never did. Same constant, same reasoning:
    // anything beyond it is bad data rather than a contact, and treating it as
    // real is how one row silently governs the view.
    //
    // Excluded nodes are still DRAWN — they are clamped to the rim by _radarNorm
    // like any over-range node. This only stops them setting the scale.
    const PLAUSIBLE_KM = 500;
    const maxKm = this.radarRange === '0'
      ? (() => {
          const kms = this.radarNodes.map(n => n._km ?? 0).filter(k => k <= PLAUSIBLE_KM);
          const dataMax = kms.length ? Math.max(...kms) : 0;
          return NICE_KM.find(n => n >= dataMax) ?? Math.max(dataMax * 1.15, 25);
        })()
      : Number(this.radarRange);
    // ── [V2] SSOT_ROUTE_RENDER — build ctx from backend state, pass to draw fns
    const ctx = FF.SSOT_ROUTE_RENDER ? this._buildRadarCtx() : null;
    // ─────────────────────────────────────────────────────────────────────────
    this._drawRadarBg(maxKm);
    this._drawTargetArm(ctx);
    this._drawRadarBeam();
    this._drawRadarTraceroute(maxKm, ctx);
    this._drawRadarTerrain(maxKm);
    this._drawRadarReach(maxKm);
    this._drawRadarClusters(maxKm);
    this._drawRadarNodes(maxKm, ctx);
    this._applyLayerOrder();
  },

  // ── Clusters ───────────────────────────────────────────────────────────────
  //
  // Peter, 2026-08-04: "I need to be able to see them visually on the dashboard
  // ... sort of clouds, or blobs etc showing the extent of them."
  //
  // EVERYTHING DRAWN HERE IS SERVED. The hull polygon, the name, the purity, the
  // verdict and its tone all come from GET /clusters (src/clusters.js). This
  // function projects lat/lon to screen and picks a colour from a served token.
  // It does not decide what a cluster is, where it ends, or whether it is solved.
  // ── Terrain relief ─────────────────────────────────────────────────────────
  //
  // Peter, 2026-08-05: "what I am looking at is the terrain, i.e the hills and
  // valleys that surround me ... I can already see by looking at the node
  // distribution that we have walls / dead zones".
  //
  // The grid is SERVED (src/terrain.js) as elev_m[bearing][ring]. This paints it.
  //
  // PAINTED TO A CANVAS, NOT DRAWN AS SVG. 180 bearings x 45 rings is 8100 cells;
  // as SVG paths that is 8100 DOM nodes rebuilt on every radar redraw. One image
  // costs one element and repaints only when the scale changes.
  //
  // IT MUST USE _radarNorm, THE SAME COMPRESSIVE SCALE AS THE RINGS. Painting
  // terrain linearly while the nodes sit on a quantile scale would put a ridge in
  // the wrong place relative to the nodes behind it — which is precisely the
  // comparison the layer exists to support.
  async _loadTerrain() {
    try {
      // The VISIBILITY MASK, not the relief. Peter, 2026-08-05: "invert it so
      // that I see an outline and anything outside that outline should be
      // shaded, maybe according to the severity."
      const d = await fetchJSON('/terrain/visibility');
      this.terrainData = d?.ready ? d : null;
    } catch { this.terrainData = null; }
  },

  _drawRadarTerrain(maxKm) {
    const img = document.getElementById('radar-terrain-img');
    const path = document.getElementById('radar-horizon-path');
    if (!img) return;
    if (!this.layerOn('terrain')) { img.setAttribute('href', ''); path?.setAttribute('d', ''); return; }
    const d = this.terrainData;
    if (d == null) {
      if (!this._terrainLoading) {
        this._terrainLoading = true;
        this._loadTerrain().finally(() => { this._terrainLoading = false; this.drawRadar(); });
      }
      return;
    }
    const key = `${maxKm}|${this.radarLogScale}|${d.observer_asl_m}`;
    if (this._terrainKey === key && img.getAttribute('href')) return;
    this._terrainKey = key;

    const S = 512, C = S / 2, R = S / 2;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const B = d.bearings_deg, RAD = d.radii_km, SH = d.shadow_deg, DEEP = d.deepest_deg;
    const step = B.length > 1 ? (B[1] - B[0]) : 2;
    const maxSev = Math.max(0.001, d.max_shadow_deg);

    // SHADE WHAT WE CANNOT SEE, leave what we can. The inverse of the first
    // attempt, which painted the ground itself and produced a starburst centred
    // on the observer — an artefact of polar sampling, not of the landscape.
    //
    // Severity is degrees below the skyline. Deeper shadow = darker, so the eye
    // reads "how badly blocked" rather than "how high".
    const shade = (sev) => {
      if (sev == null || sev <= 0) return null;                 // visible: draw nothing
      const t = Math.min(1, sev / maxSev);
      // Peter, 2026-08-05: "do not try and pay too much attention to fading down
      // layers ... the order that I select a layer should determine its
      // brightness". So this is drawn to be READ, not to politely coexist —
      // contention between layers is the focus-order feature's job, not a reason
      // to render everything at 10% alpha as the first two attempts did.
      return `rgba(6,12,18,${(0.42 + 0.48 * t).toFixed(3)})`;
    };

    const SUB = 3;
    for (let i = 0; i < B.length; i++) {
      const a0 = (B[i] - step / 2 - 90) * Math.PI / 180 - 0.006;
      const a1 = (B[i] + step / 2 - 90) * Math.PI / 180 + 0.006;
      let prev = 0;
      for (let k = 0; k < RAD.length; k++) {
        const rOut = this._radarNorm(RAD[k], maxKm) * R;
        const col = shade(SH[i]?.[k]);
        if (col && rOut > prev) {
          for (let q = 0; q < SUB; q++) {
            ctx.beginPath();
            ctx.arc(C, C, prev + (rOut - prev) * (q + 1) / SUB, a0, a1);
            ctx.arc(C, C, prev + (rOut - prev) * q / SUB, a1, a0, true);
            ctx.closePath(); ctx.fillStyle = col; ctx.fill();
          }
        }
        prev = rOut;
      }
      // BEYOND THE SAMPLED LIMIT we have no data. Once behind a ridge you stay
      // behind it, so carry the outermost measured shadow to the rim rather than
      // leaving a misleadingly clear edge at 60 km. Extrapolated, and it is the
      // honest choice between a false clear and a false blank.
      const col = shade(DEEP[i]);
      if (col && prev < R) {
        ctx.beginPath();
        ctx.arc(C, C, R, a0, a1);
        ctx.arc(C, C, prev, a1, a0, true);
        ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      }
    }
    img.setAttribute('href', cv.toDataURL('image/png'));

    // THE HORIZON OUTLINE, as an SVG path so it stays crisp at any zoom — this
    // is the line Peter asked for, and it is the only part legible at a 200 km
    // ring where the visible region is a few pixels across.
    if (path) {
      const CX = 300, CY = 300, RR = 256;
      const pts = B.map((b, i) => {
        const hz = d.horizon_km[i] ?? d.sampled_to_km;
        const n = this._radarNorm(hz, maxKm) * RR;
        const a = (b - 90) * Math.PI / 180;
        return [CX + Math.cos(a) * n, CY + Math.sin(a) * n];
      });
      path.setAttribute('d', 'M' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L') + 'Z');
    }
  },

  // ── Achieved reach ─────────────────────────────────────────────────────────
  //
  // Peter, 2026-08-05: "the antenna beam / reach arc should be based on what has
  // actually been CONTACTED or heard", and "the reality is that I can only tell
  // when I see it."
  //
  // Two series, SERVED (src/reach.js), never merged here:
  //   PROVEN  furthest node we have a proven direct RF link to in that sector
  //   HEARD   downlink-only evidence, weaker, and its hops=0 gate is unverified
  //
  // A sector with no evidence draws NOTHING. Not a zero-radius wedge — nothing.
  // Unknown is not unreachable, and a shoreline where we have never looked would
  // be a lie in the same class as the 400 km theoretical circle this replaced.
  async _loadReach() {
    try {
      const d = await fetchJSON('/reach');
      this.reachData = d?.achieved?.ready ? d : null;
    } catch { this.reachData = null; }
  },

  _drawRadarReach(maxKm) {
    const g = document.getElementById('radar-reach-g');
    if (!g) return;
    g.innerHTML = '';
    if (!this.layerOn('reach')) return;
    if (this.reachData == null) {
      if (!this._reachLoading) {
        this._reachLoading = true;
        this._loadReach().finally(() => { this._reachLoading = false; this.drawRadar(); });
      }
      return;
    }
    const CX = 300, CY = 300, R = 256;
    const arc = (from, to, rad, style) => {
      const a0 = (from - 90) * Math.PI / 180, a1 = (to - 90) * Math.PI / 180;
      const x0 = CX + Math.cos(a0) * rad, y0 = CY + Math.sin(a0) * rad;
      const x1 = CX + Math.cos(a1) * rad, y1 = CY + Math.sin(a1) * rad;
      return svgElem('path', {
        d: `M${CX} ${CY} L${x0.toFixed(1)} ${y0.toFixed(1)} A${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`,
        style,
      });
    };
    for (const s of this.reachData.achieved.sectors) {
      if (s.heard_km != null) {
        const r = this._radarNorm(s.heard_km, maxKm) * R;
        if (r > 1) g.appendChild(arc(s.from_deg, s.to_deg, r,
          'fill:rgba(120,190,255,0.07);stroke:rgba(120,190,255,0.30);stroke-width:0.8;stroke-dasharray:2 3'));
      }
      if (s.furthest_km == null) continue;            // no evidence: draw nothing
      const r = this._radarNorm(s.furthest_km, maxKm) * R;
      if (r <= 1) continue;
      g.appendChild(arc(s.from_deg, s.to_deg, r,
        'fill:rgba(0,255,140,0.13);stroke:rgba(0,255,140,0.65);stroke-width:1.4'));
      const mid = (s.mid_deg - 90) * Math.PI / 180;
      const t = svgElem('text', {
        x: CX + Math.cos(mid) * (r + 9), y: CY + Math.sin(mid) * (r + 9),
        'text-anchor': 'middle',
        style: 'fill:rgba(0,255,140,0.9);font-size:8px;font-family:ui-monospace,monospace;'
             + 'paint-order:stroke;stroke:rgba(0,0,0,0.75);stroke-width:2.5px;pointer-events:none',
      });
      t.textContent = `${s.furthest_km}km ${s.node || ''}`.trim();
      g.appendChild(t);
    }
  },

  async _loadClusters() {
    try {
      const d = await fetchJSON('/clusters');
      this.clusterData = d || null;
    } catch { this.clusterData = null; }
  },

  // ── Cluster hover card ─────────────────────────────────────────────────────
  // Holds the detail the one-line label deliberately drops. Every value shown is
  // SERVED (src/clusters.js) — verdict, purity, extents, drift, dominant door.
  // This positions a card and prints them.
  _bindClusterCardHover() {
    if (this._cardHoverBound) return;
    this._cardHoverBound = true;
    const el = document.querySelector('[x-show="clusterCard"]');
    if (!el) { this._cardHoverBound = false; return; }
    el.addEventListener('mouseenter', () => { this._clusterCardPinned = true; });
    el.addEventListener('mouseleave', () => { this._clusterCardPinned = false; this.hideClusterCard(); });
  },

  showClusterCard(c, ev) {
    this._bindClusterCardHover();
    const host = document.getElementById('radar-wrap') || document.body;
    const r = host.getBoundingClientRect();
    this.clusterCard = {
      ...c,
      _x: Math.min(Math.max(ev.clientX - r.left + 14, 8), Math.max(8, r.width - 250)),
      _y: Math.min(Math.max(ev.clientY - r.top + 14, 8), Math.max(8, r.height - 190)),
    };
  },
  // The card is pointer-events:none so it never blocks the radar; the name row
  // re-enables them. Leaving the card open while typing means a mouseleave on the
  // blob must not close it mid-edit, hence _clusterCardPinned.
  hideClusterCard() { if (!this._clusterCardPinned) this.clusterCard = null; },

  /** Rename a cluster from the card. The anchor is the identity, so this changes
   *  the NAME and nothing else — not the position, not the membership. */
  async renameCluster(id, name) {
    if (id == null) return;
    try {
      await fetchJSON(`/clusters/${id}`, 'PATCH', { friendly_name: (name || '').trim() || null });
      this.clusterData = null;            // force a re-fetch so the label updates
      this._terrainKey = null;
      await this._loadClusters();
      this.drawRadar();
      this.toast?.('Cluster renamed', 'success');
    } catch (e) {
      this.toast?.(`Rename failed: ${e}`, 'error');
    }
  },

  /** Is a layer on? Reads the browser-local view preference. */
  layerOn(key) {
    const l = (this.radarLayers || []).find(x => x.key === key);
    return l ? !!l.on : true;
  },
  get layerClusters() { return this.layerOn('clusters'); },

  /** Toggling a layer PROMOTES it — the thing you just touched is the thing you
   *  are looking at. Turning one off does not promote it; there is no sense in
   *  focusing something invisible. */
  toggleRadarLayer(key) {
    const l = (this.radarLayers || []).find(x => x.key === key);
    if (!l) return;
    l.on = !l.on;
    if (l.on && l.draws) this._promoteLayer(l);
    this._saveRadarLayers();
    this.drawRadar();
  },

  /** Explicit focus without changing visibility — clicking the layer's name. */
  focusRadarLayer(key) {
    const l = (this.radarLayers || []).find(x => x.key === key && x.draws);
    if (!l || !l.on) return;
    this._promoteLayer(l);
    this._saveRadarLayers();
    this.drawRadar();
  },

  /** Manual reorder, +1 up / -1 down among the draw layers. */
  moveRadarLayer(key, dir) {
    const draws = this.radarLayers.filter(x => x.draws).sort((a, b) => a.order - b.order);
    const i = draws.findIndex(x => x.key === key);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= draws.length) return;
    const t = draws[i].order; draws[i].order = draws[j].order; draws[j].order = t;
    this._saveRadarLayers();
    this.drawRadar();
  },

  _promoteLayer(l) {
    const top = Math.max(...this.radarLayers.filter(x => x.draws).map(x => x.order));
    if (l.order === top) return;
    l.order = top + 1;
    // Renumber 1..n so the numbers stay small and readable in the UI.
    this.radarLayers.filter(x => x.draws).sort((a, b) => a.order - b.order)
      .forEach((x, i) => { x.order = i + 1; });
  },

  /** THE SINGLE PERSIST MECHANISM. Peter, 2026-08-05: "IT MUST PERSIST", and
   *  earlier: "one of my requirements was for a single persist function in the
   *  browser that worked on every control".
   *
   *  The first version of this wrote its own localStorage key — a fourth private
   *  store, in the very area he was about to complain about. It now goes through
   *  app-persist like everything else, so there is one browser store. */
  _saveRadarLayers() {
    persistSet('radarLayers', this.radarLayers.map(l => ({ key: l.key, on: l.on, order: l.order })));
  },

  /** Restore visibility AND order. Called from Alpine init, NOT from initRadar —
   *  initRadar early-returns when homePos is not ready on a cold load and never
   *  retries, which is why the first version never restored anything. */
  restoreRadarLayers() {
    const saved = persistGet('radarLayers', null);
    if (!Array.isArray(saved)) return;
    for (const s of saved) {
      const l = this.radarLayers.find(x => x.key === s.key);
      if (!l) continue;                       // a layer that no longer exists
      if (typeof s.on === 'boolean') l.on = s.on;
      if (Number.isFinite(s.order) && l.draws) l.order = s.order;
    }
  },

  /** Draw layers, bottom first. */
  get orderedDrawLayers() {
    return this.radarLayers.filter(l => l.draws).sort((a, b) => a.order - b.order);
  },

  /** Brightness from depth: the top layer is full strength, each one below it
   *  steps down. This is the mechanism that replaces hand-tuned per-layer alpha. */
  layerBrightness(key) {
    const ord = this.orderedDrawLayers;
    const i = ord.findIndex(l => l.key === key);
    if (i < 0) return 1;
    const fromTop = ord.length - 1 - i;
    return Math.max(0.35, 1 - fromTop * 0.28);
  },

  /** Apply depth + brightness to the real SVG groups. */
  _applyLayerOrder() {
    const G = { terrain: 'radar-terrain-img', reach: 'radar-reach-g',
                clusters: 'radar-clusters-g', nodes: 'radar-nodes-g' };
    const horizon = document.getElementById('radar-horizon-path');
    for (const l of this.orderedDrawLayers) {
      const el = document.getElementById(G[l.key]);
      if (!el) continue;
      el.parentNode.appendChild(el);            // re-append = move to top of the stack
      el.style.opacity = l.on ? String(this.layerBrightness(l.key)) : '0';
      if (l.key === 'terrain' && horizon) {
        horizon.parentNode.appendChild(horizon);
        horizon.style.opacity = el.style.opacity;
      }
    }
  },

  /** Nodes the visible layers permit. `own` is always drawn — hiding our own
   *  radios would remove the reference point the whole display is measured from. */
  _layerFiltered(nodes) {
    return nodes.filter(n => {
      const k = n.node_kind || 'endpoint';
      if (k === 'own') return true;
      if (!this.layerOn('nodes')) return false;   // the whole layer is off
      if (k === 'door')     return this.layerOn('doors');
      if (k === 'router')   return this.layerOn('routers');
      return this.layerOn('endpoints');
    });
  },

  _drawRadarClusters(maxKm) {
    const g = document.getElementById('radar-clusters-g');
    if (!g) return;
    g.innerHTML = '';
    if (!this.layerClusters) return;                    // layer switched off
    const home = this.homePos;
    // LAZY, ORDER-INDEPENDENT LOAD. initRadar() early-returns when homePos is not
    // ready yet on a cold URL load and never retries, so hanging the fetch off it
    // meant the overlay silently never appeared. Loading on first draw instead
    // works whatever order init and the WS arrive in.
    if (this.clusterData == null && !this._clusterLoading && home) {
      this._clusterLoading = true;
      this._loadClusters().finally(() => { this._clusterLoading = false; this.drawRadar(); });
      return;
    }
    const d = this.clusterData;
    if (!d || !home || !Array.isArray(d.clusters)) return;
    const CX = 300, CY = 300, R = 256;

    // A cluster's verdict is SERVED; this only maps the tone to a colour, the
    // same way the node glyphs map a served kind to a shape.
    const TONE = {
      success: 'rgba(0,255,120,',    // solved — one reliable way in
      warning: 'rgba(255,190,0,',    // mixed
      error:   'rgba(255,90,90,',    // unresolved — reached by inconsistent paths
      neutral: 'rgba(150,170,200,',  // unknown — never reached at all
    };

    // THE OVERLAY REPLACES DETAIL, IT DOES NOT PILE ON TOP OF IT.
    //
    // First cut drew all 52 blobs with two lines of label each, on top of the
    // nodes. That was MORE cluttered than the saturated display it was meant to
    // fix — the exact failure the feature exists to prevent, so it is worth
    // naming rather than quietly tuning away.
    //
    // The fix is not an arbitrary size threshold. It is that "clusters" and
    // "endpoints" are two READINGS of the same radar, which is what Peter asked
    // for: "the same radar only with different overlays ... I may only want to
    // see a target node and see the cluster, router and doors only without the
    // clutter of all the other nodes".
    //
    //   endpoints ON  -> blobs are quiet CONTEXT: outline only, no labels
    //   endpoints OFF -> the cluster IS the subject: labelled, filled, named
    //
    // So the labels arrive exactly when there is room for them, and no number
    // had to be invented.
    const clusterFirst = !this.layerOn('endpoints');

    for (const c of d.clusters) {
      if (!c.member_count) continue;                    // an empty place draws nothing
      // A two-node group has no area and reads as a ring round two dots. Worth
      // drawing when the cluster is the subject; noise when it is not.
      if (!clusterFirst && c.member_count < 3) continue;
      const pts = (c.hull || []).map(p => {
        const km = haversine(home.lat, home.lon, p.lat, p.lon);
        const az = bearing(home.lat, home.lon, p.lat, p.lon) * Math.PI / 180;
        const n  = this._radarNorm(km, maxKm);
        return [CX + Math.sin(az) * n * R, CY - Math.cos(az) * n * R];
      });
      if (!pts.length) continue;
      const base = TONE[c.verdict_tone] || TONE.neutral;
      const grp  = svgElem('g', { class: 'radar-cluster' });

      const fillA   = clusterFirst ? 0.14 : 0.05;
      const strokeA = clusterFirst ? 0.65 : 0.28;
      if (pts.length >= 3) {
        grp.appendChild(svgElem('polygon', {
          points: pts.map(p => p.join(',')).join(' '),
          style: `fill:${base}${fillA});stroke:${base}${strokeA});stroke-width:1.2;stroke-linejoin:round`,
        }));
      } else {
        // Two members have no area. Draw the extent as a disc rather than a line
        // so a two-node cluster still reads as a place.
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const rr = Math.max(6, Math.hypot(pts[0][0] - cx, pts[0][1] - cy) + 5);
        grp.appendChild(svgElem('circle', { cx, cy, r: rr,
          style: `fill:${base}${fillA});stroke:${base}${strokeA});stroke-width:1.2;stroke-dasharray:3 3` }));
      }

      // Label at the top of the blob: name, size, and the purity that says
      // whether this place is solved. Purity is shown WITH its denominator —
      // "100% of 1 routed member" is not the same claim as "92% of 13".
      // EVERY cluster is labelled in the cluster-first reading. The earlier
      // >=3 rule existed only because the two-line label was too big; Peter
      // asked for a short form instead — "AA-20/10 meaning cluster AA 20 nodes,
      // 10 resolved" — so the size threshold is no longer needed and unlabelled
      // blobs (which he reported as confusing) are gone.
      if (!clusterFirst) { g.appendChild(grp); continue; }
      const lx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const ly = Math.min(...pts.map(p => p[1])) - 6;
      // ONE LINE, SERVED. `c.label` is composed in Domain 1 (AA-20/10); the
      // detail that used to be a second line moves to the hover card, which is
      // where it can be laid out properly instead of fighting for space.
      const t = svgElem('text', { x: lx, y: ly, 'text-anchor': 'middle',
        style: `fill:${base}0.95);font-size:9px;font-family:ui-monospace,monospace;`
             + `paint-order:stroke;stroke:rgba(0,0,0,0.75);stroke-width:2.5px;pointer-events:none` });
      t.textContent = c.label;
      grp.appendChild(t);

      // HOVER CARD. Peter, 2026-08-05: "then we can have a mouse over / hover
      // call out that can show more details in a formatted / pretty card."
      //
      // The static label carries identity and size; everything else lives here,
      // where it can be laid out instead of fighting the map for space. An
      // invisible hit area over the hull makes the whole blob hoverable rather
      // than just its label.
      const hit = pts.length >= 3
        ? svgElem('polygon', { points: pts.map(p => p.join(',')).join(' '),
                               style: 'fill:transparent;stroke:transparent;stroke-width:10;cursor:help' })
        : svgElem('circle', { cx: lx, cy: pts[0][1], r: 14, style: 'fill:transparent;cursor:help' });
      hit.addEventListener('mouseenter', (e) => this.showClusterCard(c, e));
      // Pin while the pointer is over the card itself, so moving from the blob to
      // the name field does not dismiss it.
      hit.addEventListener('mouseleave', () => setTimeout(() => this.hideClusterCard(), 250));
      grp.appendChild(hit);
      g.appendChild(grp);
    }
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
          const snrHopDb = snrs[ai] ?? null;   // null == unmeasured hop, already filtered at ingest
          if (snrHopDb != null) {
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const lbl = svgElem('text', {
              x: mx.toFixed(1), y: (my - 4).toFixed(1),
              style: `fill:${col};font-size:8px;font-family:'Oxanium',monospace;text-anchor:middle`,
            });
            // Already dB (decoded once at WS ingest, B72). Previously this
            // divided by 4 here but had no sentinel guard, so an unmeasured
            // hop was drawn as a confident "-32.0".
            lbl.textContent = `${snrHopDb >= 0 ? '+' : ''}${snrHopDb.toFixed(1)}`;
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

  // Piecewise-linear quantile scale: control points at the node-distance
  // quartiles so screen space follows the actual distribution (the cluster
  // band gets ~half the radius wherever it sits). NICE-snapped + hysteresis
  // so the plot doesn't jitter as nodes come and go. Display arithmetic
  // derived from the pushed node list — no state decisions.
  // THE QUANTILES ARE SERVED. This computed them from the displayed list — a
  // defensible reading of "display arithmetic", but the quantiles are a property
  // of the DATA, and computing them on both sides is how the region-frequency
  // table ended up with three drifted copies (B80).
  //
  // radar_context.scale carries { max_km, kms[], fracs[] }, hysteresis included
  // (it only works if one side owns the previous value). What stays here is the
  // interpolation — mapping a distance to a radius — which is display.
  _radarScaleCtrl(maxKm) {
    const s = this.radarCtx?.scale;
    return (s && s.max_km === maxKm) ? { maxKm: s.max_km, kms: s.kms, fracs: s.fracs } : null;
  },

  _radarNorm(km, maxKm) {
    if (!km || !maxKm) return 0;
    if (!this.radarLogScale) return Math.min(km / maxKm, 1.0);
    const ctrl = this._radarScaleCtrl(maxKm);
    if (!ctrl) return Math.min(Math.pow(km / maxKm, 0.4), 1.0); // sparse fallback
    // Piecewise-linear through (0,0) … (kms[i], fracs[i]) … (maxKm, 0.95)
    const xs = [0, ...ctrl.kms, maxKm];
    const ys = [0, ...ctrl.fracs, 0.95];
    for (let i = 1; i < xs.length; i++) {
      if (km <= xs[i]) {
        const t = (km - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
        return Math.min(ys[i - 1] + t * (ys[i] - ys[i - 1]), 1.0);
      }
    }
    return 1.0;
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
          // Rings AT the adaptive-scale control distances: ~equal screen
          // spacing whose km labels reveal the distribution (rings crowd in
          // km where nodes crowd — space follows the cluster).
          const ctrl = this._radarScaleCtrl(maxKm);
          if (ctrl) return [...ctrl.kms, maxKm];
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
    // LAYER FILTER. Applied here rather than to radarNodes itself, so the node
    // TABLE and the plotted-count keep showing the whole picture while the radar
    // shows the subset — hiding a layer is a view choice, not a data change.
    const nodes = this._layerFiltered(this.radarNodes || []);
    const CX = 300, CY = 300, R = 256;
    const G4 = 'rgba(0,255,80,0.95)', AMBER = 'rgba(255,200,40,0.90)', LABEL = 'rgba(255,140,0,0.55)';
    const BASE_DIAG = 12, STEP_DIAG = 14, HOR_LEN = 16;
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
      // `norm` rides along so the endpoint fade follows the compressive ring
      // scale, not raw km — otherwise the dense inner band would all vanish.
      return { x: CX + Math.sin(az) * normKm * R, y: CY - Math.cos(az) * normKm * R, norm: normKm, diagLen: BASE_DIAG, armAngle: 45 };
    });

    // ── Iterative label placement: constant arm length, rotating angle ──────
    // Deterministic order (distance then num); per-node angle memory so a
    // settled label only re-solves when a NEW plot conflicts with it.
    if (!this._radarLabelAngles) this._radarLabelAngles = new Map();
    const placedBoxes = [];
    const CHAR_W = 6.5, TXT_H = 12;
    const labelBox = (p, angleDeg, len, text) => {
      // Arm: diagonal at angleDeg (0=up, clockwise) then horizontal cap away
      // from the plot; text hangs off the cap end.
      const rad = angleDeg * Math.PI / 180;
      const ex = p.x + Math.sin(rad) * len, ey = p.y - Math.cos(rad) * len;
      const right = Math.sin(rad) >= 0;
      const capX = ex + (right ? HOR_LEN : -HOR_LEN);
      const w = Math.max(1, text.length) * CHAR_W;
      const x0 = right ? capX + 3 : capX - 3 - w;
      return { x: x0, y: ey - TXT_H / 2, w, h: TXT_H, ex, ey, capX, right };
    };
    const hits = (b) => placedBoxes.some(o =>
      b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h)
      || npos.some(p => p && p.x > b.x - 4 && p.x < b.x + b.w + 4 && p.y > b.y - 4 && p.y < b.y + b.h + 4);
    // Candidate sweep: preferred first, then alternating ±30° steps
    const sweep = (base) => [base, ...[30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]
      .map(d => ((base + d) % 360 + 360) % 360)];

    const order = nodes.map((n, i) => ({ n, i }))
      .filter(({ i }) => npos[i])
      .sort((a, b) => (a.n._km ?? 999) - (b.n._km ?? 999) || a.n.num - b.n.num);
    for (const { n, i } of order) {
      const p = npos[i];
      const text = n.display_name || n.user?.short_name || '';
      const preferred = this._radarLabelAngles.get(n.num) ?? 45;
      let chosen = null;
      for (const len of [BASE_DIAG, BASE_DIAG + STEP_DIAG]) {   // length extension = last resort
        for (const a of sweep(preferred)) {
          const b = labelBox(p, a, len, text);
          if (!hits(b)) { chosen = { a, len, b }; break; }
        }
        if (chosen) break;
      }
      if (!chosen) { const a = preferred; chosen = { a, len: BASE_DIAG, b: labelBox(p, a, BASE_DIAG, text) }; }
      this._radarLabelAngles.set(n.num, chosen.a);
      p.armAngle = chosen.a;
      p.diagLen  = chosen.len;
      p.box      = chosen.b;
      placedBoxes.push(chosen.b);
    }
    // Drop memory for nodes no longer plotted
    const liveNums = new Set(nodes.map(n => n.num));
    for (const k of this._radarLabelAngles.keys()) if (!liveNums.has(k)) this._radarLabelAngles.delete(k);

    nodes.forEach((node, ni) => {
      if (!npos[ni]) return;
      const { x, y, box } = npos[ni];
      const isRight = box ? box.right : x >= CX;
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
          if (this.yagiSignal.num === node.num && this.signalIsFresh()) {
            this.appendPulseRing(g, x, y);
          }
          if (this.yagiSignal.num === node.num && (this.yagiSignal.rssi != null || this.yagiSignal.snr != null)) {
            const sig = this.yagiSignal;
            const age = this.signalAge();
            const stale = !this.signalIsFresh();
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
          if (this.yagiSignal.num === node.num && this.signalIsFresh()) {
            this.appendPulseRing(g, x, y);
          }
          if (this.yagiSignal.num === node.num && (this.yagiSignal.rssi != null || this.yagiSignal.snr != null)) {
            const sig = this.yagiSignal;
            const age = this.signalAge();
            const stale = !this.signalIsFresh();
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
      const r = isSelected ? 6 : 4;
      // KIND-AWARE MARK. `node_kind` is served (src/node-kind.js); this only maps
      // it to a shape. Unknown/absent kind falls back to 'endpoint', so an older
      // payload degrades to today's behaviour rather than drawing nothing.
      const kind = node.node_kind || 'endpoint';
      const op   = isSelected ? 1 : markOpacity(kind, npos[ni].norm ?? 1);
      if (ringColor)
        g.appendChild(svgElem('circle', { cx: x, cy: y, r: r + 2, style: `fill:${ringColor};opacity:${0.85 * op}` }));
      for (const el of kindGlyph(kind, x, y, r, dotColor, op)) g.appendChild(el);
      const title = svgElem('title');
      title.textContent = node.user?.long_name || node.display_name || '';
      g.appendChild(title);
      const label = node.display_name || node.user?.short_name || '';
      // Arm at the collision-solved angle: diagonal to the elbow, horizontal
      // cap toward the text side (constant length; angle is the variable).
      const elbowX = box ? box.ex : x + (isRight ? 1 : -1) * BASE_DIAG;
      const elbowY = box ? box.ey : y - BASE_DIAG;
      const capX   = box ? box.capX : elbowX + (isRight ? 1 : -1) * HOR_LEN;
      const diagSign = isRight ? 1 : -1;
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
      this.wsGeocode(node.num).then(addr => {
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
      const addr = await this.wsGeocode(node.num);
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

  // SERVED WINDOW. "30 seconds" was hardcoded four times — here (x2, as `< 30`
  // and `>= 30`) and in tab-radar.html:278 — so the pulse ring and the reading
  // beside it could disagree about whether the same signal was current. One
  // rule now: verdict_bands.live_signal_fresh_sec.
  //
  // Unknown age is NOT fresh: no reading is not a current reading.
  signalIsFresh() {
    const age = this.signalAge();
    const win = this.verdictBands?.live_signal_fresh_sec;
    if (age == null || win == null) return false;
    return age < win;
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
