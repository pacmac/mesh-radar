import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { bridge } from './bridge.js';
import configRouter from './config-api.js';
import deviceConfigRouter, { registerNodeIdToMacResolver, registerMacToNodeIdResolver } from './device-config.js';
import { registerMacToNumResolver } from './node-filter.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, clearNodeCache, getConfigByPrefix } from './db.js';
import { rotator } from './rotator.js';
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
import rangeTestRouter, { getRangeTimer } from './range-test-api.js';
import autoPurgeRouter, { startAutoPurgeScheduler } from './auto-purge-api.js';
import geocodeRouter from './geocode.js';
import { registerBridgeEvents } from './bridge-events.js';
import { registerStartupHandlers } from './startup.js';
import { initLifecycle } from './lifecycle.js';
import { startImapReceiver } from './imap-receiver.js';
import { resolveNodeLabel, registerMacResolver } from './node-label.js';
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

app.use('/geocode', geocodeRouter);

app.use('/range_test', rangeTestRouter);

app.use(tracerouteRouter);

app.use(autoPurgeRouter);

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
const wss = attachWsRelay(server, getRangeTimer);

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
_broadcast = broadcastAll;  // wire forward reference
startAutoPurgeScheduler(broadcastAll);

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

// Bridge event dispatch — node_update, packet, traceroute, rangetest
registerBridgeEvents(bridge);

// Scanner/dashMode/rotator/passiveTracer lifecycle wiring
initLifecycle();

registerStartupHandlers(bridge);
