// Rotator control and configuration mixin.
import { fetchJSON, nextFrame } from './app-helpers.js';
import { buildForm, collectForm } from './app-forms.js';

export const rotatorMixin = {
  _onRotatorEvent(data) {
    // Only mark connected when firmware telemetry is present — a bare {_mode} event
    // is sent on WS connect to seed the persisted mode even when rotator is offline.
    if (data.az != null || 'busy' in data || 'point_target' in data) this.rotatorConnected = true;

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
      if ('target' in data && this.tab === 'radar') this._drawTargetArm();
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

  async setRotatorMode(m) {
    await fetchJSON('/rotator/mode', 'POST', { mode: m });
  },

  async moveRotator(az) {
    if (az == null) return;
    this.rotatorStatus = { ...this.rotatorStatus, target: Number(az) };
    if (this.tab === 'radar') this._drawTargetArm();
    await fetchJSON('/rotator/move', 'POST', { az: Number(az) });
  },

  async applyPwmRunPct() {
    if (this.pwmRunPctInput == null) return;
    const pct = Math.max(1, Math.min(100, this.pwmRunPctInput)) / 100;
    await fetchJSON('/rotator/setvar', 'POST', { action: 'setPwmRunPct', val: pct.toFixed(2) });
  },

  async applyPwmFreq() {
    if (this.pwmFreqInput == null) return;
    const freq = Math.max(10, Math.min(20000, this.pwmFreqInput));
    await fetchJSON('/rotator/setvar', 'POST', { action: 'setPwmFreq', val: String(freq) });
  },

  startScan() {
    fetchJSON('/rotator/scan/start', 'POST').catch(() => {});
  },

  abortScan() {
    fetchJSON('/rotator/scan/abort', 'POST').catch(() => {});
  },

  async loadRotatorCfg() {
    try {
      const needsSchema = !this.rotatorCfgSchema;
      const [schema, data] = await Promise.all([
        needsSchema ? fetchJSON('/schema/rotator_config') : Promise.resolve(this.rotatorCfgSchema),
        fetchJSON('/rotator/firmware_config'),
      ]);
      if (needsSchema) this.rotatorCfgSchema = schema;
      if (data?.scan?.step_deg  != null) this.scanStep  = Number(data.scan.step_deg);
      if (data?.scan?.dwell_sec != null) this.scanDwell = Number(data.scan.dwell_sec);
      if (data?.actv?.dwell_sec != null) this.actvDwell = Number(data.actv.dwell_sec);
      await nextFrame();
      const el = document.getElementById('rotator_cfg_form');
      if (el && !el.dataset.dirty) {
        el.innerHTML = '';
        el.dataset.formRoot = '1';
        el.appendChild(buildForm(schema.fields, data, []));
      }
    } catch (e) {
      console.warn('Failed to load rotator cfg', e);
    }
  },

  async saveRotatorConfig() {
    this.rotatorCfgSaved = false;
    this.rotatorCfgError = '';
    try {
      const el = document.getElementById('rotator_cfg_form');
      const payload = collectForm(el, this.rotatorCfgSchema.fields);
      await fetchJSON('/rotator/firmware_config', 'POST', payload);
      el.removeAttribute('data-dirty');
      if (payload?.scan?.step_deg  != null) this.scanStep  = Number(payload.scan.step_deg);
      if (payload?.scan?.dwell_sec != null) this.scanDwell = Number(payload.scan.dwell_sec);
      if (payload?.actv?.dwell_sec != null) this.actvDwell = Number(payload.actv.dwell_sec);
      this.rotatorCfgSaved = true;
      setTimeout(() => { this.rotatorCfgSaved = false; }, 2000);
    } catch (e) {
      this.rotatorCfgError = String(e);
    }
  },

  async rotatorCalibrate(procedure) {
    this.rotatorCalSent = false;
    this.rotatorCalError = '';
    try {
      await fetchJSON('/rotator/calibrate', 'POST', { procedure });
      this.rotatorCalSent = true;
      setTimeout(() => { this.rotatorCalSent = false; }, 2000);
    } catch (e) {
      this.rotatorCalError = String(e);
    }
  },

  async setRotatorOffset(offset) {
    this.rotatorCalSent = false;
    this.rotatorCalError = '';
    try {
      await fetchJSON('/rotator/offset', 'POST', { offset: parseFloat(offset) });
      this.rotatorCalSent = true;
      setTimeout(() => { this.rotatorCalSent = false; }, 2000);
    } catch (e) {
      this.rotatorCalError = String(e);
    }
  },
};
