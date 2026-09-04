// Rotator control mixin. Rotator CONFIGURATION (device switch, firmware
// settings schema, calibration) is gone — mesh-gw owns it now (2026-09-04,
// task rotator-config-tab-removed-meshgw-owns-it; mesh-gw--node-dash#103
// confirmed rotator config moved into their per-radio install/antenna
// object, served on GET /devices — device configuration, same ruling as
// Devices/BLE/OTA). COMMANDING stays: aim resolves and points, this mixin
// only relays the live status and the point request.
import { fetchJSON } from './app-helpers.js';

export const rotatorMixin = {
  // ONE-SHOT — see the call site (app-radar.js initRadar). GET
  // /plugins/aim/status directly from mesh-gw; sets rotatorConnected /
  // yagiAz from its answer, same fields the old live status frame set.
  async _checkRotatorStatus() {
    if (!this.meshgwBase) return;
    try {
      const res = await fetch(`${this.meshgwBase}/plugins/aim/status`);
      const s = await res.json().catch(() => ({}));
      this.rotatorConnected = !!s.reachable;
      if (s.az != null) {
        this.yagiAz = s.az;
        if (this.tab === 'radar') this._animateBeam(s.az);
      }
    } catch {
      this.rotatorConnected = false;
    }
  },


  _onRotatorEvent(data) {
    // Only mark connected when firmware telemetry is present — a bare {_mode} event
    // is sent on WS connect to seed the persisted mode even when rotator is offline.
    if (data.az != null || 'busy' in data || 'point_target' in data) this.rotatorConnected = true;

    // A device switch (possibly from another client) invalidates the previous
    // firmware's telemetry — drop stale fields so variant-gated rows hide.
    // (variant/active_target arrive via this frame + the fwData spread below.)
    if (data.active_target != null && this.rotatorStatus.active_target != null
        && data.active_target !== this.rotatorStatus.active_target) {
      this.rotatorStatus = {};
    }
    if (data.active_target != null) this.rotatorStatus = { ...this.rotatorStatus, active_target: data.active_target };

    if ('point_target' in data) {
      this.yagiPointTarget = data.point_target;
      this.yagiTargetMeta  = {
        target_count:  data.yagi_target_count  ?? null,
        contact_count: data.yagi_contact_count ?? null,
        last_contact:  data.yagi_last_contact  ?? null,
        best_rssi:     data.yagi_best_rssi     ?? null,
        best_snr:      data.yagi_best_snr      ?? null,
      };
      this.yagiSignal = { num: null, rssi: null, snr: null, ts: null };
      if (data.az != null) this.rotatorStatus = { ...this.rotatorStatus, target: data.az };
      if (this.tab === 'radar') this.drawRadar();
      return;
    }

    if (data._mode != null) {
      this.rotatorMode = data._mode;
      if (this.tab === 'radar') this.drawRadar();
    }

    if (data.az != null || 'busy' in data) {
      const { _mode, ...fwData } = data;
      this.rotatorStatus = { ...this.rotatorStatus, ...fwData };
      if (data.az != null) {
        const azChanged = this.yagiAz !== data.az;
        this.yagiAz = data.az;
        if (azChanged && this.tab === 'radar') this._animateBeam(data.az);
      }
      // Redraw the target arm only when the bearing actually changes. `target`
      // now rides every normalized frame, so a per-frame redraw would churn the
      // SVG ~10-20x/s for no reason (and flicker the arm).
      if (this.tab === 'radar' && data.target !== this._lastArmTarget) {
        this._lastArmTarget = data.target;
        this._drawTargetArm();
      }
    }
  },

  _animateBeam(newAz) {
    const beamG = document.getElementById('radar-beam-g');
    if (!beamG) return;
    if (!beamG.firstChild) this._drawRadarBeam();
    if (this._radarBeamAz == null) {
      beamG.style.transition = 'none';
      beamG.style.transform = `rotate(${newAz}deg)`;
      beamG.getBoundingClientRect();
      beamG.style.transition = 'transform 1.2s ease';
    } else {
      beamG.style.transform = `rotate(${newAz}deg)`;
    }
    this._radarBeamAz = newAz;
    const lbl = beamG.querySelector('text');
    if (lbl) lbl.textContent = Math.round(newAz) + '°';
  },

  // Node-dash's own rx/tx-role mode, not rotator hardware — moved out from
  // under /rotator (2026-09-03, task rotator-command-via-meshgw-aim).
  async setRotatorMode(m) {
    await fetchJSON('/mode', 'POST', { mode: m });
  },


  // Straight to mesh-gw's aim plugin now — node-dash no longer selects or
  // commands a radio for pointing (2026-09-03, task
  // rotator-command-via-meshgw-aim; docs/gw/modules/aim_plugin.md). No `radio`
  // named: aim resolves whichever radio has a rotator configured. this.meshgwBase
  // is server-supplied (settings WS, meshgw_port) — never a hardcoded LAN address.
  async moveRotator(az) {
    if (az == null || !this.meshgwBase) return;
    this.rotatorStatus = { ...this.rotatorStatus, target: Number(az) };
    if (this.tab === 'radar') this._drawTargetArm();
    try {
      const res = await fetch(`${this.meshgwBase}/plugins/aim/point`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bearing_deg: Number(az), by: 'browser' }),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.az != null) {
        this.yagiAz = body.az;
        if (this.tab === 'radar') this._animateBeam(body.az);
      }
    } catch (e) {
      console.warn('moveRotator failed', e);
    }
  },

  // node-dash's own sweep, not rotator hardware — moved out from under
  // /rotator (2026-09-03, task rotator-command-via-meshgw-aim).
  startScan() {
    fetchJSON('/scan/start', 'POST').catch(() => {});
  },

  abortScan() {
    fetchJSON('/scan/abort', 'POST').catch(() => {});
  },

};
