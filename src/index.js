import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { bridge } from './bridge.js';
import { handleEvent } from './persist.js';
import configRouter from './config-api.js';
import deviceConfigRouter, { getDeviceCfg, getAllDeviceCfgs, getPrimaryMac, getRotatorAddress, onHomePosChange, registerNodeIdToMacResolver, registerMacToNodeIdResolver, resolvePrimaryNodeId } from './device-config.js';
import { ownDeviceNums, registerMacToNumResolver } from './node-filter.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, stmts, insertRangeTestEntry, queryRangeTestLog, clearRangeTestLog, clearNodeCache, insertEnvHistory, getCachedGeocode, setCachedGeocode, getConfigByPrefix } from './db.js';
import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { activeTracker } from './active-tracker.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { attachWsRelay, getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { BRIDGE_CONFIG_SCHEMA } from './bridge-config-schema.js';
import { ROTATOR_CONFIG_SCHEMA } from './rotator-config-schema.js';
import { startAlertPoller } from './alerts.js';
import alertsRouter from './alerts-api.js';
import rotatorRouter from './rotator-api.js';
import messagesRouter from './messages-api.js';
import tracerouteRouter from './traceroute-api.js';
import { createPerformanceRouter } from './performance-api.js';
import { startImapReceiver } from './imap-receiver.js';
import { passiveTracer } from './passive-tracer.js';
import { resolveNodeLabel, resolveDeviceLabel, registerMacResolver } from './node-label.js';
import { FF } from './feature-flags.js';
import { traceroute } from './traceroute.js';
import { OpManager } from './op-manager.js';

registerNodeIdToMacResolver(getLiveMacByNodeId);
registerMacToNodeIdResolver(getLiveNodeIdByMac);
registerMacResolver(getLiveMacByNodeId);
registerMacToNumResolver(mac => {
  const nodeId = getLiveNodeIdByMac(mac);
  if (!nodeId) return null;
  const num = parseInt(nodeId.replace('!', ''), 16);
  return isNaN(num) ? null : num;
});

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

// -- HTML partial assembly ---------------------------------------------------
// index.html may contain <!-- include: filename --> markers which are replaced
// with the contents of public/partials/filename at request time.
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

function assembleIndex() {
  let html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return html.replace(/<!--\s*include:\s*(\S+)\s*-->/g, (_, filename) => {
    const p = path.join(PARTIALS_DIR, filename);
    return existsSync(p) ? readFileSync(p, 'utf8') : `<!-- missing partial: ${filename} -->`;
  });
}

function serveIndex(req, res) {
  res.type('html').send(assembleIndex());
}

// -- SPA page routing --------------------------------------------------------
// Browser navigations carry Accept: text/html; fetch() API calls do not.
// Register page-serving stubs before conflicting API routes so the browser
// gets index.html and JS handles the tab, while XHR still hits the API.
const _servePage = (req, res, next) =>
  req.headers.accept?.includes('text/html') ? serveIndex(req, res) : next();

