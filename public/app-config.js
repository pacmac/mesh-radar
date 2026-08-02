// Radio/bridge/rotator configuration tabs mixin.
import { fetchJSON, nextFrame } from './app-helpers.js';
import { persistSet } from './app-persist.js';
import { buildForm, collectForm } from './app-forms.js';
import { submitOp } from './op-client.js';
import { opFlow } from './op-flow.js';

// A channel PUT replaces ChannelSettings rather than patching it, so values the
// form omitted have to come from somewhere and the route index stays out of the
// body.
//
// THE PSK IS NEVER SUPPLIED FROM THE CACHE — it is refused instead. This
// function used to fill a locked PSK in from `current.settings`, which reads as
// obviously right and destroyed the key it was protecting (task
// `channel-config-editor-broken`, 2026-08-01). Four links, each fine alone:
// app-forms.js:107 renders a sensitive field disabled; :158 skips disabled
// inputs when collecting; this function backfilled the gap from `current`; and
// `current` is mesh-gw's channel cache, which is STALE UNTIL THE RADIO
// RECONNECTS. Measured that day, 50 minutes after a successful write: the OMNI's
// radio held `AQ==` — proven on air, 19 public nodes heard after 24 hours of
// none — while the cached channel had no psk at all. Saving ANY field on that
// form would have written an empty key and put the radio back on a channel the
// public mesh cannot decode. Peter had just spent ten days off the air for
// exactly that reason.
//
// `psk in edited` is the whole test, and it is testing OMITTED vs DELIBERATELY
// EMPTY. An unencrypted channel is a legal Meshtastic configuration, so unlock
// and clear is still allowed; unlock is what makes it the operator's choice
// rather than the cache's. Gated on role because a DISABLED slot has no key to
// protect and the five empty ones stay one-click editable.
export function channelWriteBody(current, edited) {
  const role = edited.role ?? current?.role ?? 'DISABLED';
  if (role !== 'DISABLED' && !('psk' in edited)) {
    throw new Error(
      'Unlock the PSK field and enter the key before saving. What is shown comes ' +
      'from mesh-gw’s cache, which is stale until the radio reconnects — an empty ' +
      'box does not mean the radio has no key. Saving without supplying one would ' +
      'write an empty key and take this radio off its channel.');
  }
  const settings = { ...(current?.settings || {}), ...edited };
  delete settings.role;
  return { settings, role };
}

