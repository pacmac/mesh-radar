import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import path from 'path';
import { bridge } from './bridge.js';
import { handleEvent } from './persist.js';
import configRouter from './config-api.js';
import deviceConfigRouter, { getDeviceCfg, getAllDeviceCfgs, getPrimaryDeviceId, getRotatorDeviceId, onHomePosChange } from './device-config.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, stmts, insertRangeTestEntry, queryRangeTestLog, clearRangeTestLog, queryTiltHistory, markTiltNcal, clearNodeCache, queryEnvHistory, insertEnvHistory, getCachedGeocode, setCachedGeocode, getConfigByPrefix } from './db.js';
import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { activeTracker } from './active-tracker.js';
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

// Serve src/utils.js to the browser as a classic script — true SSOT.
// ESM export keywords are stripped; named functions assigned to window.
app.get('/utils.js', (req, res) => {
  const src  = readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const body = src
    .replace(/^\/\/.*$/gm, '')        // strip single-line comments
    .replace(/^export\s+/gm, '');     // strip ESM export keywords
  const names = ['haversine', 'bearing', 'signalQuality', 'numToNodeId', 'nodeIdToNum'];
  const out = `(function(){\n${body}\nif(typeof window!=='undefined')Object.assign(window,{${names.join(',')}});\n})();`;
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(out);
});

// -- SPA page routing --------------------------------------------------------
// Browser navigations carry Accept: text/html; fetch() API calls do not.
// Register page-serving stubs before conflicting API routes so the browser
// gets index.html and JS handles the tab, while XHR still hits the API.
const _servePage = (req, res, next) =>
  req.headers.accept?.includes('text/html')
    ? res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
    : next();

for (const p of ['/overview','/radar','/nodes','/messages','/config','/device-config','/devices','/range']) {
  app.get(p, _servePage);
}

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

app.delete('/nodes', (req, res) => {
  clearNodeCache();
  nodeList.clear();
  res.json({ cleared: true });
});

app.get('/nodes', (req, res) => {
  const nodes = nodeList.nodes;
  const nodeMap = {};
  for (const n of nodes) nodeMap[String(n.num)] = n;
  res.json({ nodes: nodeMap, count: nodes.length, total: nodeList._cache.size, homePos: nodeList.homePos });
});

app.use('/config', configRouter);
app.use('/device-config', deviceConfigRouter);