for (const p of ['/','/overview','/radar','/nodes','/messages','/config','/device-config','/devices','/range','/performance']) {
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
  const rows = queryMessages(limit).map(r => ({ ...r, display_name: resolveNodeLabel(r.from_num) }));
  res.json(rows);
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

app.get('/home_pos', (_req, res) => {
  res.json({ lat: getConfig('home.lat', null), lon: getConfig('home.lon', null) });
});

app.put('/home_pos', (req, res) => {
  const lat = req.body.lat != null && req.body.lat !== '' ? Number(req.body.lat) : null;
  const lon = req.body.lon != null && req.body.lon !== '' ? Number(req.body.lon) : null;
  setConfig('home.lat', lat);
  setConfig('home.lon', lon);
  nodeList.refilter();
  res.json({ lat, lon });
});

app.use('/rotator', rotatorRouter);

app.get('/schema/rotator_config', (req, res) => res.json(ROTATOR_CONFIG_SCHEMA));

// node-dash-owned schema endpoints (must be before bridge proxy)
app.get('/schema/bridge_config', (req, res) => res.json(BRIDGE_CONFIG_SCHEMA));

// -- range test log (SQLite-persisted, survives restarts) --------------------

app.use(createPerformanceRouter(broadcastAll));

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
  const rows = queryRangeTestLog(limit).map(r => ({
    ...r,
    from_name: resolveNodeLabel(r.from_num),
    rx_name:   resolveDeviceLabel(r.rx_device),
  }));
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

app.use(tracerouteRouter);

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

app.post('/purge-nodedb', async (req, res) => {
  const { device: nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  try {
    const result = await bridge.post(`/${nodeId}/purge_nodedb`, {});
    const nodeCount = result?.node_count ?? null;
    const ts = Math.floor(Date.now() / 1000);
    setConfig(`auto_purge_last_run_ts_${nodeId}`, ts);
    broadcastAll({ type: 'auto_purge_complete', device: nodeId, ts, node_count: nodeCount });
    res.json({ ok: true, node_count: nodeCount });
  } catch (e) {
    broadcastAll({ type: 'auto_purge_error', device: nodeId, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.use(messagesRouter);

// -- real-time enforcement guard --------------------------------------------
// Sec-Fetch-Dest: empty is set by browsers on every JS fetch() call and cannot
// be forged by JavaScript. Server-side calls, curl, and Postman never send it.
// Endpoints listed here must only be consumed via WebSocket /events — any
// browser polling attempt is rejected hard so the violation is unmissable.
const WS_ONLY_ROUTES = new Set(['/devices']);

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const path = '/' + req.path.split('/')[1]; // first segment only
  if (!WS_ONLY_ROUTES.has(path)) return next();
  if (req.headers['sec-fetch-dest'] !== 'empty') return next(); // server-side / curl — allow
  return res.status(410).json({
    error:   'ws_only',
    message: 'GET /devices is not available to browser clients. Subscribe to the WebSocket stream — device_list events carry real-time device state.',
    ws:      '/events',
  });
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

app.use('/alerts', alertsRouter);


// -- OpManager (must register before static middleware to avoid catch-all) ---
// broadcastAll is defined after wss; forward-reference via closure.
let _broadcast = () => {};
const opManager = new OpManager((msg) => _broadcast(msg), bridge);
app.use('/ops', opManager.router);  // POST /ops, GET /ops/manifest, GET /ops/:op_id

// -- static files -----------------------------------------------------------
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0, index: false }));

// Debug monitor — served directly, not through the SPA assembler
app.get('/debug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'debug.html')));

// Catch-all: serve assembled index.html for any unrecognised path (SPA deep-links)
app.use((req, res) => serveIndex(req, res));

// -- server + WS relay -------------------------------------------------------
const server = http.createServer(app);
const getRangeTimer = () => {
  const remaining = _rangeTimer.endsAt ? Math.max(0, Math.round((_rangeTimer.endsAt - Date.now()) / 1000)) : null;
  return { ..._rangeTimer, remaining };
};
const wss = attachWsRelay(server, getRangeTimer);

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
_broadcast = broadcastAll;  // wire forward reference

server.listen(PORT, () => {
  console.log(`[node-dash] listening on port ${PORT}`);
  bridge.start();
  rotator.start();
  startAlertPoller(nodeList);
  startImapReceiver();
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
  const rotatorId = getRotatorAddress();
  if (contact.from && rotatorId)
    nodeList.confirmScanContact(contact.from, rotatorId, contact.az, contact.rssi, contact.snr);
  if (FF.SSOT_TRACEROUTE && contact.from) {
    const sender = resolvePrimaryNodeId();
    if (sender)
      traceroute.dispatch({ to: contact.from, device: sender, cooldownMs: TRACE_COOLDOWN_MS, cooldownKey: contact.from })
        .catch(() => {});
  }
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
  if (ev.type === 'node_update') {
    nodeList.handleNodeUpdate(ev);
    const node = ev.data;
    const em = node?.environment_metrics;
    if (em && node?.num && ownDeviceNums().has(node.num) && (em.temperature != null || em.relative_humidity != null)) {
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
    const rxDevice = ev.addr || ev.device || null;
    const rotatorId = getRotatorAddress();
    const yagiOnly = scanner.active && rotatorId && rxDevice !== rotatorId;
    if (pkt?.from && !yagiOnly) nodeList.touchLastHeard(pkt.from, pkt.rx_time, rxDevice);
    // environment_metrics are now handled via the typed `telemetry` event from AppRouter
    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
    if (!FF.SSOT_TRACEROUTE) {
      if (pkt?.decoded?.portnum === 'TRACEROUTE_APP' && pkt?.decoded?.route_discovery && pkt?.from) {
        const rd = pkt.decoded.route_discovery;
        const relay_positions = {};
        for (const num of rd.route ?? []) {
          const info = stmts.getNodeinfoByNum.get(num);
          if (info?.lat != null && info?.lon != null) {
            relay_positions[num] = { latitude_i: Math.round(info.lat * 1e7), longitude_i: Math.round(info.lon * 1e7) };
          }
        }
        nodeList.setTraceroute(pkt.from, {
          route:       rd.route       ?? [],
          route_back:  rd.route_back  ?? [],
          snr_towards: rd.snr_towards ?? [],
          snr_back:    rd.snr_back    ?? [],
          relay_positions,
          ts: Date.now(),
        }, pkt.to ?? null, rxDevice);
      }
    // ── [V2] SSOT — traceroute.js owns decode, relay_positions, storage ──────
    } else {
      traceroute.handlePacket(pkt, rxDevice);
    }
    // ─────────────────────────────────────────────────────────────────────────
  }
  // traceroute: AppRouter typed event — ev.data IS the RouteDiscovery (route/snr_towards/etc).
  // Raw packet arrives separately but lacks decoded route_discovery; this bridge fills that gap.
  if (ev.type === 'traceroute' && ev.from_num) {
    const rd = ev.data ?? {};
    if (FF.SSOT_TRACEROUTE) {
      // V2: traceroute.js owns decode, relay_positions, storage, result emit
      const syntheticPkt = {
        from: ev.from_num, to: ev.to_num,
        decoded: { portnum: 'TRACEROUTE_APP', route_discovery: rd },
      };
      traceroute.handlePacket(syntheticPkt, ev.addr || ev.device || null);
    } else {
      // V1: inline storage (parallel to the raw packet path, now also covering typed event)
      if (Object.keys(rd).length) {
        const relay_positions = {};
        for (const num of rd.route ?? []) {
          const info = stmts.getNodeinfoByNum.get(num);
          if (info?.lat != null && info?.lon != null) {
            relay_positions[num] = { latitude_i: Math.round(info.lat * 1e7), longitude_i: Math.round(info.lon * 1e7) };
          }
        }
        nodeList.setTraceroute(ev.from_num, {
          route: rd.route ?? [], route_back: rd.route_back ?? [],
          snr_towards: rd.snr_towards ?? [], snr_back: rd.snr_back ?? [],
          relay_positions, ts: Date.now(),
        }, ev.to_num ?? null, ev.addr || ev.device || null);
      }
    }
  }
  // rangetest: AppRouter typed event for RANGE_TEST_APP (portnum 66)
  if (ev.type === 'rangetest') {
    try {
      const seq = parseInt((ev.data?.text || '').replace(/[^0-9]/g, '')) || null;
      insertRangeTestEntry({
        ts:        Math.floor(Date.now() / 1000),
        from_num:  ev.from_num   ?? null,
        rssi:      ev.rx_rssi    ?? null,
        snr:       ev.rx_snr     ?? null,
        hops:      ev.hops       ?? null,
        seq,
        rx_device: ev.addr || ev.device || null,
        via_mqtt:  ev.via_mqtt ? 1 : 0,
      });
    } catch (err) {
      console.error(`[range_test] DB insert failed: ${err.message}`);
    }
  }
});

// Passive tracer — must init after main bridge.on('event') so TRACEROUTE_APP
// storage (nodeList.setTraceroute) runs before the 'traced' emit is broadcast.
passiveTracer.init();

rotator.on('connected', () => {
});

// Auto-traceroute: when ACTV mode acquires a new target, send a traceroute automatically.
const TRACE_COOLDOWN_MS = 5 * 60 * 1000;

rotator.on('point_target', (data) => {
  const num    = data.point_target;
  const sender = resolvePrimaryNodeId();
  if (!num || !sender) return;

  // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
  if (!FF.SSOT_TRACEROUTE) {
    // Inline cooldown state (replaced by traceroute.js cooldown mechanism in V2)
    if (!rotator._lastTracedNum) rotator._lastTracedNum = null;
    if (!rotator._lastTracedAt)  rotator._lastTracedAt  = 0;
    const now = Date.now();
    if (num === rotator._lastTracedNum && now - rotator._lastTracedAt < TRACE_COOLDOWN_MS) return;
    rotator._lastTracedNum = num;
    rotator._lastTracedAt  = now;
    bridge.post(`/${sender}/traceroute`, { to: num }).catch(() => {});
  // ── [V2] SSOT — traceroute.js owns dispatch and cooldown ─────────────────
  } else {
    traceroute.dispatch({ to: num, device: sender, cooldownMs: TRACE_COOLDOWN_MS, cooldownKey: num })
      .catch(() => {}); // cooldown rejections are expected and silent
  }
  // ─────────────────────────────────────────────────────────────────────────
});

// -- auto-purge scheduler ---------------------------------------------------
async function runAutoPurge(nodeId) {
  console.log(`[auto-purge] wiping nodedb on ${nodeId}`);
  try {
    const result = await bridge.post(`/${nodeId}/purge_nodedb`, {});
    const nodeCount = result?.node_count ?? null;
    if (nodeCount !== null && nodeCount > 1) {
      console.warn(`[auto-purge] ${nodeId}: purge complete but node_count=${nodeCount} (expected 1)`);
    }
    const ts = Math.floor(Date.now() / 1000);
    setConfig(`auto_purge_last_run_ts_${nodeId}`, ts);
    broadcastAll({ type: 'auto_purge_complete', device: nodeId, ts, node_count: nodeCount });
    console.log(`[auto-purge] done — node_count=${nodeCount}`);
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
  const primaryMac = getPrimaryMac();
  const cfg = primaryMac ? getDeviceCfg(primaryMac) : {};

  // Seed NodeList from merged node list, then restore device attribution from SQLite.
  // nodes.device persists which device last received each node's packet across restarts.
  try {
    const allResp = await bridge.get('/nodes');
    const allNodes = Object.values(allResp?.nodes ?? {});
    nodeList.seed(allNodes, null);
    nodeList.restoreDeviceAttribution(stmts.getNodeDevices.all());
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
      handleEvent({ type: 'node_update', data: n, device: null });
    }
    console.log(`[node-dash] seeded ${entries.length} named nodes into persist`);
  } catch (err) {
    console.error(`[node-dash] persist seed failed: ${err.message}`);
  }
});
