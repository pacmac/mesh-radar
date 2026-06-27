/**
 * OpManager — unified save-and-validate lifecycle for all dashboard write actions.
 *
 * Architecture:
 *   POST /op  →  {op_id}  +  async state machine  →  config_op WS events
 *   GET  /ops/manifest  →  full registry (drives test_ops.py)
 *
 * Three runner classes (stubs in step 2; real implementations in steps 3-5):
 *   LocalRunner  — DB/config writes + synchronous read-back
 *   RadioRunner  — BLE writes + opportunistic reboot detection + read-back
 *   ModeRunner   — action triggers + WS postcondition monitoring
 *
 * State machine: idle → saving → [rebooting?] → validating → success | error
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Op registry
// ─────────────────────────────────────────────────────────────────────────────
//
// Each entry:
//   class:           'Local' | 'Radio' | 'Mode'
//   description:     human-readable label
//   method:          HTTP method for the write
//   endpoint:        (params) => path string (relative to node-dash base)
//   read_back_path:  (params) => path string for GET after write; null for Mode ops
//   match_fields:    field names to compare in read-back; [] = any 2xx = success
//   example_payload: safe test payload used by test_ops.py
//   timeout_s:       max seconds for the full operation
//   reboot:          false | 'never' | 'always' | 'conditional' (Radio only)

const REGISTRY = new Map([

  // ── Class 1 — Local ───────────────────────────────────────────────────────

  ['device_config_label', {
    class: 'Local', description: 'Device alias label',
    method: 'PUT', endpoint: p => `/device-config/${p.target}`,
    read_back_path: p => `/device-config/${p.target}`, match_fields: ['label'],
    example_payload: { target: '!2687afb1', values: { label: 'OpTest' } },
    timeout_s: 5, reboot: false,
  }],
  ['device_config_color', {
    class: 'Local', description: 'Device UI colour tag',
    method: 'PUT', endpoint: p => `/device-config/${p.target}`,
    read_back_path: p => `/device-config/${p.target}`, match_fields: ['color'],
    example_payload: { target: '!2687afb1', values: { color: 'blue' } },
    timeout_s: 5, reboot: false,
  }],
  ['device_config_primary', {
    class: 'Local', description: 'Set primary device flag',
    method: 'PUT', endpoint: p => `/device-config/${p.target}`,
    read_back_path: p => `/device-config/${p.target}`, match_fields: ['is_primary'],
    example_payload: { target: '!2687afb1', values: { is_primary: true } },
    timeout_s: 5, reboot: false,
  }],
  ['ble_auto_connect', {
    class: 'Local', description: 'BLE auto-connect toggle',
    method: 'PATCH', endpoint: p => `/ble_devices/${p.target}`,
    read_back_path: () => '/bridge_config', match_fields: [],
    example_payload: { target: 'E9:B0:3F:17:27:91', values: { auto_connect: true } },
    timeout_s: 5, reboot: false,
  }],
  ['antenna_config', {
    class: 'Local', description: 'Antenna type, beam, gain, cable loss',
    method: 'PUT', endpoint: p => `/device-config/${p.target}`,
    read_back_path: p => `/device-config/${p.target}`,
    match_fields: ['antenna_type', 'beam_deg', 'gain_dbi', 'cable_loss_db'],
    example_payload: { target: '!2687afb1', values: { antenna_type: 'yagi', beam_deg: 30, gain_dbi: 8, cable_loss_db: 1 } },
    timeout_s: 5, reboot: false,
  }],
  ['home_position', {
    class: 'Local', description: 'Rotator home position (lat/lon)',
    method: 'PUT', endpoint: p => `/device-config/${p.target}`,
    read_back_path: p => `/device-config/${p.target}`,
    match_fields: ['fixed_lat', 'fixed_lon'],
    example_payload: { target: '!2687afb1', values: { fixed_lat: 51.5074, fixed_lon: -0.1278 } },
    timeout_s: 5, reboot: false,
  }],
  ['bridge_config', {
    class: 'Local', description: 'Bridge (mesh-gw) configuration',
    method: 'PUT', endpoint: () => '/bridge_config',
    read_back_path: () => '/bridge_config', match_fields: [],
    example_payload: { target: null, values: { admin_passkey_refresh_s: 240 } },
    timeout_s: 5, reboot: false,
  }],
  ['alert_config', {
    class: 'Local', description: 'Alert SMTP/IMAP settings',
    method: 'PUT', endpoint: () => '/alerts/config',
    read_back_path: () => '/alerts/config', match_fields: [],
    example_payload: { target: null, values: { 'alerts.smtp_port': 587 } },
    timeout_s: 5, reboot: false,
  }],
  ['alert_rule', {
    class: 'Local', description: 'Alert rule (enabled/threshold/cooldown)',
    method: 'PUT', endpoint: p => `/alerts/rules/${p.target}`,
    read_back_path: () => '/alerts/rules', match_fields: [],
    example_payload: { target: 'node_offline', values: { enabled: true, threshold: 0, cooldown_minutes: 60 } },
    timeout_s: 5, reboot: false,
  }],
  ['auto_purge_settings', {
    class: 'Local', description: 'Scheduled auto-purge settings',
    method: 'PUT', endpoint: () => '/auto-purge',
    read_back_path: p => `/auto-purge?device=${p.target}`, match_fields: ['enabled', 'purge_time'],
    example_payload: { target: '!2687afb1', values: { device: '!2687afb1', enabled: true, purge_time: '02:00' } },
    timeout_s: 5, reboot: false,
  }],
  ['mqtt_publish_config', {
    class: 'Local', description: 'MQTT publish settings',
    method: 'PUT', endpoint: () => '/mqtt_publish',
    read_back_path: () => '/mqtt_publish', match_fields: [],
    example_payload: { target: null, values: { enabled: false } },
    timeout_s: 5, reboot: false,
  }],
  ['tilt_cal', {
    class: 'Local', description: 'Tilt sensor calibration offsets',
    method: 'PUT', endpoint: () => '/tilt_cal',
    read_back_path: () => '/tilt_cal', match_fields: ['zero', 'north_angle'],
    example_payload: { target: null, values: { zero: 0, north_angle: 0 } },
    timeout_s: 5, reboot: false,
  }],
  ['clear_range_test_log', {
    class: 'Local', description: 'Clear range test log',
    method: 'DELETE', endpoint: () => '/range_test/log',
    read_back_path: () => '/range_test/log', match_fields: [],
    example_payload: { target: null, values: {} },
    timeout_s: 5, reboot: false,
  }],

  // ── Class 2 — Radio ───────────────────────────────────────────────────────
  // RadioRunner: write → optional reboot wait → read-back compare
  // Reboot is detected opportunistically (wait 3s for device_state OFFLINE/RECONNECTING)

  ['radio_config_lora', {
    class: 'Radio', description: 'LoRa radio config section',
    method: 'PUT', endpoint: p => `/${p.target}/config/lora`,
    read_back_path: p => `/${p.target}/config/lora`, match_fields: ['modem_preset', 'region', 'hop_limit'],
    example_payload: { target: '!2687afb1', values: { hop_limit: 3 } },
    timeout_s: 60, reboot: 'conditional',
  }],
  ['radio_config_device', {
    class: 'Radio', description: 'Device role and GPIO config',
    method: 'PUT', endpoint: p => `/${p.target}/config/device`,
    read_back_path: p => `/${p.target}/config/device`, match_fields: ['role', 'rebroadcast_mode'],
    example_payload: { target: '!2687afb1', values: { rebroadcast_mode: 'ALL' } },
    timeout_s: 60, reboot: 'conditional',
  }],
  ['radio_config_network', {
    class: 'Radio', description: 'Network (WiFi/Ethernet) config — always reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/network`,
    read_back_path: p => `/${p.target}/config/network`, match_fields: ['wifi_enabled'],
    example_payload: { target: '!2687afb1', values: { wifi_enabled: false } },
    timeout_s: 60, reboot: 'always',
  }],
  ['radio_config_bluetooth', {
    class: 'Radio', description: 'Bluetooth config — always reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/bluetooth`,
    read_back_path: p => `/${p.target}/config/bluetooth`, match_fields: ['enabled', 'mode'],
    example_payload: { target: '!2687afb1', values: { mode: 'RANDOM_PIN' } },
    timeout_s: 60, reboot: 'always',
  }],
  ['radio_config_display', {
    class: 'Radio', description: 'Display config',
    method: 'PUT', endpoint: p => `/${p.target}/config/display`,
    read_back_path: p => `/${p.target}/config/display`, match_fields: ['screen_on_secs', 'flip_screen'],
    example_payload: { target: '!2687afb1', values: { screen_on_secs: 300 } },
    timeout_s: 60, reboot: 'conditional',
  }],
  ['radio_config_power', {
    class: 'Radio', description: 'Power management config',
    method: 'PUT', endpoint: p => `/${p.target}/config/power`,
    read_back_path: p => `/${p.target}/config/power`, match_fields: [],
    example_payload: { target: '!2687afb1', values: { is_power_saving: false } },
    timeout_s: 60, reboot: 'conditional',
  }],
  ['radio_config_position', {
    class: 'Radio', description: 'GPS/position config — always reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/position`,
    read_back_path: p => `/${p.target}/config/position`, match_fields: [],
    example_payload: { target: '!2687afb1', values: { gps_mode: 'ENABLED' } },
    timeout_s: 60, reboot: 'always',
  }],
  ['module_config_mqtt', {
    class: 'Radio', description: 'MQTT module config — never reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/mqtt`,
    read_back_path: p => `/${p.target}/config/mqtt`, match_fields: ['enabled'],
    example_payload: { target: '!2687afb1', values: { enabled: false } },
    timeout_s: 15, reboot: 'never',
  }],
  ['module_config_telemetry', {
    class: 'Radio', description: 'Telemetry module config — never reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/telemetry`,
    read_back_path: p => `/${p.target}/config/telemetry`, match_fields: ['device_update_interval'],
    example_payload: { target: '!2687afb1', values: { device_update_interval: 900 } },
    timeout_s: 15, reboot: 'never',
  }],
  ['module_config_neighbor', {
    class: 'Radio', description: 'Neighbor info module config — never reboots',
    method: 'PUT', endpoint: p => `/${p.target}/config/neighbor_info`,
    read_back_path: p => `/${p.target}/config/neighbor_info`, match_fields: ['enabled'],
    example_payload: { target: '!2687afb1', values: { enabled: true } },
    timeout_s: 15, reboot: 'never',
  }],
  ['channel_config', {
    class: 'Radio', description: 'Channel settings and role',
    method: 'PUT', endpoint: p => `/${p.target}/channels/${p.index}`,
    read_back_path: p => `/${p.target}/channels/${p.index}`, match_fields: ['role'],
    example_payload: { target: '!2687afb1', index: 0, values: { role: 'PRIMARY' } },
    timeout_s: 15, reboot: false,
  }],
  ['owner_info', {
    class: 'Radio', description: 'Device owner (name, short name, licensed)',
    method: 'PUT', endpoint: p => `/${p.target}/owner`,
    read_back_path: p => `/${p.target}/owner`, match_fields: ['long_name', 'short_name'],
    example_payload: { target: '!2687afb1', values: { long_name: 'Test Node', short_name: 'TN1' } },
    timeout_s: 15, reboot: false,
  }],
  ['fixed_position_push', {
    class: 'Radio', description: 'Push fixed position to device',
    method: 'PUT', endpoint: p => `/${p.target}/fixed_position`,
    read_back_path: p => `/${p.target}/fixed_position`, match_fields: ['latitude_i', 'longitude_i'],
    example_payload: { target: '!2687afb1', values: { latitude_i: 515074000, longitude_i: -1278000 } },
    timeout_s: 15, reboot: false,
  }],
  ['send_message', {
    class: 'Radio', description: 'Send mesh text message',
    method: 'POST', endpoint: p => `/${p.target}/messages`,
    read_back_path: null, match_fields: [],
    example_payload: { target: '!2687afb1', values: { text: 'test', channel: 0 } },
    timeout_s: 10, reboot: false,
  }],

  // ── Class 3 — Mode ────────────────────────────────────────────────────────
  // ModeRunner: trigger → wait for confirming WS event or HTTP response

  ['wipe_nodedb', {
    class: 'Mode', description: 'Wipe device node database (managed reboot cycle)',
    method: 'POST', endpoint: () => '/purge-nodedb',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: '!2687afb1', values: {} },
    timeout_s: 70, reboot: true,
  }],
  ['rotator_mode_pasv', {
    class: 'Mode', description: 'Set rotator to PASSIVE mode',
    method: 'POST', endpoint: () => '/rotator/mode',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: { mode: 0 } },
    timeout_s: 5, reboot: false,
  }],
  ['rotator_mode_actv', {
    class: 'Mode', description: 'Set rotator to ACTIVE mode',
    method: 'POST', endpoint: () => '/rotator/mode',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: { mode: 1 } },
    timeout_s: 5, reboot: false,
  }],
  ['rotator_move', {
    class: 'Mode', description: 'Move rotator to azimuth',
    method: 'POST', endpoint: () => '/rotator/move',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: { az: 0 } },
    timeout_s: 10, reboot: false,
  }],
  ['rotator_scan_start', {
    class: 'Mode', description: 'Start rotator scan',
    method: 'POST', endpoint: () => '/rotator/scan/start',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: {} },
    timeout_s: 5, reboot: false,
  }],
  ['rotator_scan_abort', {
    class: 'Mode', description: 'Abort rotator scan',
    method: 'POST', endpoint: () => '/rotator/scan/abort',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: {} },
    timeout_s: 5, reboot: false,
  }],
  ['range_test_start', {
    class: 'Mode', description: 'Start range test TX',
    method: 'POST', endpoint: () => '/range_test/start',
    read_back_path: () => '/range_test/timer', match_fields: ['active'],
    confirming: 'http_200',
    example_payload: { target: '!2687afb1', values: { nodeId: '!2687afb1', durationMin: 1 } },
    timeout_s: 10, reboot: false,
  }],
  ['range_test_stop', {
    class: 'Mode', description: 'Stop range test TX',
    method: 'POST', endpoint: () => '/range_test/stop',
    read_back_path: () => '/range_test/timer', match_fields: ['active'],
    confirming: 'http_200',
    example_payload: { target: null, values: {} },
    timeout_s: 10, reboot: false,
  }],
  ['send_alert_test', {
    class: 'Mode', description: 'Send test alert email',
    method: 'POST', endpoint: () => '/alerts/test',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: {} },
    timeout_s: 15, reboot: false,
  }],
  ['ble_connect', {
    class: 'Mode', description: 'Connect BLE device',
    method: 'POST', endpoint: () => '/devices',
    read_back_path: null, match_fields: [],
    confirming: 'device_state_ready',
    example_payload: { target: null, values: { address: 'E9:B0:3F:17:27:91' } },
    timeout_s: 30, reboot: false,
  }],
  ['ble_disconnect', {
    class: 'Mode', description: 'Disconnect BLE device',
    method: 'DELETE', endpoint: p => `/devices/${p.target}`,
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: 'E9:B0:3F:17:27:91', values: {} },
    timeout_s: 10, reboot: false,
  }],
  ['restart_mqtt_proxy', {
    class: 'Mode', description: 'Reconnect MQTT proxy',
    method: 'POST', endpoint: () => '/mqtt_proxy/restart',
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: null, values: {} },
    timeout_s: 10, reboot: false,
  }],
  ['send_traceroute', {
    class: 'Mode', description: 'Send traceroute to node',
    method: 'POST', endpoint: p => `/${p.target}/traceroute`,
    read_back_path: null, match_fields: [],
    confirming: 'http_200',
    example_payload: { target: '!2687afb1', values: { to: 646426545 } },
    timeout_s: 10, reboot: false,
  }],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Runners
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8000;
const LOCAL_BASE = `http://localhost:${PORT}`;

async function _localFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined && method !== 'DELETE') opts.body = JSON.stringify(body);
  const res = await fetch(`${LOCAL_BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

async function stubRunner(_entry, _params) {
  return { ok: true, stub: true };
}

function _flattenResponse(json) {
  // Unwrap single-key section wrappers like {telemetry: {...}} → {...}
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const keys = Object.keys(json);
    if (keys.length === 1 && typeof json[keys[0]] === 'object' && !Array.isArray(json[keys[0]])) {
      return json[keys[0]];
    }
  }
  return json;
}

function _compareMatchFields(entry, body, responseJson) {
  if (!entry.match_fields?.length || !responseJson) return;
  const flat = _flattenResponse(responseJson);
  const mismatches = [];
  for (const field of entry.match_fields) {
    if (!(field in body)) continue;
    const expected = body[field];
    const actual = flat[field];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  if (mismatches.length > 0) throw new Error(`Read-back mismatch: ${mismatches.join('; ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpManager
// ─────────────────────────────────────────────────────────────────────────────

export class OpManager {
  constructor(broadcastFn, bridge = null) {
    this._broadcast = broadcastFn;
    this._bridge = bridge;   // BridgeClient — needed by RadioRunner for device_state events
    this._ops = new Map(); // op_id → op state
    this.router = this._buildRouter();
  }

  // Public: submit an op and return op_id immediately.
  // Async state machine runs in the background.
  submit(kind, target, payload) {
    const entry = REGISTRY.get(kind);
    if (!entry) throw new Error(`Unknown op kind: ${kind}`);
    const op_id = randomUUID();
    const op = { op_id, kind, target: target ?? null, state: 'saving', result: null, error: null, ts: Math.floor(Date.now() / 1000) };
    this._ops.set(op_id, op);
    this._run(op, entry, payload).catch(err => {
      this._transition(op, 'error', null, err.message);
    });
    return op_id;
  }

  async _run(op, entry, payload) {
    const params = { target: op.target, ...(payload ?? {}) };

    this._transition(op, 'saving');

    try {
      let result;
      if (entry.class === 'Local') {
        result = await this._localRunner(entry, params, op);
      } else if (entry.class === 'Radio') {
        result = await this._radioRunner(entry, params, op);
      } else {
        // Mode: action trigger + optional WS postcondition
        result = await this._modeRunner(entry, params, op);
      }
      this._transition(op, 'success', result);
    } catch (err) {
      this._transition(op, 'error', null, err.message);
    }
  }

  async _localRunner(entry, params, op) {
    const path = entry.endpoint(params);
    const body = params.values ?? {};

    const wr = await _localFetch(entry.method, path, body);
    if (!wr.ok) {
      const detail = wr.json?.error ?? wr.json?.detail ?? wr.text?.slice(0, 120);
      throw new Error(`Write failed HTTP ${wr.status}: ${detail}`);
    }

    if (!entry.read_back_path) return { ok: true };

    this._transition(op, 'validating');
    const rbr = await _localFetch('GET', entry.read_back_path(params));
    if (!rbr.ok) throw new Error(`Read-back failed HTTP ${rbr.status}`);
    _compareMatchFields(entry, body, rbr.json);

    return { ok: true };
  }

  async _radioRunner(entry, params, op) {
    const path = entry.endpoint(params);
    const body = params.values ?? {};
    const target = params.target;

    // Start reboot listener BEFORE the write — firmware reboot delay is ~7s
    // and the listener must be in place before device_state transitions happen.
    // `reboot: 'never'` (module configs) and `reboot: false` skip detection entirely.
    const skipReboot = entry.reboot === 'never' || entry.reboot === false;
    const rebootPromise = skipReboot
      ? Promise.resolve(false)
      : this._waitForStateChange(target, s => s !== 'READY', 15000);

    const wr = await _localFetch(entry.method, path, body);
    if (!wr.ok) {
      const detail = wr.json?.error ?? wr.json?.detail ?? wr.text?.slice(0, 120);
      throw new Error(`Write failed HTTP ${wr.status}: ${detail}`);
    }

    const rebooting = await rebootPromise;

    if (rebooting) {
      this._transition(op, 'rebooting');
      const recovered = await this._waitForStateChange(target, s => s === 'READY', 45000);
      if (!recovered) throw new Error(`Device ${target} did not recover after reboot (45 s timeout)`);
    }

    if (!entry.read_back_path) return { ok: true, rebooted: rebooting };

    this._transition(op, 'validating');
    const rbr = await _localFetch('GET', entry.read_back_path(params));
    if (!rbr.ok) throw new Error(`Read-back failed HTTP ${rbr.status}`);
    _compareMatchFields(entry, body, rbr.json);

    return { ok: true, rebooted: rebooting };
  }

  async _modeRunner(entry, params, op) {
    const path = entry.endpoint(params);
    const body = params.values ?? {};
    const target = params.target;
    const confirming = entry.confirming ?? 'http_200';

    // For WS-based confirmation, arm the listener BEFORE the write so we don't miss a fast event.
    let postconditionPromise = null;
    if (confirming === 'device_state_ready') {
      postconditionPromise = this._waitForStateChange(
        target, s => s === 'READY', (entry.timeout_s ?? 30) * 1000
      );
    }

    const wr = await _localFetch(entry.method, path, body);
    if (!wr.ok) {
      const detail = wr.json?.error ?? wr.json?.detail ?? wr.text?.slice(0, 120);
      throw new Error(`Action failed HTTP ${wr.status}: ${detail}`);
    }

    if (postconditionPromise) {
      const confirmed = await postconditionPromise;
      if (!confirmed) throw new Error(`Device ${target} did not reach expected state (timeout)`);
    }

    return { ok: true, data: wr.json };
  }

  // Returns true if condition(state) becomes true within timeoutMs; false on timeout.
  // Matches on both node_id (!hexid) and addr (BLE MAC) — connecting devices may only have addr.
  _waitForStateChange(target, condition, timeoutMs) {
    return new Promise(resolve => {
      if (!this._bridge) { resolve(false); return; }

      const timer = setTimeout(() => {
        this._bridge.off('device_state', handler);
        resolve(false);
      }, timeoutMs);

      const handler = (ev) => {
        if ((ev.node_id === target || ev.addr === target) && condition(ev.state)) {
          clearTimeout(timer);
          this._bridge.off('device_state', handler);
          resolve(true);
        }
      };
      this._bridge.on('device_state', handler);
    });
  }

  _transition(op, state, result = null, error = null) {
    op.state = state;
    op.result = result;
    op.error = error;
    op.ts = Math.floor(Date.now() / 1000);
    this._broadcast({
      type: 'config_op',
      op_id: op.op_id,
      kind: op.kind,
      target: op.target,
      state: op.state,
      result: op.result,
      error: op.error,
      ts: op.ts,
    });
    // Keep completed ops for 5 minutes then GC
    if (state === 'success' || state === 'error') {
      setTimeout(() => this._ops.delete(op.op_id), 5 * 60 * 1000);
    }
  }

  _buildRouter() {
    const router = Router();

    // POST /op — submit an operation
    router.post('/', (req, res) => {
      const { kind, target, payload } = req.body;
      if (!kind) return res.status(400).json({ error: 'kind required' });
      if (!REGISTRY.has(kind)) return res.status(400).json({ error: `Unknown op kind: ${kind}` });
      try {
        const op_id = this.submit(kind, target ?? null, payload ?? {});
        res.json({ op_id });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /ops/manifest — full registry for test_ops.py and UI
    router.get('/manifest', (_req, res) => {
      const ops = [];
      for (const [kind, entry] of REGISTRY) {
        ops.push({
          kind,
          class: entry.class,
          description: entry.description,
          method: entry.method,
          timeout_s: entry.timeout_s,
          reboot: entry.reboot,
          has_read_back: !!entry.read_back_path,
          match_fields: entry.match_fields,
          confirming: entry.confirming ?? null,
          example_payload: entry.example_payload,
        });
      }
      res.json({ count: ops.length, ops });
    });

    // GET /op/:op_id — check op status
    router.get('/:op_id', (req, res) => {
      const op = this._ops.get(req.params.op_id);
      if (!op) return res.status(404).json({ error: 'op not found (may have expired)' });
      res.json(op);
    });

    return router;
  }
}
