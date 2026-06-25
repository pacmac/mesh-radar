// Single source of truth for all repeated UI rendering.
// Every badge, avatar, indicator and composite widget is defined once here.
// Use x-html="componentName(...)" in Alpine templates.

import { FF } from './feature-flags.js';

export const componentsMixin = {

  // ── Active overlay card descriptor ──────────────────────────────────────
  // SSOT: returns { node, mode, label, border, accent, nameclr, divider } or null.
  // Template uses this to drive the unified PASV/ACTV/SCAN overlay card.
  get activeCard() {
    // ── [V2] SSOT_ROUTE_RENDER — backend sends active_card, we just resolve node
    if (FF.SSOT_ROUTE_RENDER) {
      const ac = this.radarCtx?.active_card;
      if (!ac) return null;
      const node = this.nodes.find(n => n.num === ac.node_num) || null;
      return node ? { node, mode: ac.mode, label: ac.label, border: ac.border, accent: ac.accent, nameclr: ac.nameclr, divider: ac.divider } : null;
    }
    // ── [V1] LEGACY — remove when SSOT_ROUTE_RENDER verified ─────────────────
    if (this.rotatorMode === 1 && this.targetNode)
      return { node: this.targetNode,  mode: 'actv', label: 'TARGET',
               border:  'rgba(255,30,30,0.40)', accent:  'rgba(255,30,30,0.75)',
               nameclr: 'rgba(255,30,30,0.95)', divider: 'rgba(255,30,30,0.18)' };
    if (this.rotatorMode === 0 && this.passiveNode)
      return { node: this.passiveNode, mode: 'pasv', label: 'TRACING',
               border:  'rgba(0,255,80,0.35)',  accent:  'rgba(0,255,80,0.75)',
               nameclr: 'rgba(0,255,80,0.95)',  divider: 'rgba(0,255,80,0.15)' };
    return null;
    // ─────────────────────────────────────────────────────────────────────────
  },

  // ── Avatar ──────────────────────────────────────────────────────────────
  nodeAvatar(num, name, size = '') {
    const bg = this.avatarColor(num);
    const cls = size ? `node-avatar node-avatar-${size}` : 'node-avatar';
    return `<span class="${cls}" style="background:${bg}">${_esc(name || '?')}</span>`;
  },

  // ── Hops circle ─────────────────────────────────────────────────────────
  hopsBadge(hops) {
    if (hops == null) return '';
    const cls = hops === 0 ? 'text-success'
              : hops === 1 ? 'text-info'
              : hops === 2 ? 'text-warning'
              :              'text-error';
    const tip = hops === 0 ? 'Direct' : `${hops} ${hops === 1 ? 'hop' : 'hops'}`;
    return `<span class="hop-circle ${cls}" title="${tip}">${hops}</span>`;
  },

  // ── Signal bars (consolidated from app-radar.js) ─────────────────────────
  sigBars(rssi, snr, scale = 1) {
    const sq = this.signalQuality(rssi, snr);
    if (sq.none) return '';
    const bars = [3, 6, 9, 12].map((h, i) =>
      `<i style="height:${Math.round(h * scale)}px;opacity:${sq.pct > i * 25 ? 1 : 0.15}"></i>`
    ).join('');
    const tip = `${sq.label} (${sq.pct}%) · ${rssi != null ? rssi + ' dBm' : '–'} / ${snr != null ? snr + ' dB' : '–'}`;
    return `<span class="sig-bars ${sq.cls}" title="${tip}">${bars}</span>`;
  },

  // Signal bars + numeric value together
  sigValue(rssi, snr) {
    if (rssi == null && snr == null) return '–';
    const bars = this.sigBars(rssi, snr);
    const rssiStr = rssi != null ? `${rssi} dBm` : '';
    const snrStr  = snr  != null ? ` / ${snr >= 0 ? '+' : ''}${Number(snr).toFixed(1)} dB` : '';
    return `<span class="inline-flex items-center gap-1">${bars}<span class="font-mono text-xs">${rssiStr}${snrStr}</span></span>`;
  },

  // Navbar BLE bars (consolidated from app-nodes.js)
  signalBarFill(bar) {
    const snr  = this.primaryDevBleState?.last_rx_snr;
    const bars = snr == null ? 1 : snr > 0 ? 4 : snr > -7 ? 3 : snr > -14 ? 2 : 1;
    if (bar > bars) return 'oklch(var(--bc)/0.12)';
    if (bars >= 3)  return 'oklch(var(--su))';
    if (bars >= 2)  return 'oklch(var(--wa))';
    return 'oklch(var(--er))';
  },

  // ── Status badges ────────────────────────────────────────────────────────
  devStateBadge(nodeId) {
    const state  = this.devBleState(nodeId);
    const saving = this.devIsSaving(nodeId);
    const cls = (state === 'ready' && !saving) ? 'badge-success'
              : (state === 'syncing' || saving)  ? 'badge-warning'
              : state === 'error'                ? 'badge-error'
              :                                    'badge-ghost';
    const label = saving ? 'saving' : (state || 'idle');
    return `<span class="badge badge-sm ${cls}">${label}</span>`;
  },

  roleBadge(role) {
    if (!role) return '';
    const cls = role === 'PRIMARY' ? 'badge-success' : role === 'ROTATOR' ? 'badge-warning' : 'badge-ghost';
    return `<span class="badge badge-sm ${cls}">${role}</span>`;
  },

  labelBadge(label, color) {
    const style = color ? ` style="color:${window.themeColor(color)}"` : '';
    return `<span class="badge badge-sm badge-primary font-mono"${style}>${_esc(label)}</span>`;
  },

  channelRoleBadge(role) {
    const cls = role === 'PRIMARY'   ? 'badge-primary'
              : role === 'SECONDARY' ? 'badge-secondary'
              :                        'badge-ghost';
    return `<span class="badge badge-sm ${cls}">${role || 'DISABLED'}</span>`;
  },

  // ── Radio alias badge ────────────────────────────────────────────────────
  // Single SSOT for rendering a device label. Backed by deviceLabel() which
  // resolves: configured alias → short_name → last-4 of node_id.
  radioBadge(nodeId, extra = '') {
    const label = this.deviceLabel(nodeId);
    return `<span class="badge badge-xs badge-ghost font-mono opacity-70${extra ? ' ' + extra : ''}">${_esc(label)}</span>`;
  },

  // ── Event type badge (consolidated from app-ui.js) ───────────────────────
  filteredFeedEvents() {
    const all = window.feedFilterOptions || [];
    if (!all.length || !this.feedVisible || this.feedVisible.length >= all.length) return this.events;
    const visible = new Set(this.feedVisible);
    const knownIds = new Set(all.map(o => o.id));
    return this.events.filter(ev => {
      if (ev.portnum) {
        const id = 'portnum:' + ev.portnum;
        if (knownIds.has(id) && !visible.has(id)) return false;
      }
      const eid = 'event:' + ev.type;
      if (knownIds.has(eid) && !visible.has(eid)) return false;
      return true;
    });
  },

  badgeForType(type) {
    const map = {
      packet:                 'badge-primary',
      node_update:            'badge-secondary',
      node_info:              'badge-secondary',
      telemetry_update:       'badge-info',
      tilt_update:            'badge-info',
      range_test_entry:       'badge-warning',
      config_complete_id:     'badge-success',
      mqttClientProxyMessage: 'badge-accent',
    };
    return map[type] || 'badge-ghost';
  },

  // ── Radar crosshair (SVG DOM, not HTML string) ───────────────────────────
  // Appends crosshair lines + dashed circle to an existing SVG group element.
  appendCrosshair(g, x, y, color = 'rgba(255,30,30,0.70)') {
    const se = window.svgElem;
    if (!se) return;
    const rs = `stroke:${color};stroke-width:1.5`;
    g.appendChild(se('circle', { cx: x, cy: y, r: 16, style: `fill:none;${rs};stroke-dasharray:4 3` }));
    g.appendChild(se('line', { x1: x-22, y1: y,    x2: x-10, y2: y,    style: rs }));
    g.appendChild(se('line', { x1: x+10, y1: y,    x2: x+22, y2: y,    style: rs }));
    g.appendChild(se('line', { x1: x,    y1: y-22, x2: x,    y2: y-10, style: rs }));
    g.appendChild(se('line', { x1: x,    y1: y+10, x2: x,    y2: y+22, style: rs }));
  },

  // Appends a pulsing ring animation to an SVG group (ACTV signal received).
  appendPulseRing(g, x, y, color = 'rgba(255,30,30,0.70)') {
    const se = window.svgElem;
    if (!se) return;
    const pulse = se('circle', { cx: x, cy: y, r: '16', style: `fill:none;stroke:${color};stroke-width:1.2;pointer-events:none` });
    const aR = se('animate');
    aR.setAttribute('attributeName', 'r');
    aR.setAttribute('values', '16;40');
    aR.setAttribute('dur', '0.7s');
    aR.setAttribute('repeatCount', '1');
    aR.setAttribute('fill', 'freeze');
    const aO = se('animate');
    aO.setAttribute('attributeName', 'stroke-opacity');
    aO.setAttribute('values', '0.85;0');
    aO.setAttribute('dur', '0.7s');
    aO.setAttribute('repeatCount', '1');
    aO.setAttribute('fill', 'freeze');
    pulse.appendChild(aR);
    pulse.appendChild(aO);
    g.appendChild(pulse);
  },
};

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
