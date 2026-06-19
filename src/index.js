import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { bridge } from './bridge.js';
import { handleEvent } from './persist.js';
import configRouter from './config-api.js';
import deviceConfigRouter, { getDeviceCfg, getPrimaryDeviceId, getRotatorDeviceId, onHomePosChange } from './device-config.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, insertRangeTestEntry, queryRangeTestLog, clearRangeTestLog, queryTiltHistory, markTiltNcal } from './db.js';
import { rotator } from './rotator.js';
import { handlePacketForRotator } from './rotator-logic.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
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

app.get('/nodes', (req, res) => {
  const nodes = nodeList.nodes;
  const nodeMap = {};
  for (const n of nodes) nodeMap[String(n.num)] = n;
  res.json({ nodes: nodeMap, count: nodes.length, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null });
});

app.use('/config', configRouter);
app.use('/device-config', deviceConfigRouter);

app.get('/rotator/status', (req, res) => {
  const { mode: _fw, ...fwStatus } = rotator.status; // exclude firmware string 'mode' field
  res.json({
    connected:     rotator.connected,
    mode:          rotator.mode,
    dash_mode:     getConfig('rotator.dash_mode', rotator.mode),
    scan_active:   scanner.active,
    scan_az:       scanner.active ? scanner.az : null,
    scan_dwell_az: scanner.active ? scanner.dwellAz : null,
    scan_contacts: scanner.contacts,
    ...fwStatus,
  });
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
  // firmware only understands 0/1; dash_mode tracks full 3-state (0=PASV,1=ACTV,2=SCAN)
  const fwMode = Math.min(mode, 1);
  rotator.setMode(fwMode);
  setConfig('rotator.dash_mode', mode);
  if (mode < 2) setConfig('rotator.mode', fwMode);
  res.json({ mode });
});

app.post('/rotator/scan/start', (req, res) => {
  if (scanner.active) return res.json({ started: false, reason: 'already scanning' });
  scanner.start();
  res.json({ started: true });
});

app.post('/rotator/scan/abort', (req, res) => {
  scanner.abort();
  res.json({ aborted: true });
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
  const savedScan = getConfig('scan_config', {});
  res.json({
    motor: {
      pwm_min:        s.pwmMin  ?? null,
      pwm_run:        s.pwmRun  ?? null,
      pulses_per_deg: s.ppd     ?? null,
    },
    scan: {
      step_deg:  savedScan.step_deg  ?? s.scanStep  ?? 5,
      dwell_sec: savedScan.dwell_sec ?? (s.scanDwell != null ? s.scanDwell / 1000 : 60),
    },
  });
});

app.post('/rotator/firmware_config', (req, res) => {
  const { motor = {}, scan = {} } = req.body;
  if (motor.pwm_min        != null) rotator.sendAction('pwmMin', [Math.round(motor.pwm_min)]);
  if (motor.pwm_run        != null) rotator.sendAction('pwmRun', [Math.round(motor.pwm_run)]);
  if (motor.pulses_per_deg != null) rotator.sendAction('ppd',    [Number(motor.pulses_per_deg)]);
  if (scan.step_deg != null || scan.dwell_sec != null) {
    const current = getConfig('scan_config', {});
    if (scan.step_deg  != null) current.step_deg  = Number(scan.step_deg);
    if (scan.dwell_sec != null) current.dwell_sec = Number(scan.dwell_sec);
    setConfig('scan_config', current);
  }
  res.json({ sent: true });
});

app.get('/schema/rotator_config', (req, res) => res.json(ROTATOR_CONFIG_SCHEMA));

// node-dash-owned schema endpoints (must be before bridge proxy)
app.get('/schema/bridge_config', (req, res) => res.json(BRIDGE_CONFIG_SCHEMA));

// -- range test log (SQLite-persisted, survives restarts) --------------------

app.get('/tilt_history', (req, res) => {
  const nodeId = req.query.node_id || '';
  const hours  = parseFloat(req.query.hours) || 4;
  const since  = Math.floor(Date.now() / 1000) - hours * 3600;
  res.json(queryTiltHistory(nodeId, since));
});

