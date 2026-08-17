import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { bridge } from './bridge.js';
import configRouter from './config-api.js';
import snapshotRouter from './snapshot-api.js';
import { logEvent } from './hooks.js';
import { startStandingTasks } from './standing-tasks.js';
import { startCalloutRunner } from './callout-runner.js';
import { execSync } from 'child_process';
import deviceConfigRouter, { registerNodeIdToMacResolver, registerMacToNodeIdResolver, resolvePrimaryNodeId, getAllDeviceCfgs } from './device-config.js';
import deviceRemoveRouter from './device-remove.js';
import { registerMacToNumResolver } from './node-filter.js';
import { queryMessages } from './filters.js';
import { getConfig, setConfig, clearNodeCache, stmts, migrateNodeDeviceMac, migrateDeviceColumnsToMac, loadNodeMacMap } from './db.js';
import { rotator } from './rotator.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { attachWsRelay, getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { BRIDGE_CONFIG_SCHEMA } from './bridge-config-schema.js';
import { ROTATOR_CONFIG_SCHEMA } from './rotator-config-schema.js';
import { startAlertPoller } from './alerts.js';
import alertsRouter from './alerts-api.js';
import rotatorRouter from './rotator-api.js';
import clustersRouter from './clusters-api.js';
import terrainRouter from './terrain-api.js';
import reachRouter from './reach-api.js';
import messagesRouter from './messages-api.js';
import tracerouteRouter from './traceroute-api.js';
import { createPerformanceRouter } from './performance-api.js';
import rangeTestRouter, { getRangeTimer } from './range-test-api.js';
import autoPurgeRouter, { startAutoPurgeScheduler } from './auto-purge-api.js';
import geocodeRouter, { startGeocodeBackfill } from './geocode.js';
import { registerBridgeEvents } from './bridge-events.js';
import nodesApi from './nodes-api.js';
import { registerStartupHandlers } from './startup.js';
import { initLifecycle } from './lifecycle.js';
import { startImapReceiver } from './imap-receiver.js';
import { resolveNodeLabel, registerMacResolver, registerNodeIdResolver } from './node-label.js';
import { OpManager } from './op-manager.js';
import { renderPluginTabs, renderPluginNav, renderPluginHeader, renderPluginScripts } from './browser-plugins.js';

// ─── ALARM PLUGIN ────────────────────────────────────────────────────────────
// The composition root is the ONE place allowed to know a plugin exists. These
// imports register a node_status section provider and the WS wiring; nothing in
// core references either file. Delete these two lines and the alarm's own files
// and node-dash is unchanged (docs/PLUGIN_BOUNDARY_SPEC.md).
//
// The alarm plugin's four side-effect imports stood here until 2026-08-17. It
// runs as its own service now (mt-alarm-1/html, pm2 `html`, :8791) and node-dash
// names it nowhere. The load-order rule they illustrated still applies to any
// future plugin: registerWsWiring is read ONCE by attachWsRelay, so a
// registration arriving after that silently never fires — measured when it was
// late, connect replays still worked while ZERO live broadcasts arrived in 110s,
// which makes the failure invisible from the UI.

// ─── OBSERVATORY ─────────────────────────────────────────────────────────────
// The observations store and inference registry (docs/MESH_REACH_SPEC.md §7f).
// THIS IS THE ONLY PLACE IN src/ ALLOWED TO NAME IT, and
// tests/test_observatory_boundary.mjs fails if a second appears. Core emits;
// core does not reach in.
//
// Static and side-effecting, for the same reason the alarm imports above are:
// the schema is created on load, and a registration made later inside listen()
// silently never fires.
//
// Delete these lines and the observatory's own files and node-dash is unchanged.
import { observe } from './observatory.js';
import { registerPacketObserver } from './persist.js';
import { packetObservation } from './observations.js';

// Every packet becomes an observation, carrying WHERE THE ANTENNA WAS POINTING.
// That last part is the whole reason this is wired now rather than later: it is
// the only datum in the plan that cannot be reconstructed afterwards (B52).
//
// The wiring lives here because persist.js is core and may not name a plugin,
// and observations.js is kept pure so it can be tested with plain objects. The
// composition root is the one place allowed to know about all three.
registerPacketObserver((packet, device, ts, replay) => {
  const o = packetObservation(packet, device, ts, replay, rotator.status, getAllDeviceCfgs());
  if (o) observe(o);
});
// The catalogue of domain calculations. Separate from the engine on purpose:
// this file knows what a bearing is, the engine must never learn. It is the ONE
// place every inference is registered, so the whole of what node-dash works out
// can be read top to bottom (docs/modules/inferences.md). Empty today.
import './inferences.js';
// Pushes each observation to the browser as it is recorded, and replays the
// recent past to every new connection. Plugin wiring, not core — ws-relay.js
// never names the observatory.
import './observatory-ws.js';