export const configMixin = {
  // loadConfig is gone — settings arrive on the WS 'settings' event
  // (settings-via-ws): replayed on connect, re-broadcast on config writes.

  switchCfgTab(name) {
    this.cfgTab = name;
    persistSet('cfgTab', name);
    // 'radio' is no longer a Config tab — the per-radio config lives on the
    // Devices page (radio-config-into-devices), which calls resetRadioCfg().
    if (name === 'bridge')         this.loadBridgeConfig();
    else if (name === 'rotator')   this.loadRotatorCfg();
    else if (name === 'modes')     this.loadModesCfg();
    else if (name === 'radar')     this.loadRadarCfg();
    else if (name === 'alerts')    this.loadAlertRules();
  },

  // Per-mode radio roles (config-editor form flow — GET populates, PUT submits).
  async loadModesCfg() {
    try {
      this.modesCfg = await fetchJSON('/config/modes');
    } catch (e) {
      console.warn('loadModesCfg failed', e);
    }
  },

  async saveModesCfg() {
    this.modesCfgSaving = true;
    this.modesCfgSaved  = false;
    this.modesCfgError  = '';
    try {
      this.modesCfg = await fetchJSON('/config/modes', 'PUT', this.modesCfg);
      this.modesCfgSaved = true;
      setTimeout(() => { this.modesCfgSaved = false; }, 3000);
    } catch (e) {
      this.modesCfgError = e.message || 'Save failed';
      setTimeout(() => { this.modesCfgError = ''; }, 5000);
    } finally {
      this.modesCfgSaving = false;
    }
  },

  resetRadioCfg() {
    this.allSections  = [];
    this.channels     = [];
    this.channelSchema = null;
    this.ownerSchema  = null;
    this.fixedPosition = { lat: null, lon: null, alt: null, loaded: false, saved: false, error: '' };
    if (this.radioTab === 'device')        this.loadSections();
    else if (this.radioTab === 'channels') this.loadChannels();
    else if (this.radioTab === 'owner')    this.loadOwner();
  },

  async loadSections() {
    if (this.allSections.length) return;
    const sec = await fetchJSON('/sections');
    const meta = sec.meta || {};
    const makeSec = (name, kind) => ({
      name, kind, loaded: false, loading: false, saved: false, error: '',
      rebootRequired: !!(meta[name]?.__reboot),
      notes: meta[name]?.__notes || [],
    });
    this.allSections = [
      ...sec.config.map(name => makeSec(name, 'config')),
      ...sec.module_config.map(name => makeSec(name, 'module_config')),
    ].sort((a, b) => a.name.localeCompare(b.name));
  },

  async onSectionToggle(sec) {
    if (sec.loaded || sec.loading) return;
    sec.loading = true;
    try {
      const [schema, values] = await Promise.all([
        fetchJSON(`/schema/${sec.name}`),
        fetchJSON(this.cd(`/config/${sec.name}`)),
      ]);
      sec.schema = schema;
      sec.data = values[sec.name] || values || {};
      await nextFrame();
      const el = document.getElementById('sec_' + sec.name);
      if (!el.dataset.dirty) {
        el.innerHTML = '';
        el.dataset.formRoot = '1';
        el.appendChild(buildForm(schema.fields, sec.data, []));
      }
      sec.loaded = true;
      if (sec.name === 'position' && !this.fixedPosition.loaded) await this.loadFixedPosition();
    } catch (e) {
      sec.error = 'Failed to load: ' + e;
    } finally {
      sec.loading = false;
    }
  },

  async loadFixedPosition() {
    this.fixedPosition.error = '';
    try {
      const res = await fetchJSON(this.cd('/fixed_position'));
      const pos = res.position || {};
      this.fixedPosition.lat = pos.latitude_i  != null ? pos.latitude_i  / 1e7 : null;
      this.fixedPosition.lon = pos.longitude_i != null ? pos.longitude_i / 1e7 : null;
      this.fixedPosition.alt = pos.altitude ?? null;
      this.fixedPosition.loaded = true;
    } catch (e) {
      this.fixedPosition.error = 'Failed to load: ' + e;
    }
  },

  async saveFixedPosition() {
    if (this.fixedPosition.lat == null || this.fixedPosition.lon == null)
      throw new Error('Latitude and longitude are required');
    const body = {
      latitude_i:  Math.round(this.fixedPosition.lat * 1e7),
      longitude_i: Math.round(this.fixedPosition.lon * 1e7),
    };
    if (this.fixedPosition.alt != null && this.fixedPosition.alt !== '')
      body.altitude = Math.round(this.fixedPosition.alt);
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('fixed_position_push', target, { values: body });
  },

  async clearFixedPosition() {
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('fixed_position_clear', target, {});
    this.fixedPosition.lat = null;
    this.fixedPosition.lon = null;
    this.fixedPosition.alt = null;
  },

  async saveSection(sec) {
    const el = document.getElementById('sec_' + sec.name);
    const formValues = collectForm(el, sec.schema.fields);
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('radio_config_section', target, { section: sec.name, values: formValues });
    // Refresh the form UI with the verified server state
    const fresh = await fetchJSON(this.cd(`/config/${sec.name}`));
    sec.data = fresh[sec.name] || fresh || {};
    const formEl = document.getElementById('sec_' + sec.name);
    if (formEl && !formEl.dataset.dirty) {
      formEl.innerHTML = '';
      formEl.appendChild(buildForm(sec.schema.fields, sec.data, []));
    }
  },

  async loadChannels() {
    if (this.channels.length) return;
    this.channels = Array.from({ length: 8 }, (_, i) => ({
      index: i, loaded: false, loading: false, saved: false, error: '', data: {},
    }));
    try {
      const all = await fetchJSON(this.cd('/channels'));
      for (const ch of this.channels) {
        const c = all.channels?.[String(ch.index)];
        if (c) ch.data = c;
      }
    } catch (_) {}
  },

  async onChannelToggle(ch) {
    if (ch.loaded || ch.loading) return;
    ch.loading = true;
    try {
      if (!this.channelSchema) this.channelSchema = await fetchJSON('/schema/channel');
      // Build from the bulk-loaded channel set (loadChannels) — the
      // per-channel GET does a live admin round-trip the form doesn't need
      // (channels-form-from-bulk; it also 500s on the current gw).
      const formData = { ...(ch.data?.settings || {}), role: ch.data?.role };
      await nextFrame();
      const el = document.getElementById('ch_' + ch.index);
      if (!el.dataset.dirty) {
        el.innerHTML = '';
        el.dataset.formRoot = '1';
        el.appendChild(buildForm(this.channelSchema.fields, formData, []));
      }
      ch.loaded = true;
    } catch (e) {
      ch.error = 'Failed to load: ' + e;
    } finally {
      ch.loading = false;
    }
  },

  async saveChannel(ch) {
    const el = document.getElementById('ch_' + ch.index);
    const payload = collectForm(el, this.channelSchema.fields);
    const body = channelWriteBody(ch.data, payload);
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('channel_config', target, { index: ch.index, values: body });
    // mesh-gw's channel cache is stale until reconnect even after a completed
    // BLE write. Keep the accepted full replacement locally instead of
    // immediately overwriting it with the pre-write cached value.
    ch.data = { ...(ch.data || {}), ...body };
    const formData = { ...(ch.data?.settings || {}), role: ch.data?.role };
    const formEl = document.getElementById('ch_' + ch.index);
    if (formEl) {
      delete formEl.dataset.dirty;
      formEl.innerHTML = '';
      formEl.dataset.formRoot = '1';
      formEl.appendChild(buildForm(this.channelSchema.fields, formData, []));
    }
  },

  async loadOwner() {
    if (this.ownerSchema) return;
    this.ownerSchema = await fetchJSON('/schema/owner');
    this.ownerData = await fetchJSON(this.cd('/owner'));
    await nextFrame();
    const el = document.getElementById('owner_form');
    el.innerHTML = '';
    const editable   = ['long_name', 'short_name', 'is_licensed', 'role', 'is_unmessagable'];
    const readonly   = ['id', 'macaddr', 'hw_model', 'public_key'];
    const editFields = this.ownerSchema.fields.filter(f => editable.includes(f.name));
    const roFields   = this.ownerSchema.fields.filter(f => readonly.includes(f.name));
    el.appendChild(buildForm(editFields, this.ownerData, []));
    const ro = document.createElement('div');
    ro.className = 'divider text-xs';
    ro.textContent = 'read-only';
    el.appendChild(ro);
    el.appendChild(buildForm(roFields, this.ownerData, [], { readonly: true }));
  },

  async saveOwner() {
    const el = document.getElementById('owner_form');
    const payload = collectForm(el, this.ownerSchema.fields.filter(f =>
      ['long_name', 'short_name', 'is_licensed', 'role', 'is_unmessagable'].includes(f.name)));
    // proto3 omits default enum values (role CLIENT=0 absent means CLIENT).
    // Only include role in payload if it genuinely changed to avoid spurious reboots.
    const currentRole = this.ownerData?.role ?? 'CLIENT';
    if (payload.role === currentRole) delete payload.role;
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('owner_info', target, { values: payload });
  },

  async loadBridgeConfig() {
    try {
      const [schema, data] = await Promise.all([
        fetchJSON('/schema/bridge_config'),
        fetchJSON('/bridge_config'),
      ]);
      this.bridgeConfigSchema = schema;
      await nextFrame();
      const el = document.getElementById('bridge_cfg_form');
      if (el && !el.dataset.dirty) {
        el.innerHTML = '';
        el.dataset.formRoot = '1';
        el.appendChild(buildForm(schema.fields, data, []));
      }
    } catch (e) {
      console.warn('Failed to load bridge config', e);
    }
  },

  async saveBridgeConfig() {
    this.bridgeConfigSaved = false;
    this.bridgeConfigError = '';
    try {
      const el = document.getElementById('bridge_cfg_form');
      const payload = collectForm(el, this.bridgeConfigSchema.fields);
      await opFlow('bridge_config', null, { values: payload }, { successMsg: 'Bridge config saved' });
      el.removeAttribute('data-dirty');
      this.bridgeConfigSaved = true;
      setTimeout(() => { this.bridgeConfigSaved = false; }, 2000);
    } catch (e) {
      this.bridgeConfigError = String(e);
    }
  },

  // -- Alerts ------------------------------------------------------------------

  async loadAlertRules() {
    try {
      const [rules, smtp] = await Promise.all([
        fetchJSON('/alerts/rules'),
        fetchJSON('/alerts/config'),
      ]);
      this.alertRules = rules;
      this.alertSmtp = {
        host:      smtp['alerts.smtp_host'] ?? '',
        port:      smtp['alerts.smtp_port'] ?? 587,
        user:      smtp['alerts.smtp_user'] ?? '',
        pass:      smtp['alerts.smtp_pass'] ?? '',
        from:      smtp['alerts.smtp_from'] ?? '',
        to:        smtp['alerts.smtp_to']   ?? '',
        imap_host: smtp['alerts.imap_host'] ?? '',
        imap_port: smtp['alerts.imap_port'] ?? 993,
      };
    } catch (e) {
      console.warn('loadAlertRules failed', e);
    }
  },

  async saveSmtpAll() {
    const r = this.$refs;
    const payload = {
      'alerts.smtp_host': r.smtpHost?.value ?? '',
      'alerts.smtp_port': Number(r.smtpPort?.value ?? 465),
      'alerts.smtp_user': r.smtpUser?.value ?? '',
      'alerts.smtp_pass': r.smtpPass?.value ?? '',
      'alerts.smtp_from': r.smtpFrom?.value ?? '',
      'alerts.smtp_to':   r.smtpTo?.value   ?? '',
      'alerts.imap_host': r.imapHost?.value  ?? '',
      'alerts.imap_port': Number(r.imapPort?.value ?? 993),
    };
    this.alertSmtpSaving = true;
    this.alertSmtpSaved  = false;
    this.alertSmtpError  = '';
    try {
      await opFlow('alert_config', null, { values: payload }, { successMsg: 'SMTP settings saved' });
      Object.assign(this.alertSmtp, {
        host: payload['alerts.smtp_host'], port: payload['alerts.smtp_port'],
        user: payload['alerts.smtp_user'], pass: payload['alerts.smtp_pass'],
        from: payload['alerts.smtp_from'], to:   payload['alerts.smtp_to'],
        imap_host: payload['alerts.imap_host'], imap_port: payload['alerts.imap_port'],
      });
      this.alertSmtpSaved = true;
      setTimeout(() => { this.alertSmtpSaved = false; }, 3000);
    } catch (e) {
      this.alertSmtpError = e.message || 'Save failed';
      setTimeout(() => { this.alertSmtpError = ''; }, 5000);
    } finally {
      this.alertSmtpSaving = false;
    }
  },

  async saveSmtp(key, value) {
    try {
      await opFlow('alert_config', null, { values: { [key]: value } }, { successMsg: null });
      const field = key.replace('alerts.smtp_', '').replace('alerts.imap_', 'imap_');
      if (this.alertSmtp) this.alertSmtp[field] = value;
    } catch (_) {} // opFlow already showed the error toast
  },

  async updateAlertRule(type, changes) {
    try {
      await opFlow('alert_rule', type, { values: changes }, { successMsg: null });
      const r = this.alertRules.find(x => x.type === type);
      if (r) Object.assign(r, changes);
    } catch (_) {} // opFlow already showed the error toast
  },

  /** Discovery strategy settings. Same shape as loadRadarCfg/saveRadarCfg below.
   *
   *  Fetched on first view rather than pushed: this is a FORM FLOW, which
   *  BROWSER_CONTRACT permits a GET for — the page-data rule is about display
   *  values, not about the current contents of a settings form the user is
   *  about to edit. Every value is clamped server-side; the min/max on the
   *  inputs are a courtesy, not the validation. */
  discoveryCfg: null,
  discoveryCfgSaving: false,
  discoveryCfgSaved: false,
  discoveryCfgError: '',

  async loadDiscoveryCfg() {
    try {
      this.discoveryCfg = await fetchJSON('/config/discovery');
    } catch (e) {
      console.warn('loadDiscoveryCfg failed', e);
    }
  },

  async saveDiscoveryCfg() {
    this.discoveryCfgSaving = true;
    this.discoveryCfgSaved  = false;
    this.discoveryCfgError  = '';
    try {
      await opFlow('discovery_config', null, { values: this.discoveryCfg }, { successMsg: 'Discovery settings saved' });
      // Re-read rather than trusting the form: the server clamps, so what was
      // typed and what was stored are not always the same value.
      await this.loadDiscoveryCfg();
      this.discoveryCfgSaved = true;
      setTimeout(() => { this.discoveryCfgSaved = false; }, 3000);
    } catch (e) {
      this.discoveryCfgError = e.message || 'Save failed';
      setTimeout(() => { this.discoveryCfgError = ''; }, 5000);
    } finally {
      this.discoveryCfgSaving = false;
    }
  },

  async loadRadarCfg() {
    try {
      this.radarCfg = await fetchJSON('/config/radar');
    } catch (e) {
      console.warn('loadRadarCfg failed', e);
    }
  },

  async saveRadarCfg() {
    this.radarCfgSaving = true;
    this.radarCfgSaved  = false;
    this.radarCfgError  = '';
    try {
      await opFlow('radar_config', null, { values: this.radarCfg }, { successMsg: 'Radar config saved' });
      this.radarCfgSaved = true;
      setTimeout(() => { this.radarCfgSaved = false; }, 3000);
    } catch (e) {
      this.radarCfgError = e.message || 'Save failed';
      setTimeout(() => { this.radarCfgError = ''; }, 5000);
    } finally {
      this.radarCfgSaving = false;
    }
  },

  async sendTestAlert() {
    this.alertTestSending = true;
    this.alertTestResult = '';
    try {
      await submitOp('send_alert_test', null, {});
      this.alertTestOk = true;
      this.alertTestResult = 'Sent!';
    } catch (e) {
      this.alertTestOk = false;
      this.alertTestResult = e.message || 'Failed';
    } finally {
      this.alertTestSending = false;
      setTimeout(() => { this.alertTestResult = ''; }, 4000);
    }
  },
};
