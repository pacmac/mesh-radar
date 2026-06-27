// Radio/bridge/rotator configuration tabs mixin.
import { fetchJSON, nextFrame } from './app-helpers.js';
import { persistSet } from './app-persist.js';
import { buildForm, collectForm } from './app-forms.js';
import { submitOp } from './op-client.js';
import { opFlow } from './op-flow.js';

const SECTION_OP_KIND = {
  lora:           'radio_config_lora',
  device:         'radio_config_device',
  network:        'radio_config_network',
  bluetooth:      'radio_config_bluetooth',
  display:        'radio_config_display',
  power:          'radio_config_power',
  position:       'radio_config_position',
  security:       'radio_config_security',
  mqtt:           'module_config_mqtt',
  serial:         'module_config_serial',
  telemetry:      'module_config_telemetry',
  range_test:     'module_config_range_test',
  canned_message: 'module_config_canned_msg',
  neighbor_info:  'module_config_neighbor',
};

export const configMixin = {
  async loadConfig() {
    try {
      const cfg = await fetchJSON('/config');
      this.nodeFilters = {
        maxHops:   cfg['node_filters.max_hops']   ?? 99,
        maxAge:    cfg['node_filters.max_age']    ?? 0,
        namedOnly: cfg['node_filters.named_only'] ?? false,
        hasPos:    cfg['node_filters.has_pos']    ?? false,
        hideMqtt:  cfg['node_filters.hide_mqtt']  ?? false,
        hasSignal: cfg['node_filters.has_signal'] ?? false,
        hasTelem:  cfg['node_filters.has_telem']  ?? false,
        msgOnly:   cfg['node_filters.msg_only']   ?? false,
        nodeRoles: cfg['node_filters.roles']      ?? [],
      };
      this.nodeSource     = cfg['node_filters.node_source'] ?? 'both';
      this.radarRange     = String(cfg['radar.max_range_km'] ?? 50);
      this.radarLogScale  = cfg['radar.log_scale']  ?? false;
      this.radarCrosshair = cfg['radar.crosshair']  ?? true;
      this.packetSources  = cfg['packet_sources']   ?? [];
      if (cfg['range_test.duration']) this.rangeDuration = cfg['range_test.duration'];
    } catch (e) {
      console.warn('Failed to load config', e);
    }
  },

  switchCfgTab(name) {
    this.cfgTab = name;
    persistSet('cfgTab', name);
    if (name === 'radio') {
      if (this.radioTab === 'device')        this.loadSections();
      else if (this.radioTab === 'channels') this.loadChannels();
      else if (this.radioTab === 'owner')    this.loadOwner();
    } else if (name === 'bridge')  this.loadBridgeConfig();
    else if (name === 'rotator')   this.loadRotatorCfg();
    else if (name === 'radar')     this.loadRadarCfg();
    else if (name === 'alerts')    this.loadAlertRules();
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
    await submitOp('fixed_position_push', target, body);
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
    const payload = collectForm(el, sec.schema.fields);
    const kind = SECTION_OP_KIND[sec.name];
    if (!kind) throw new Error(`No op kind for section: ${sec.name}`);
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp(kind, target, payload);
    // Refresh the form UI with the verified server state
    const values = await fetchJSON(this.cd(`/config/${sec.name}`));
    sec.data = values[sec.name] || values || {};
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
      const live = await fetchJSON(this.cd(`/channels/${ch.index}`));
      ch.data = live || {};
      const formData = { ...(live?.settings || {}), role: live?.role };
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
    const body = { settings: { ...payload }, role: payload.role, index: ch.index };
    delete body.settings.role;
    const target = this.cfgRadioId || this.activeNodeId;
    await submitOp('channel_config', target, body);
    // Refresh the form UI
    const live = await fetchJSON(this.cd(`/channels/${ch.index}`));
    ch.data = live || {};
    const formData = { ...(live?.settings || {}), role: live?.role };
    const formEl = document.getElementById('ch_' + ch.index);
    if (formEl && !formEl.dataset.dirty) {
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
    await submitOp('owner_info', target, payload);
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
      await opFlow('bridge_config', null, payload, { successMsg: 'Bridge config saved' });
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
      await opFlow('alert_config', null, payload, { successMsg: 'SMTP settings saved' });
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
      await opFlow('alert_config', null, { [key]: value }, { successMsg: null });
      const field = key.replace('alerts.smtp_', '').replace('alerts.imap_', 'imap_');
      if (this.alertSmtp) this.alertSmtp[field] = value;
    } catch (_) {} // opFlow already showed the error toast
  },

  async updateAlertRule(type, changes) {
    try {
      await opFlow('alert_rule', type, changes, { successMsg: null });
      const r = this.alertRules.find(x => x.type === type);
      if (r) Object.assign(r, changes);
    } catch (_) {} // opFlow already showed the error toast
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
      await opFlow('radar_config', null, this.radarCfg, { successMsg: 'Radar config saved' });
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