// Name every positioned node we have never looked up. Deferred, paced, and
// idempotent — see src/geocode.js.
startGeocodeBackfill();

registerNodeIdToMacResolver(getLiveMacByNodeId);
registerMacToNodeIdResolver(getLiveNodeIdByMac);
registerMacResolver(getLiveMacByNodeId);
registerNodeIdResolver(getLiveNodeIdByMac);
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

// -- NOTHING IS CACHED ------------------------------------------------------
// Spec: docs/modules/no-cache.md
//
// Peter, 2026-08-13: "we should be browser cache free, that needs to be in the
// headers and response so that NOTHING is cached."
//
// THE INCIDENT THAT FORCED THIS. /devices returned 410 in the browser and 200 to
// curl, and no restart fixed it, because the browser was replaying a response
// dated Thu, 16 Jul 2026 — four weeks old, with an Express ETag and no
// Cache-Control at all. A cache had made a working server unreachable, on the
// one page whose entire job is to say what is true now.
//
// Registered FIRST so no route can opt out by being added later, and ETag
// generation is off because a conditional-cache validator is exactly the
// machinery that kept that 410 alive.
app.set('etag', false);
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');     // for intermediaries that predate no-store
  res.set('Expires', '0');
  next();
});

app.use(express.json());

// -- real-time enforcement guard --------------------------------------------
// Sec-Fetch-Dest: empty is set by browsers on every JS fetch() call and cannot
// be forged by JavaScript. Server-side calls, curl, and Postman never send it.
// Endpoints listed here must only be consumed via WebSocket /events — any
// browser polling attempt is rejected hard so the violation is unmissable.
const WS_ONLY_ROUTES = new Set(['/devices', '/traceroute_history', '/auto-purge', '/geocode']);
// Exact-path entries: '/config' alone is page state (WS settings event);
// '/config/radar' etc. are form reads and stay allowed.
const WS_ONLY_EXACT = new Set(['/config']);

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  // Document navigation may target the same path as a WS-only API
  // (`/config`, `/devices`). Only browser fetch/XHR page-data reads are
  // subject to the 410 guard; HTML navigations must reach the SPA stub.
  if (
    req.headers.accept?.includes('text/html')
    || req.headers['sec-fetch-mode'] === 'navigate'
    || req.headers['upgrade-insecure-requests'] === '1'
  ) return next();
  const path = '/' + req.path.split('/')[1]; // first segment only
  if (!WS_ONLY_ROUTES.has(path) && !WS_ONLY_EXACT.has(req.path)) return next();
  if (req.headers['sec-fetch-dest'] !== 'empty') return next(); // server-side / curl — allow
  // Vary as well as no-store: this URL deliberately serves the SPA shell to a
  // navigation and 410 to a browser fetch(), so a cache that keyed on the URL
  // alone would conflate them — which is precisely what poisoned /devices.
  return res.status(410).set('Vary', 'Sec-Fetch-Dest, Accept').json({
    error:   'ws_only',
    message: 'GET /devices is not available to browser clients. Subscribe to the WebSocket stream — device_list events carry real-time device state.',
    ws:      '/events',
  });
});


// Serve src/utils.js to the browser as a classic script — true SSOT.
// ESM export keywords are stripped; named functions assigned to window.
app.get('/utils.js', (req, res) => {
  const src  = readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const body = src
    .replace(/^\/\/.*$/gm, '')        // strip single-line comments
    .replace(/^export\s+/gm, '');     // strip ESM export keywords
  const names = ['haversine', 'bearing', 'signalQuality', 'numToNodeId', 'nodeIdToNum'];
  const out = `(function(){\n${body}\nif(typeof window!=='undefined')Object.assign(window,{${names.join(',')}});\n})();`;
  // no-cache STORES and revalidates; the global middleware already set no-store,
  // so this no longer overrides it back down. See docs/modules/no-cache.md.
  res.type('application/javascript').send(out);
});

// -- HTML partial assembly ---------------------------------------------------
// index.html may contain <!-- include: filename --> markers which are replaced
// with the contents of public/partials/filename at request time.
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

