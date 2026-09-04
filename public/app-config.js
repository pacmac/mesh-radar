// Bridge/modes/radar/callout/discovery/alerts configuration tabs mixin.
// Per-radio config editing (sections, channels, owner, fixed position) and
// rotator config (device switch, firmware settings, calibration) are both
// gone — mesh-gw owns device configuration now (2026-09-03/04, tasks
// devices-management-removed-meshgw-owns-it and
// rotator-config-tab-removed-meshgw-owns-it).
import { fetchJSON, nextFrame } from './app-helpers.js';
import { persistSet } from './app-persist.js';
import { buildForm, collectForm } from './app-forms.js';
import { submitOp } from './op-client.js';
import { opFlow } from './op-flow.js';

export const configMixin = {
  // loadConfig is gone — settings arrive on the WS 'settings' event
  // (settings-via-ws): replayed on connect, re-broadcast on config writes.

  switchCfgTab(name) {
    this.cfgTab = name;
    persistSet('cfgTab', name);
    if (name === 'bridge')         this.loadBridgeConfig();
    else if (name === 'modes')     this.loadModesCfg();
    else if (name === 'radar')     this.loadRadarCfg();
    else if (name === 'alerts')    this.loadAlertRules();
  },

  // Per-mode radio roles (config-editor form flow — GET populates, PUT submits).
  async loadModesCfg() {
    try {
      // Both, together: the values AND the vocabulary that describes them. The
      // page holds no list of its own — Peter, 2026-08-04: "do NOT break the UI
      // golden rule."
      const [cfg, vocab] = await Promise.all([
        fetchJSON('/config/modes'),
        fetchJSON('/config/mode-vocabulary'),
      ]);
      this.modesCfg  = cfg;
      this.modeVocab = vocab;
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

  // ── CALLOUT ────────────────────────────────────────────────────────────────
  // Peter, 2026-08-03: "i dont see anything in the dashboard configs for the
  // token based ping messages?" There was nothing — the templates lived only in
  // code, which makes "define custom ping text" untrue.
  calloutCfg: null,
  calloutCfgSaving: false,
  calloutCfgSaved: false,
  calloutCfgError: '',

  async loadCalloutCfg() {
    try {
      this.calloutCfg = await fetchJSON('/config/callout');
    } catch (e) {
      console.warn('loadCalloutCfg failed', e);
    }
  },

  /** The transmit switch acts IMMEDIATELY — it does not wait for Save.
   *
   *  Peter, 2026-08-05: "I switched off callout broadcasts but it's still
   *  broadcasting". The toggle was x-model only, so the server was written
   *  solely by the Save button: the switch read "off" while the radio kept
   *  transmitting on the PUBLIC mesh, three times in the two hours after he
   *  turned it off. A UI that shows "off" over a live transmitter is worse than
   *  one with no switch at all.
   *
   *  Sends ONLY `enabled`, never the whole form — the route treats absent keys
   *  as unchanged, so a half-edited template or an in-progress number field
   *  cannot be committed as a side effect of hitting the kill switch.
   *
   *  Re-reads afterwards rather than trusting the click, and reverts the toggle
   *  if the write failed, so the switch never disagrees with the transmitter. */
  async setCalloutEnabled(on) {
    const want = !!on;
    this.calloutCfgError = '';
    try {
      await fetchJSON('/config/callout', 'PUT', { values: { enabled: want } });
      await this.loadCalloutCfg();
      if (this.calloutCfg.enabled !== want) {
        this.calloutCfgError = 'The server did not accept that change.';
      }
    } catch (e) {
      this.calloutCfg.enabled = !want;         // never show off while it transmits
      this.calloutCfgError = `Could not turn callouts ${want ? 'on' : 'off'}: ${e.message}`;
      setTimeout(() => { this.calloutCfgError = ''; }, 6000);
    }
  },

  async saveCalloutCfg() {
    this.calloutCfgSaving = true;
    this.calloutCfgSaved  = false;
    this.calloutCfgError  = '';
    try {
      // fetchJSON(url, method, body) — NOT a fetch-options object. Writing it
      // the fetch way threw "'[object Object]' is not a valid HTTP method",
      // which is why the round-trip is tested rather than assumed.
      await fetchJSON('/config/callout', 'PUT', { values: this.calloutCfg });
      // Re-read rather than trusting the form. The server clamps to the hard
      // ceilings, so 9999 sends/day comes back as 12 — and the page must show
      // what will actually happen, not what was asked for.
      await this.loadCalloutCfg();
      this.calloutCfgSaved = true;
      setTimeout(() => { this.calloutCfgSaved = false; }, 3000);
    } catch (e) {
      this.calloutCfgError = e.message || 'Save failed';
      setTimeout(() => { this.calloutCfgError = ''; }, 5000);
    } finally {
      this.calloutCfgSaving = false;
    }
  },

  addCalloutTemplate() {
    if (!this.calloutCfg) return;
    this.calloutCfg.templates.push({ text: '@%short_name% ', ttl_days: 21 });
  },

  removeCalloutTemplate(i) {
    if (!this.calloutCfg || this.calloutCfg.templates.length <= 1) return;
    this.calloutCfg.templates.splice(i, 1);
  },

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