// Mark records around a calibration event as NCAL (excluded from history/peak)
app.post('/tilt_history/ncal', (req, res) => {
  const { node_id, ts, window_sec = 90 } = req.body;
  if (!node_id || ts == null) return res.status(400).json({ error: 'node_id and ts required' });
  const changed = markTiltNcal(node_id, ts - window_sec, ts + window_sec);
  res.json({ marked: changed });
});

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

const BRIDGE_PREFIXES = ['/devices', '/ble', '/ble_devices', '/sections', '/schema', '/bridge_config', '/node_filter', '/mqtt_publish', '/mqtt_proxy', '/ota'];
for (const prefix of BRIDGE_PREFIXES) {
  app.use(prefix, proxyToBridge);
}
// Per-device routes: /!hex/...
app.use(/^\/![0-9a-f]+/i, proxyToBridge);

// -- static files -----------------------------------------------------------
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0 }));

// -- server + WS relay -------------------------------------------------------
const server = http.createServer(app);
attachWsRelay(server);

server.listen(PORT, () => {
  console.log(`[node-dash] listening on port ${PORT}`);
  bridge.start();
  rotator.start();
});

onHomePosChange(() => nodeList.refilter());

// -- scanner lifecycle -------------------------------------------------------
scanner.on('start', async () => {
  setConfig('rotator.dash_mode', 2);
  nodeList.setScanActive(true);  // clears cache, schedules emit (150ms debounce)
  // Re-seed from YAGI's bridge node list so GPS positions survive the cache clear.
  // If this resolves within 150ms the first emit already has data; if not, a second
  // emit fires after seeding — either way the radar populates quickly.
  const rotatorId = getRotatorDeviceId();
  if (rotatorId) {
    try {
      const resp = await bridge.get(`/${rotatorId}/nodes`);
      const nodes = Object.values(resp?.nodes ?? {});
      if (nodes.length) nodeList.seed(nodes, rotatorId);
    } catch (e) {
      console.warn('[scanner] reseed failed:', e.message);
    }
  }
});
scanner.on('end',   () => {
  const mode = scanner._preMode;
  setConfig('rotator.dash_mode', mode);
  if (mode < 2) setConfig('rotator.mode', mode);
  nodeList.setScanActive(false);
});

// -- event handlers ----------------------------------------------------------
bridge.on('event', (ev) => {
  handleEvent(ev);
  if (ev.type === 'node_update' || ev.type === 'node_info') nodeList.handleNodeUpdate(ev);
  if (ev.type === 'packet') {
    handlePacketForRotator(ev);
    scanner.handlePacket(ev);
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
  const primaryId = getPrimaryDeviceId();
  const cfg = primaryId ? getDeviceCfg(primaryId) : {};

  // Seed NodeList: all nodes first (device unknown), then YAGI nodes with device tag
  try {
    const rotatorId = getRotatorDeviceId();
    const allResp = await bridge.get('/nodes');
    const allNodes = Object.values(allResp?.nodes ?? {});
    nodeList.seed(allNodes, null);
    if (rotatorId) {
      const yagiResp = await bridge.get(`/${rotatorId}/nodes`);
      const yagiNodes = Object.values(yagiResp?.nodes ?? {});
      nodeList.seed(yagiNodes, rotatorId);
    }
    console.log(`[node-list] seeded ${allNodes.length} nodes`);
  } catch (err) {
    console.error(`[node-list] seed failed: ${err.message}`);
  }

  if (!cfg.load_nodes_on_boot) {
    console.log('[node-dash] load_nodes_on_boot=false — skipping persist seed');
    return;
  }
  try {
    const resp = await bridge.get('/nodes?named_only=true');
    const nodeMap = resp?.nodes ?? {};
    const entries = Object.values(nodeMap);
    for (const n of entries) {
      handleEvent({ type: 'node_info', data: n, device: null });
    }
    console.log(`[node-dash] seeded ${entries.length} named nodes into persist`);
  } catch (err) {
    console.error(`[node-dash] persist seed failed: ${err.message}`);
  }
});
