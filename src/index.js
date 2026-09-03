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
import { registerNodeIdToMacResolver, registerMacToNodeIdResolver, resolvePrimaryNodeId, getAllDeviceCfgs } from './device-config.js';
import { registerMacToNumResolver } from './node-filter.js';
import { getConfig, setConfig, clearNodeCache, stmts, migrateNodeDeviceMac, migrateDeviceColumnsToMac, loadNodeMacMap } from './db.js';
import { scanner } from './scanner.js';
import { dashMode } from './dash-mode.js';
import { nodeList } from './node-list.js';
import { attachWsRelay, getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';
import { BRIDGE_CONFIG_SCHEMA } from './bridge-config-schema.js';
import { startAlertPoller } from './alerts.js';
import alertsRouter from './alerts-api.js';
import clustersRouter from './clusters-api.js';
import terrainRouter from './terrain-api.js';
import tracerouteRouter from './traceroute-api.js';
import reachRouter from './reach-api.js';
import { createPerformanceRouter } from './performance-api.js';
import rangeTestRouter, { getRangeTimer } from './range-test-api.js';
import autoPurgeRouter, { startAutoPurgeScheduler } from './auto-purge-api.js';
import geocodeRouter, { startGeocodeBackfill } from './geocode.js';
import { registerBridgeEvents } from './bridge-events.js';
import nodesApi from './nodes-api.js';
import { registerStartupHandlers } from './startup.js';
import { initLifecycle } from './lifecycle.js';
import { startImapReceiver } from './imap-receiver.js';
import { registerMacResolver, registerNodeIdResolver } from './node-label.js';
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

// ─── OBSERVATORY — ARCHIVED 2026-08-18 ───────────────────────────────────────
// Peter: "really observatory and discovery need moving out of code with the
// associated specs and put into a archive folder, tarred up so they stop
// confusing you", and "observator is deprecated."
//
// Twenty files — the engine, the observations store, the inference catalogue,
// the WS wiring, mission-runner, both browser halves, the boundary test and
// every associated spec — are in
//     archive/observatory-and-discovery-2026-08-18.tar.gz
// TARRED ON PURPOSE: loose files in an archive/ directory would still be
// grep-able and would still be read as live code, which is the confusion this
// was done to end. It was disabled behind `observatory.enabled` on 2026-08-17
// and had been costing nothing since; this removes it from sight as well.
//
// The block that stood here imported observatory.js, observations.js,
// inferences.js and observatory-ws.js, and registered a per-packet observer
// behind the same flag. Its own comment said "Delete these lines and the
// observatory's own files and node-dash is unchanged" — which is exactly what
// was done, and the claim held.
//
// WHAT DELIBERATELY DID NOT GO, because each has a live consumer:
//   relay-observation.js  core persist.js imports it — packet provenance, not
//                         observatory, despite the name
//   doors.js              standing-tasks.js imports it, and startStandingTasks()
//                         runs unconditionally below
//   discoveryConfig()     standing-tasks.js reads max_silence_days from it
//   DISCOVERY_LIMITS      rotator.js takes its hold ceiling from hold_sec[1] —
//                         and the rotator is shared with the garage alarm
//   observatory.window_days   read by snapshot-api, persist.js and
//                         standing-tasks.js. The NAME says observatory; the
//                         setting is a general analysis window and is live
//   clusters/reach/snapshot routers   still gated by `observatory.enabled`
//                         below. None of them imported anything archived
//
// So "discovery" was NOT archived as a unit: its runner is dead, but its config,
// its door model and the DISC dash mode are not. Removing those would have
// deleted working behaviour nobody asked to lose.

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
// '/traceroute_history' was listed here until 2026-08-17; the route no longer
// exists at all, so there is nothing left to protect from browser polling.
const WS_ONLY_ROUTES = new Set(['/devices', '/auto-purge', '/geocode']);
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
// '/observatory' and '/snapshot' are added only when the observatory is enabled —
// Peter, 2026-08-17: "I do not want to see this in the dashboard."
// '/messages' and '/device-config' removed 2026-09-03 — both pages are gone
// (messages-frontend-and-browser-route-removed,
// devices-management-removed-meshgw-owns-it). '/devices' STAYS: it is a real
// backend device-listing endpoint (WS-only guarded below), unrelated to the
// deleted Devices page — there is just no browser tab for it any more.
const PAGES = ['/','/overview','/radar','/nodes','/config','/devices','/range','/performance'];
if (getConfig('observatory.enabled', false)) PAGES.push('/observatory', '/snapshot');
for (const p of PAGES) {
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

// -- dash mode + scan control ------------------------------------------------
// PASV/ACTV/SCAN and the scan start/abort buttons used to live under
// /rotator/*, which read as rotator-hardware knowledge it never was — dash
// mode is node-dash's own rx/tx-role concept (dash-mode.js) and scan is
// node-dash's own sweep (scanner.js), neither commands a radio directly any
// more (both now call mesh-gw's aim plugin — 2026-09-03, task
// rotator-command-via-meshgw-aim). Moved here, out from under a router that
// no longer exists.
app.post('/mode', (req, res) => {
  const m = Number(req.body?.mode);
  if (![0, 1, 2].includes(m)) return res.status(400).json({ error: 'mode must be 0, 1 or 2' });
  dashMode.set(m);
  res.json({ mode: m });
});
app.post('/scan/start', (req, res) => { scanner.start(); res.json({ ok: true }); });
app.post('/scan/abort', (req, res) => { scanner.abort(); res.json({ ok: true }); });

app.use('/', terrainRouter);
// The observatory's own routers. Not mounted while it is disabled, so its routes
// 404 rather than serving a board built from a frozen table. Mounted at root
// because they carry their own prefixes, matching the traceroute router's
// convention rather than inventing a second one.
if (getConfig('observatory.enabled', false)) {
  app.use('/', clustersRouter);
  app.use('/', reachRouter);
  app.use('/', snapshotRouter);
}

// node-dash-owned schema endpoints (must be before bridge proxy)
app.get('/schema/bridge_config', (req, res) => res.json(BRIDGE_CONFIG_SCHEMA));

// -- range test log (SQLite-persisted, survives restarts) --------------------

app.use(createPerformanceRouter(broadcastAll));

app.use('/geocode', geocodeRouter);

app.use('/range_test', rangeTestRouter);

// traceroute-api — RESTORED 2026-08-18 with a NEW path. Peter: "you should be
// able to call this via post but no dashboard automation will be added for this
// yet."
//
// MOUNTED BEFORE THE `/!hex` PROXY BELOW, and the path deliberately carries no
// node id: `POST /traceroute` with a body. The old `POST /:nodeId/traceroute`
// matched the catch-all at the bottom of this file once its handler was deleted,
// so requests fell through to mesh-gw and transmitted with no guards and no row.
// A path the proxy regex cannot match is the fix that cannot regress.
app.use(tracerouteRouter);

// RADIO CONFIG WRITES removed 2026-09-03, task
// devices-management-removed-meshgw-owns-it — node-dash "no longer responsible
// to manage devices"; mesh-gw's own dashboard Radios page now covers
// Radio/Device/Network/Security/Antenna/Modules config editing.

app.use(autoPurgeRouter);

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

// '/ble', '/ble_devices', '/ota' and '/sections' removed 2026-09-03 — all four
// were device-management proxy surfaces (BLE pairing, OTA flash/download, the
// radio-admin section list) with zero remaining callers once
// devices-management-removed-meshgw-owns-it deleted the browser code that
// called them (verified: grepped public/*.js and every test file). '/devices'
// stays — it is a real, tested (test_node.py) device-listing endpoint,
// unrelated to device management. '/schema' stays — still serves
// /schema/bridge_config and /schema/rotator_config, both live.
const BRIDGE_PREFIXES = ['/devices', '/schema', '/bridge_config', '/node_filter', '/mqtt_publish', '/mqtt_proxy'];
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

// Two one-shot traceroute migrations REMOVED here 2026-08-17, task
// `traceroute-remove-backend-remainder`: the tx_device backfill (attributing
// historic rows to the primary radio, the only dispatcher before tx_device
// existed) and the perf.failure_epoch stamp (the point after which failures
// were recorded, so earlier windows could not fake a 100% success rate).
//
// Both had ALREADY RUN — their config guards are set, so on this database they
// were no-ops on every boot since. They are removed rather than kept because
// each exists to prepare traceroute rows for a reader, and there is no reader.
// The stored values stay in config; a rewrite that wants them can read them.

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
    // No connection to wait for any more — mesh-gw's aim plugin is stateless
    // per command (2026-09-03, task rotator-command-via-meshgw-aim).
    scanner.resume(savedScan);
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