app.get('/rotator/status', (req, res) => {
  const fwStatus = rotator.status;
  res.json({
    connected:     rotator.connected,
    mode:          dashMode.value,
    dash_mode:     dashMode.value,
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
  dashMode.set(mode);
  res.json({ mode });
});

app.post('/rotator/target', (req, res) => {
  const num = parseInt(req.body.num, 10);
  if (!num) return res.status(400).json({ error: 'num required' });
  if (dashMode.value !== 1) return res.status(409).json({ error: 'not in ACTV mode' });
  const ok = activeTracker.targetNum(num);
  if (!ok) return res.status(404).json({ error: 'node not in radar list or no position' });
  res.json({ targeted: num });
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

app.post('/rotator/setvar', (req, res) => {
  const ALLOWED_VARS = ['setPwmRunPct', 'setPwmFreq', 'setNorthOffset'];
  const { action, val } = req.body;
  if (!ALLOWED_VARS.includes(action)) return res.status(400).json({ error: 'unknown var' });
  if (val == null) return res.status(400).json({ error: 'val required' });
  rotator.sendAction(action, [String(val)]);
  res.json({ sent: action, val });
});

app.post('/rotator/offset', (req, res) => {
  let { offset } = req.body;
  offset = parseFloat(offset);
  if (isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
  offset = ((offset % 360) + 360) % 360;
  rotator.sendAction('setOffset', [String(offset)]);
  res.json({ sent: true, offset });
});

app.get('/rotator/firmware_config', (req, res) => {
  const s = rotator.status;
  const savedScan = getConfig('scan_config', {});
  const savedActv = getConfig('actv_config', {});
  res.json({
    motor: {
      pwm_min:        s.pwmMin  ?? null,
      pwm_run:        s.pwmRun  ?? null,
      pulses_per_deg: s.ppd     ?? null,
    },
    scan: {
      step_deg:  savedScan.step_deg  ?? 5,
      dwell_sec: savedScan.dwell_sec ?? 60,
    },
    actv: {
      dwell_sec: savedActv.dwell_sec ?? 90,
    },
  });
});

app.post('/rotator/firmware_config', (req, res) => {
  const { motor = {}, scan = {}, actv = {} } = req.body;
  if (motor.pwm_min        != null) rotator.sendAction('pwmMin', [Math.round(motor.pwm_min)]);
  if (motor.pwm_run        != null) rotator.sendAction('pwmRun', [Math.round(motor.pwm_run)]);
  if (motor.pulses_per_deg != null) rotator.sendAction('ppd',    [Number(motor.pulses_per_deg)]);
  if (scan.step_deg != null || scan.dwell_sec != null) {
    const current = getConfig('scan_config', {});
    if (scan.step_deg  != null) current.step_deg  = Number(scan.step_deg);
    if (scan.dwell_sec != null) current.dwell_sec = Number(scan.dwell_sec);
    setConfig('scan_config', current);
  }
  if (actv.dwell_sec != null) {
    setConfig('actv_config', { dwell_sec: Number(actv.dwell_sec) });
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

app.get('/env_history', (req, res) => {
  const num   = parseInt(req.query.num) || 0;
  const hours = parseFloat(req.query.hours) || 24;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  res.json(queryEnvHistory(num, since));
});

// Nominatim reverse-geocode — results cached in nodeinfo.address
// Server-side queue enforces 1.1s between requests to respect usage policy
let _geocodeQueue = Promise.resolve();
app.get('/geocode', async (req, res) => {
  const num = parseInt(req.query.num) || 0;
  if (!num) return res.json({ address: null });

  const cached = getCachedGeocode(num);
  if (cached) return res.json({ address: cached });

  const pos = stmts.getNodePos.get(num, num);
  if (!pos?.lat || !pos?.lon) return res.json({ address: null });

  const address = await (_geocodeQueue = _geocodeQueue.then(() =>
    new Promise(resolve => setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${pos.lat}&lon=${pos.lon}&format=jsonv2&zoom=18&addressdetails=1`;
        const r = await fetch(url, { headers: { 'User-Agent': 'node-dash/1.0', 'Accept-Language': 'en' } });
        const data = await r.json();
        const a = data.address || {};
        const road     = [a.house_number, a.road].filter(Boolean).join(' ');
        const place    = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.locality || '';
        const county   = a.county || a.state_district || a.state || '';
        const seen     = new Set();
        const parts    = [road, place, a.postcode, county, a.country]
          .filter(p => p && !seen.has(p) && seen.add(p));
        resolve(parts.join(', ') || (data.display_name || '').split(',').slice(0, 3).join(', ') || `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`);
      } catch (_) {
        resolve(`${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`);
      }
    }, 1100))
  ));

  setCachedGeocode(num, address);
  res.json({ address });
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

// Traceroute — send from primary device to target node num in URL
app.post('/:nodeId/traceroute', async (req, res) => {
  const targetNum = parseInt((req.params.nodeId || '').replace('!', ''), 16);
  if (!targetNum) return res.status(400).json({ error: 'invalid nodeId' });
  const sender = getPrimaryDeviceId();
  if (!sender) return res.status(503).json({ error: 'no primary device configured' });
  try {
    const result = await bridge.post(`/${sender}/traceroute`, { to: targetNum });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// -- auto-purge settings + scheduler ----------------------------------------

app.get('/auto-purge', (req, res) => {
  const nodeId = req.query.device;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  res.json({
    enabled:     getConfig(`auto_purge_enabled_${nodeId}`, false),
    purge_time:  getConfig(`auto_purge_time_${nodeId}`, '02:00'),
    last_run_ts: getConfig(`auto_purge_last_run_ts_${nodeId}`, null),
  });
});

app.put('/auto-purge', (req, res) => {
  const { device: nodeId, enabled, purge_time } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  setConfig(`auto_purge_enabled_${nodeId}`, !!enabled);
  if (purge_time && /^\d{2}:\d{2}$/.test(purge_time)) setConfig(`auto_purge_time_${nodeId}`, purge_time);
  res.json({ ok: true });
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

// Catch-all: serve index.html for any unrecognised path (SPA deep-links)
app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// -- server + WS relay -------------------------------------------------------
const server = http.createServer(app);
const wss = attachWsRelay(server);

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

server.listen(PORT, () => {
  console.log(`[node-dash] listening on port ${PORT}`);
  bridge.start();
  rotator.start();
  // Resume scan if it was active before restart
  const savedScan = getConfig('scan_state', {});
  if (savedScan.active) {
    console.log(`[node-dash] resuming scan from az=${savedScan.az}`);
    const savedNodes = getConfig('scan_nodes', []);  // read BEFORE setScanActive clears cache
    nodeList.setScanActive(true, false);  // clear in-memory cache but keep SQLite scan_nodes intact
    if (savedNodes.length) nodeList.restoreScanNodes(savedNodes);
    // Wait for rotator to connect before resuming movement
    rotator.once('status', () => scanner.resume(savedScan));
  }
});

onHomePosChange(() => nodeList.refilter());

// -- scanner lifecycle -------------------------------------------------------
scanner.on('start', () => {
  activeTracker.stop();   // ACTV and SCAN are mutually exclusive
  dashMode.set(2);
  nodeList.setScanActive(true);
});
scanner.on('contact', (contact) => {
  const rotatorId = getRotatorDeviceId();
  if (contact.from && rotatorId)
    nodeList.confirmScanContact(contact.from, rotatorId, contact.az, contact.rssi, contact.snr);
});
scanner.on('end', () => {
  dashMode.set(scanner._preMode);
  nodeList.setScanActive(false);
});

// -- ACTV mode lifecycle -----------------------------------------------------
dashMode.on('change', ({ _mode }) => {
  if (_mode === 1) {
    if (scanner.active) return;  // SCAN takes precedence; refuse silent ACTV start
    activeTracker.start();
  } else {
    activeTracker.stop();
  }
});

// Resume active mode if it was persisted before restart
if (dashMode.value === 1) activeTracker.start();

// -- event handlers ----------------------------------------------------------
const _lastEnvTs = new Map(); // num → last inserted ts (dedup node_update vs packet)

bridge.on('event', (ev) => {
  handleEvent(ev);
  if (ev.type === 'node_update' || ev.type === 'node_info') {
    nodeList.handleNodeUpdate(ev);
    const node = ev.data?.node_info ?? ev.data;
    const em = node?.environment_metrics;
    if (em && node?.num && (em.temperature != null || em.relative_humidity != null)) {
      const now = Math.floor(Date.now() / 1000);
      const last = _lastEnvTs.get(node.num) ?? 0;
      if (now - last > 60) {
        _lastEnvTs.set(node.num, now);
        insertEnvHistory({
          ts: now,
          num: node.num,
          temperature:         em.temperature         ?? null,
          relative_humidity:   em.relative_humidity   ?? null,
          barometric_pressure: em.barometric_pressure ?? null,
        });
        nodeList.setEnvironmentMetrics(node.num, em);
      }
    }
  }
  if (ev.type === 'packet') {
    activeTracker.handlePacket(ev);
    scanner.handlePacket(ev);
    const pkt = ev.data?.packet;
    const rotatorId = getRotatorDeviceId();
    const yagiOnly = scanner.active && rotatorId && ev.device !== rotatorId;
    if (pkt?.from && !yagiOnly) nodeList.touchLastHeard(pkt.from, pkt.rx_time, ev.device ?? null);
    if (pkt?.decoded?.portnum === 'TELEMETRY_APP' && pkt?.decoded?.telemetry?.environment_metrics && pkt?.from) {
      nodeList.setEnvironmentMetrics(pkt.from, pkt.decoded.telemetry.environment_metrics);
    }
    if (pkt?.decoded?.portnum === 'TRACEROUTE_APP' && pkt?.decoded?.route_discovery && pkt?.from) {
      const rd = pkt.decoded.route_discovery;
      // Snapshot relay node positions from nodeinfo so the radar can draw
      // the exact path even when relay nodes are not in the current radar view.
      const relay_positions = {};
      for (const num of rd.route ?? []) {
        const info = stmts.getNodeinfoByNum.get(num);
        if (info?.lat != null && info?.lon != null) {
          relay_positions[num] = { latitude_i: Math.round(info.lat * 1e7), longitude_i: Math.round(info.lon * 1e7) };
        }
      }
      nodeList.setTraceroute(pkt.from, {
        route:            rd.route       ?? [],
        route_back:       rd.route_back  ?? [],
        snr_towards:      rd.snr_towards ?? [],
        snr_back:         rd.snr_back    ?? [],
        relay_positions,
        ts: Date.now(),
      });
    }
  }
  // range_test_entry: broadcast by bridge with correctly decoded seq/hops from raw protobuf
  if (ev.type === 'range_test_entry' && ev.data) {
    const e = ev.data;
    insertRangeTestEntry({
      ts:        e.ts       ?? Math.floor(Date.now() / 1000),
      from_num:  e.from_num ?? null,
      rssi:      e.rssi     ?? null,
      snr:       e.snr      ?? null,
      hops:      e.hops     ?? null,
      seq:       e.seq      ?? null,
      rx_device: ev.device  ?? null,
    });
  }
});

rotator.on('connected', () => {
});

// Auto-traceroute: when ACTV mode acquires a new target, send a traceroute automatically.
// Throttle: skip if this node was traced less than 5 minutes ago.
let _lastTracedNum = null;
let _lastTracedAt  = 0;
const TRACE_COOLDOWN_MS = 5 * 60 * 1000;

rotator.on('point_target', (data) => {
  const num = data.point_target;
  if (!num) return;
  const now = Date.now();
  if (num === _lastTracedNum && now - _lastTracedAt < TRACE_COOLDOWN_MS) return;
  _lastTracedNum = num;
  _lastTracedAt  = now;
  const sender = getPrimaryDeviceId();
  if (!sender) return;
  bridge.post(`/${sender}/traceroute`, { to: num }).catch(() => {});
});

// -- auto-purge scheduler ---------------------------------------------------
async function runAutoPurge(nodeId) {
  console.log(`[auto-purge] wiping nodedb on ${nodeId}`);
  try {
    await bridge.post(`/${nodeId}/admin`, { message: { nodedb_reset: true }, want_response: false });
    const ts = Math.floor(Date.now() / 1000);
    setConfig(`auto_purge_last_run_ts_${nodeId}`, ts);
    broadcastAll({ type: 'auto_purge_complete', device: nodeId, ts });
    console.log(`[auto-purge] done`);
  } catch (e) {
    console.error(`[auto-purge] failed on ${nodeId}:`, e.message);
    broadcastAll({ type: 'auto_purge_error', device: nodeId, error: e.message });
  }
}

setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = now.toDateString();
  const enabled = getConfigByPrefix('auto_purge_enabled_');
  for (const [nodeId, isEnabled] of Object.entries(enabled)) {
    if (!isEnabled) continue;
    const purgeTime = getConfig(`auto_purge_time_${nodeId}`, '02:00');
    if (hhmm !== purgeTime) continue;
    const lastRun = getConfig(`auto_purge_last_run_ts_${nodeId}`, null);
    const lastRunDate = lastRun ? new Date(lastRun * 1000).toDateString() : null;
    if (lastRunDate === today) continue; // already ran today
    runAutoPurge(nodeId);
  }
}, 60 * 1000);

bridge.on('connected', async () => {
  const primaryId = getPrimaryDeviceId();
  const cfg = primaryId ? getDeviceCfg(primaryId) : {};

  // Seed NodeList: all nodes first (device unknown), then YAGI nodes with device tag
  try {
    const rotatorId = getRotatorDeviceId();
    const allResp = await bridge.get('/nodes');
    const allNodes = Object.values(allResp?.nodes ?? {});
    nodeList.seed(allNodes, null);
    // Seed own-device cache for each known BLE device so Devices tab has metadata immediately
    const allDeviceCfgs = getAllDeviceCfgs();
    for (const deviceId of Object.keys(allDeviceCfgs)) {
      if (!deviceId.startsWith('!')) continue;
      const devNum = parseInt(deviceId.slice(1), 16);
      const devNode = allNodes.find(n => n.num === devNum);
      if (devNode) nodeList.seedOwnDevice(devNode, deviceId);
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