// Plugin partial paths are relative to public/, core partials to public/partials/.
function readPartial(rel) {
  const p = path.join(PUBLIC_DIR, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : `<!-- missing plugin partial: ${rel} -->`;
}

function assembleIndex() {
  let html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  // Generic plugin markers. With NO plugins registered every one of these
  // renders to an empty string — that is the plugin-absent case and it must
  // stay a clean no-op (docs/BROWSER_PLUGIN_SPEC.md).
  // INCLUDES FIRST. The `plugin: nav` marker lives inside drawer-sidebar.html,
  // so it does not exist in the document until that partial has been inlined.
  // Substituting markers before includes silently leaves the nav marker in
  // place as a comment — the sidebar renders, minus the plugin's entries, and
  // nothing errors. Order is load-bearing.
  html = html.replace(/<!--\s*include:\s*(\S+)\s*-->/g, (_, filename) => {
    const p = path.join(PARTIALS_DIR, filename);
    return existsSync(p) ? readFileSync(p, 'utf8') : `<!-- missing partial: ${filename} -->`;
  });
  return html
    .replace('<!-- plugin: tabs -->',    () => renderPluginTabs(readPartial))
    .replace('<!-- plugin: nav -->',     () => renderPluginNav(readPartial))
    .replace('<!-- plugin: header -->',  () => renderPluginHeader(readPartial))
    .replace('<!-- plugin: scripts -->', () => renderPluginScripts());
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

// '/control' was the alarm's page. It left with the plugin on 2026-08-17 —
// mt-alarm-1 serves its own Control page on :8791.
for (const p of ['/','/overview','/radar','/nodes','/messages','/config','/device-config','/devices','/range','/performance','/observatory']) {
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
app.use(nodesApi);
app.use('/device-config', deviceConfigRouter);
// The ONE device-removal operation — gw forget + local state cleanup (device-remove-op)
app.use('/device', deviceRemoveRouter);

app.get('/home_pos', (_req, res) => {
  res.json({ lat: getConfig('home.lat', null), lon: getConfig('home.lon', null),
             alt: getConfig('home.alt', null) });
});

// ABSENT IS NOT THE SAME AS CLEARED.
//
// This wrote null for any field the request did not carry, so a PUT with only
// `lon` erased the latitude — and op-manager's `home_position` operation declares
// example_payload {lat: null, lon: null}, which would erase both. Peter, 2026-08-05:
// "I have set that several times, something wiped it out."
//
//   key absent from the body  -> leave the stored value alone
//   key present and empty ('' or null) -> the caller means CLEAR, honour it
//
// Same distinction now applied in device-config.js for fixed_lat/fixed_lon.
// The home position is the origin every distance, bearing and cluster in this
// system is measured from; silently nulling it on a partial write is the most
// destructive thing this endpoint could do.
app.put('/home_pos', (req, res) => {
  const upd = (key, field) => {
    if (!(field in req.body)) return;                       // absent: unchanged
    const v = req.body[field];
    setConfig(key, (v === '' || v == null) ? null : Number(v));
  };
  upd('home.lat', 'lat');
  upd('home.lon', 'lon');
  // HOME ELEVATION — metres above sea level, ground at the mast base.
  // Never existed before 2026-08-05, which is why "I set it several times" never
  // persisted: there was no field. Needed by any link-budget or terrain maths,
  // none of which currently has an elevation to work from.
  upd('home.alt', 'alt');
  nodeList.refilter();
  res.json({ lat: getConfig('home.lat', null), lon: getConfig('home.lon', null),
             alt: getConfig('home.alt', null) });
});

app.use('/rotator', rotatorRouter);
// Mounted at root: the routes carry their own /clusters prefix, matching the
// traceroute router's convention rather than inventing a second one.
app.use('/', clustersRouter);
app.use('/', terrainRouter);
app.use('/', reachRouter);
app.use('/', snapshotRouter);

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
// Per-device routes: /!hex/... and /AA:BB:CC:DD:EE:FF/... — the gw accepts
// either; MAC is the canonical device key (identity Phase B, IDENTITY.md §2)
app.use(/^\/![0-9a-f]+/i, proxyToBridge);
app.use(/^\/([0-9a-f]{2}:){5}[0-9a-f]{2}/i, proxyToBridge);

app.use('/alerts', alertsRouter);


// -- OpManager (must register before static middleware to avoid catch-all) ---
// broadcastAll is defined after wss; forward-reference via closure.
let _broadcast = () => {};
const opManager = new OpManager((msg) => _broadcast(msg), bridge);
app.use('/ops', opManager.router);  // POST /ops, GET /ops/manifest, GET /ops/:op_id

// -- static files -----------------------------------------------------------
// cacheControl:false leaves the global no-store middleware's header in place
// rather than overwriting it with express.static's own; etag/lastModified off
// because both are conditional-caching validators. See docs/modules/no-cache.md.
app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false, cacheControl: false, index: false,
}));

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

