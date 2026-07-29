// Rotator control and configuration mixin.
import { fetchJSON, nextFrame } from './app-helpers.js';
import { buildForm, collectForm } from './app-forms.js';

export const rotatorMixin = {
  _onRotatorEvent(data) {
    // Only mark connected when firmware telemetry is present — a bare {_mode} event
    // is sent on WS connect to seed the persisted mode even when rotator is offline.
    if (data.az != null || 'busy' in data || 'point_target' in data) this.rotatorConnected = true;

    // Switchable target list lives in its OWN stable state (not the per-frame
    // rotatorStatus), updated only when the list actually changes — otherwise the
    // Device-card x-for would tear down and rebuild on every status frame.
    if (data.targets && JSON.stringify(data.targets) !== JSON.stringify(this.rotatorTargets)) {
      this.rotatorTargets = data.targets;
    }
    // v5 device config schema (present on connect-replay + schema event; null on v4)
    if ('schema' in data) this.rotatorSchema = data.schema;
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

  async setRotatorMode(m) {
    await fetchJSON('/rotator/mode', 'POST', { mode: m });
  },

  // Master switch for automatic traceroute (backend `traceroute.enabled`).
  // Lives here because this file already owns the header's action handlers,
  // though traceroute itself is unrelated to the rotator.
  //
  // Optimistic so the button responds immediately; the server's settings WS
  // echo is what actually confirms it. Reverted on failure — a button that
  // stays switched after a write that did not land is worse than no button.
  async toggleTraceroute() {
    const next = !this.tracerouteEnabled;
    this.tracerouteEnabled = next;
    try {
      await fetchJSON('/config/traceroute.enabled', 'PUT', { value: next });
    } catch (e) {
      this.tracerouteEnabled = !next;
      this.showToast('Could not change traceroute', 'error', 4000);
    }
  },

  // Switch the active rotator device (v4/v5). Optimistic: reflect the choice
  // immediately; the WS stream confirms and supplies the detected variant.
  async selectRotatorTarget(name) {
    if (!name || name === this.rotatorStatus.active_target) return;
    // Switching device invalidates the old firmware's telemetry — reset so
    // variant-gated rows (v4 PWM, etc.) don't linger while the new device
    // reconnects. The WS stream repopulates + supplies the detected variant.
    // (rotatorTargets is separate stable state and is left intact.)
    this.rotatorStatus = { active_target: name };
    await fetchJSON('/rotator/active', 'POST', { name });
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

  // Adapt the device schema (flat {id,label,group,type,min,max,value}) into
  // buildForm object-groups keyed by `group` + nested data — the SAME builder
  // the radio config uses (no second form builder).
  _deviceSchemaGroups(schema) {
    const groups = {}, data = {};
    for (const c of schema) {
      const g = c.group || 'device';
      (groups[g] ??= []).push({ name: c.id, label: c.label, type: c.type === 'bool' ? 'bool' : 'int', min: c.min, max: c.max });
      (data[g] ??= {})[c.id] = c.type === 'bool' ? !!c.value : c.value;
    }
    const fields = Object.entries(groups).map(([name, f]) => ({ name, type: 'object', fields: f }));
    return { fields, data };
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

      const variant = this.rotatorStatus?.variant || 'v4';
      const useDevice = variant === 'v5' && Array.isArray(this.rotatorSchema) && this.rotatorSchema.length > 0;
      let fields, formData;
      if (useDevice) {
        // v5: build from the DEVICE's own grouped schema; append the node-dash
        // scan/actv groups (which the device doesn't own) from the hardcoded schema.
        const dev = this._deviceSchemaGroups(this.rotatorSchema);
        const extra = (schema.variants?.v5?.fields ?? schema.fields ?? []).filter(f => f.name === 'scan' || f.name === 'actv');
        fields = [...dev.fields, ...extra];
        formData = { ...dev.data, scan: data.scan, actv: data.actv };
      } else {
        // v4 (or before schema arrives): hardcoded per-variant fields.
        fields = schema.variants?.[variant]?.fields ?? schema.fields;
        formData = data;
      }
      this._rotatorCfgFields = fields;
      await nextFrame();
      const el = document.getElementById('rotator_cfg_form');
      if (el && !el.dataset.dirty) {
        el.innerHTML = '';
        el.dataset.formRoot = '1';
        el.dataset.variant = variant;
        el.dataset.device = useDevice ? '1' : '';
        el.appendChild(buildForm(fields, formData, []));
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
      const variant = this.rotatorStatus?.variant || 'v4';
      const fields = this._rotatorCfgFields
        ?? (this.rotatorCfgSchema.variants?.[variant]?.fields ?? this.rotatorCfgSchema.fields);
      const payload = collectForm(el, fields);

      if (el.dataset.device === '1') {
        // v5 device settings — set each CHANGED field via /rotator/config; the
        // device validates and returns { ok, msg, value }. Surface any ERRs.
        const errs = [];
        for (const c of (this.rotatorSchema ?? [])) {
          const g = c.group || 'device';
          const nv = payload[g]?.[c.id];
          if (nv == null) continue;
          const same = c.type === 'bool' ? ((nv ? 1 : 0) === c.value) : (Number(nv) === Number(c.value));
          if (same) continue;
          const value = c.type === 'bool' ? (nv ? 1 : 0) : Number(nv);
          const r = await fetchJSON('/rotator/config', 'POST', { id: c.id, value });
          if (!r?.ok) errs.push(`${c.label}: ${r?.msg ?? 'failed'}`);   // don't mutate reactive rotatorSchema
        }
        // scan/actv are node-dash config, not device settings.
        if (payload.scan || payload.actv) {
          await fetchJSON('/rotator/firmware_config', 'POST', { scan: payload.scan, actv: payload.actv });
        }
        el.removeAttribute('data-dirty');
        if (payload?.scan?.step_deg  != null) this.scanStep  = Number(payload.scan.step_deg);
        if (payload?.scan?.dwell_sec != null) this.scanDwell = Number(payload.scan.dwell_sec);
        if (payload?.actv?.dwell_sec != null) this.actvDwell = Number(payload.actv.dwell_sec);
        if (errs.length) { this.rotatorCfgError = errs.join('; '); }
        else { this.rotatorCfgSaved = true; setTimeout(() => { this.rotatorCfgSaved = false; }, 2000); }
      } else {
        // v4 hardcoded path — unchanged.
        await fetchJSON('/rotator/firmware_config', 'POST', payload);
        el.removeAttribute('data-dirty');
        if (payload?.scan?.step_deg  != null) this.scanStep  = Number(payload.scan.step_deg);
        if (payload?.scan?.dwell_sec != null) this.scanDwell = Number(payload.scan.dwell_sec);
        if (payload?.actv?.dwell_sec != null) this.actvDwell = Number(payload.actv.dwell_sec);
        this.rotatorCfgSaved = true;
        setTimeout(() => { this.rotatorCfgSaved = false; }, 2000);
      }
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
