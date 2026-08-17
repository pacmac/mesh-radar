// Single source of truth for all repeated UI rendering.
// Every badge, avatar, indicator and composite widget is defined once here.
// Use x-html="componentName(...)" in Alpine templates.

import { FF } from './feature-flags.js';
import { toneCls, toneBadge, toneColour } from './app-helpers.js';

export const componentsMixin = {
  // Exposed to templates so a :class can render a SERVED tone without the
  // markup restating a threshold. This is the tone->CSS map and nothing else.
  toneCls(t)    { return toneCls(t); },
  toneBadge(t)  { return toneBadge(t); },
  toneColour(t) { return toneColour(t); },


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
    // The PASV "TRACING" card is REMOVED 2026-08-17 — spec
    // docs/modules/traceroute-removal-browser.md. It named the node the passive
    // tracer was currently tracing; nothing traces, so the card could only ever
    // have been a lie about what the station was doing.
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
  // `tone` is SERVED (node.hops_tone / message.hops_tone) — the 0/1/2 threshold
  // moved to src/signal-verdict.js. The TEXT below is display composition and
  // stays here: "Direct" vs "n hops", and the verified/reported suffix.
  // THE VERIFIED/FRESH DOT IS GONE — 2026-08-17, spec
  // docs/modules/traceroute-removal-browser.md. `verified` meant "this hop
  // count came from a traceroute rather than from reported live hops", and
  // `fresh` meant that traceroute was recent. With nothing tracing, every hop
  // count is reported, so a badge claiming verification would be asserting a
  // measurement that can no longer be taken. What is left is the count.
  hopsBadge(hops, tone = null) {
    if (hops == null) return '';
    const cls = toneCls(tone ?? 'muted');
    const tip = (hops === 0 ? 'Direct' : `${hops} ${hops === 1 ? 'hop' : 'hops'}`) + ' · reported';
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

  // BLE link-quality bars from the gw V2 signal_pct field (0–100; raw BLE
  // dBm is not exposed in V2). Same markup/classes as sigBars.
  // `tone` is SERVED as device.signal_pct_tone — the >=50/25 bands moved to
  // src/signal-verdict.js (blePctTone). BLE is not LoRa and keeps its own bands.
  pctBars(pct, tone = null, scale = 1) {
    if (pct == null) return '';
    const cls = toneCls(tone ?? 'muted');
    const bars = [3, 6, 9, 12].map((h, i) =>
      `<i style="height:${Math.round(h * scale)}px;opacity:${pct > i * 25 ? 1 : 0.15}"></i>`
    ).join('');
    return `<span class="sig-bars ${cls}" title="BLE link ${pct}%">${bars}</span>`;
  },

  // ── Status badges ────────────────────────────────────────────────────────
  devStateBadge(nodeId) {
    const dev    = this.deviceBleStates[nodeId];
    const saving = this.devIsSaving(nodeId);
    const bc_map = { success: 'badge-success', warning: 'badge-warning', error: 'badge-error', info: 'badge-info' };
    const cls    = saving ? 'badge-warning' : (bc_map[dev?.display?.badge_color] || 'badge-ghost');
    const label  = saving ? 'saving' : (dev?.display?.badge_text || 'offline');
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