// One-shot: attribute historic traceroutes to the primary radio — it was the
// only dispatcher before tx_device existed. Guarded so post-migration NULLs
// (overheard, unattributable results) are never backfilled.
if (!getConfig('migrations.traceroute_tx_device', false)) {
  const primary = resolvePrimaryNodeId();
  if (primary) {
    const n = stmts.backfillTracerouteTxDevice.run({ device: primary }).changes;
    setConfig('migrations.traceroute_tx_device', true);
    console.log(`[migrate] traceroute_history tx_device backfilled: ${n} rows → ${primary}`);
  }
}

// One-shot: mark when traceroute failure recording began. Success-rate stats
// must treat windows before this as "n/a" — no failure rows existed to count,
// so pre-epoch rates would read a fake 100%.
if (getConfig('perf.failure_epoch', null) == null) {
  setConfig('perf.failure_epoch', Math.floor(Date.now() / 1000));
  console.log('[migrate] perf.failure_epoch stamped');
}

// One-shot (identity Phase B): rewrite legacy !hex device ids to MACs in
// traceroute_history.tx_device, messages.device and messages.rx_devices —
// device attribution speaks one vocabulary (docs/IDENTITY.md §6).
if (!getConfig('migrations.device_vocab_mac', false)) {
  const pairs = Array.from(loadNodeMacMap(), ([mac, nodeId]) => ({ mac, nodeId }));
  if (pairs.length) {
    const n = migrateDeviceColumnsToMac(pairs);
    setConfig('migrations.device_vocab_mac', true);
    console.log(`[migrate] device columns !hex→MAC: ${n} rows across ${pairs.length} devices`);
  }
}

// One-shot: rewrite legacy nodes.device values stored as node_id (!hex) to BLE
// MAC, using the persisted node_mac registry. nodes.device must share the MAC
// vocabulary the node_source filter compares against (__ble_addr contract).
if (!getConfig('migrations.node_device_mac', false)) {
  const pairs = Array.from(loadNodeMacMap(), ([mac, nodeId]) => ({ mac, nodeId }));
  if (pairs.length) {
    const n = migrateNodeDeviceMac(pairs);
    setConfig('migrations.node_device_mac', true);
    console.log(`[migrate] nodes.device !hex→MAC: ${n} rows across ${pairs.length} devices`);
  }
}

server.listen(PORT, () => {
  console.log(`[node-dash] listening on port ${PORT}`);
  // DEPLOY MARKER, essentially free. pm2 does NOT watch this project (verified
  // 2026-08-03: `watch & reload: ✘`), so every restart is a deliberate deploy —
  // which makes a boot entry a reliable record of "the code changed". That is
  // Peter's "changes in logic", captured without anyone remembering to note it.
  // Task `event-log`.
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: process.cwd() }).toString().trim();
    const subject = execSync('git log -1 --format=%s', { cwd: process.cwd() }).toString().trim();
    logEvent({ kind: 'deploy', source: 'index', summary: `started ${sha} — ${subject}`, detail: { sha, subject } });
  } catch {
    // Not a git checkout, or git unavailable. A boot is still worth recording.
    logEvent({ kind: 'deploy', source: 'index', summary: 'started (revision unknown)' });
  }
  bridge.start();
  rotator.start();
  startAlertPoller(nodeList);
  // Standing analysis tasks — mine the stored data for findings, no airtime.
  // Task `hooks-standing-tasks`.
  startStandingTasks();
  // Inert until `callout.enabled` is true — the switch is Peter's (spec §10).
  startCalloutRunner();
  startImapReceiver();
  // HYDRATE THE LIVE CACHE FROM OUR OWN STORE, before any scan resume.
  //
  // Peter, 2026-08-05: "it is irrelevant how many times the engine is restarted.
  // if nodes were discovered or contacted within our window (i.e 6 days) then we
  // should use them."
  //
  // Not the radio's nodedb — that is deliberately unused. Our SQLite, gated on
  // rf_last_heard so only nodes we personally received over the air are restored,
  // and bounded by node_filters.max_age so it agrees with what the filter would
  // show anyway.
  try { nodeList.hydrateFromStore(); }
  catch (e) { console.error(`[node-dash] node hydration failed: ${e.message}`); }

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
// One-shot: seed signal_history from messages, whose rssi/snr are envelope
// values recorded at reception — the same datum, not a second source. Idempotent
// anyway via the (num, packet_id) dedup index, but guarded so it runs once.
if (!getConfig('migrations.signal_history_backfill', false)) {
  try {
    const r = stmts.backfillSignalFromMessages.run();
    console.log(`[migration] signal_history backfilled ${r.changes} rows from messages`);
    setConfig('migrations.signal_history_backfill', true);
  } catch (e) {
    console.error('[migration] signal_history backfill failed:', e.message);
  }
}

registerBridgeEvents(bridge);

// Scanner/dashMode/rotator/passiveTracer lifecycle wiring
initLifecycle();

registerStartupHandlers(bridge);
