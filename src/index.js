import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { bridge } from './bridge.js';
import { handleEvent } from './persist.js';
import configRouter from './config-api.js';
import deviceConfigRouter from './device-config.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, insertRangeTestEntry, queryRangeTestLog, clearRangeTestLog } from './db.js';
import { rotator } from './rotator.js';
import { handlePacketForRotator } from './rotator-logic.js';
import { attachWsRelay } from './ws-relay.js';
import { BRIDGE_CONFIG_SCHEMA } from './bridge-config-schema.js';
import { ROTATOR_CONFIG_SCHEMA } from './rotator-config-schema.js';

const PORT = process.env.PORT || 8000;
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());

// -- node-dash APIs ----------------------------------------------------------

app.get('/status', async (req, res) => {
  try {
    const data = await bridge.get('/status');
    res.json({ bridge_connected: bridge.connected, bridge: data });
  } catch (err) {
    res.status(502).json({ bridge_connected: false, error: err.message });
  }
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(queryMessages(limit));
});

app.get('/nodes', async (req, res) => {
  try {
    const maxAge    = getConfig('node_filters.max_age',    0);
    const maxHops   = getConfig('node_filters.max_hops',   99);
    const namedOnly = getConfig('node_filters.named_only', false);
    const hasPos    = getConfig('node_filters.has_pos',    false);
    const hideMqtt  = getConfig('node_filters.hide_mqtt',  false);
    const hasSignal = getConfig('node_filters.has_signal', false);
    const hasTelem  = getConfig('node_filters.has_telem',  false);
    const roles     = getConfig('node_filters.roles',      []);

    const params = new URLSearchParams();
    if (maxAge > 0)   params.set('max_age',       maxAge);
    if (maxHops < 99) params.set('max_hops',      maxHops);
    if (namedOnly)    params.set('named_only',    'true');
    if (hasPos)       params.set('has_position',  'true');
    if (hideMqtt)     params.set('hide_mqtt',     'true');
    if (hasSignal)    params.set('has_signal',    'true');
    if (hasTelem)     params.set('has_telemetry', 'true');
    if (roles.length) roles.forEach(r => params.append('node_roles', r));

    const qs = params.toString();
    const data = await bridge.get(`/nodes${qs ? '?' + qs : ''}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use('/config', configRouter);
app.use('/device-config', deviceConfigRouter);

app.get('/rotator/status', (req, res) => {
  const { mode: _fw, ...fwStatus } = rotator.status; // exclude firmware string 'mode' field
  res.json({ connected: rotator.connected, mode: rotator.mode, ...fwStatus });
});

app.post('/rotator/move', (req, res) => {
  const { az } = req.body;
  if (az == null) return res.status(400).json({ error: 'az required' });
  rotator.move(az);
  res.json({ moving: true, az });
});

app.post('/rotator/mode', (req, res) => {
  const { mode } = req.body;
  if (mode == null) return res.status(400).json({ error: 'mode required' });
  rotator.setMode(mode);
  setConfig('rotator.mode', mode);
  res.json({ mode });
});

app.post('/rotator/calibrate', (req, res) => {
  const ALLOWED = ['calMotor', 'qmcCali', 'calPwmMin', 'qmcOsStart', 'qmcOsEnd'];
  const { procedure } = req.body;
  if (!ALLOWED.includes(procedure)) return res.status(400).json({ error: 'unknown procedure' });
  rotator.sendAction(procedure);
  res.json({ sent: procedure });
});

app.get('/rotator/firmware_config', (req, res) => {
  const s = rotator.status;
  res.json({
    motor: {
      pwm_min:        s.pwmMin  ?? null,
      pwm_run:        s.pwmRun  ?? null,
      pulses_per_deg: s.ppd     ?? null,
    },
    scan: {
      step_deg:  s.scanStep  ?? null,
      dwell_sec: s.scanDwell != null ? s.scanDwell / 1000 : null,
    },
  });
});

app.post('/rotator/firmware_config', (req, res) => {
  const { motor = {}, scan = {} } = req.body;
  if (motor.pwm_min        != null) rotator.sendAction('pwmMin', [Math.round(motor.pwm_min)]);
  if (motor.pwm_run        != null) rotator.sendAction('pwmRun', [Math.round(motor.pwm_run)]);
  if (motor.pulses_per_deg != null) rotator.sendAction('ppd',    [Number(motor.pulses_per_deg)]);
  if (scan.step_deg  != null && scan.dwell_sec != null) {
    rotator.sendAction('scanCfg', [Math.round(scan.step_deg), Math.round(scan.dwell_sec * 1000)]);
  }
  res.json({ sent: true });
});

app.get('/schema/rotator_config', (req, res) => res.json(ROTATOR_CONFIG_SCHEMA));

// node-dash-owned schema endpoints (must be before bridge proxy)
app.get('/schema/bridge_config', (req, res) => res.json(BRIDGE_CONFIG_SCHEMA));

// -- range test log (SQLite-persisted, survives restarts) --------------------

app.get('/range_test/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const rows = queryRangeTestLog(limit);
  res.json({ log: rows, count: rows.length });
});

app.delete('/range_test/log', (req, res) => {
  clearRangeTestLog();
  res.json({ cleared: true });
});

// -- range test timer ---------------------------------------------------------
let _rangeTimer = { active: false, endsAt: null, nodeId: null };
let _rangeTimerHandle = null;

async function _bridgePutRangeTest(nodeId, enabled) {
  const body = enabled ? { enabled: true, sender: 60 } : { enabled: false, sender: 0 };
  await fetch(`${BRIDGE_URL}/${nodeId}/config/range_test`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

app.get('/range_test/timer', (req, res) => {
  const remaining = _rangeTimer.endsAt ? Math.max(0, Math.round((_rangeTimer.endsAt - Date.now()) / 1000)) : null;
  res.json({ ..._rangeTimer, remaining });
});

app.post('/range_test/start', async (req, res) => {
  const { nodeId, durationMin } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
  const duration = Math.max(1, parseInt(durationMin) || 10);
  if (_rangeTimerHandle) { clearTimeout(_rangeTimerHandle); _rangeTimerHandle = null; }
  try {
    await _bridgePutRangeTest(nodeId, true);
  } catch (err) {
    return res.status(502).json({ error: 'bridge: ' + err.message });
  }
  const endsAt = Date.now() + duration * 60 * 1000;
  _rangeTimer = { active: true, endsAt, nodeId };
  _rangeTimerHandle = setTimeout(async () => {
    try { await _bridgePutRangeTest(nodeId, false); } catch (e) { console.error('[range_test] auto-disable failed:', e.message); }
    _rangeTimer = { active: false, endsAt: null, nodeId: null };
    _rangeTimerHandle = null;
  }, duration * 60 * 1000);
  res.json({ started: true, endsAt, nodeId, durationMin: duration });
});

app.post('/range_test/stop', async (req, res) => {
  const nodeId = _rangeTimer.nodeId || req.body?.nodeId;
  if (_rangeTimerHandle) { clearTimeout(_rangeTimerHandle); _rangeTimerHandle = null; }
  _rangeTimer = { active: false, endsAt: null, nodeId: null };
  if (nodeId) {
    try { await _bridgePutRangeTest(nodeId, false); } catch (err) { return res.status(502).json({ error: 'bridge: ' + err.message }); }
  }
  res.json({ stopped: true });
});

// -- bridge proxy (device mgmt, BLE, per-device config) ---------------------

async function proxyToBridge(req, res) {
  const url = `${BRIDGE_URL}${req.originalUrl}`;
  const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    opts.body = JSON.stringify(req.body);
  }
  try {
    const upstream = await fetch(url, opts);
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

const BRIDGE_PREFIXES = ['/devices', '/ble', '/ble_devices', '/sections', '/schema', '/bridge_config', '/node_filter', '/mqtt_publish', '/mqtt_proxy'];
for (const prefix of BRIDGE_PREFIXES) {
  app.use(prefix, proxyToBridge);
}
// Per-device routes: /!hex/...
app.use(/^\/![0-9a-f]+/i, proxyToBridge);

// -- static files -----------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

// -- server + WS relay -------------------------------------------------------
const server = http.createServer(app);
attachWsRelay(server);

server.listen(PORT, () => {
  console.log(`[node-dash] listening on port ${PORT}`);
  bridge.start();
  rotator.start();
});

// -- event handlers ----------------------------------------------------------
bridge.on('event', (ev) => {
  handleEvent(ev);
  if (ev.type === 'packet') {
    handlePacketForRotator(ev);
    const pkt = ev.data?.packet;
    if (pkt?.decoded?.portnum === 'RANGE_TEST_APP') {
      const seq = pkt.decoded.payload
        ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8')
        : null;
      const hops = pkt.hop_start != null ? Math.max(0, pkt.hop_start - (pkt.hop_limit ?? 0)) : null;
      insertRangeTestEntry({
        ts:        Math.floor(Date.now() / 1000),
        from_num:  pkt.from     ?? null,
        rssi:      pkt.rx_rssi  ?? null,
        snr:       pkt.rx_snr   ?? null,
        hops,
        seq,
        rx_device: ev.device    ?? null,
      });
    }
  }
});

rotator.on('connected', () => {
  const savedMode = getConfig('rotator.mode', 0);
  if (savedMode) rotator.setMode(savedMode);
});

bridge.on('connected', async () => {
  try {
    const resp = await bridge.get('/nodes?named_only=true');
    const nodeMap = resp?.nodes ?? {};
    const entries = Object.values(nodeMap);
    for (const n of entries) {
      handleEvent({ type: 'node_info', data: n, device: null });
    }
    console.log(`[node-dash] seeded ${entries.length} named nodes from bridge`);
  } catch (err) {
    console.error(`[node-dash] seed failed: ${err.message}`);
  }
});
