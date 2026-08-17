import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { insertTilt, insertEnvHistory, getTiltCal, getConfig, queryRangeTestLog, queryAllTiltHistory, queryAllEnvHistory, stmts, persistNodeMac, loadNodeMacMap } from './db.js';
import { buildNodeStatus } from './node-status.js';
import { listFavourites } from './db.js';
import { queryMessages } from './filters.js';
import { handleAlertEvent } from './alerts.js';
import { dashMode, isListenerForMode, isTransmitterForMode } from './dash-mode.js';
import { passiveTracer } from './passive-tracer.js';
import { resolveNodeLabel, resolveDeviceLabel } from './node-label.js';
import { snrDbList } from './snr.js';
import { scheduleTime } from './served-time.js';
import { nodeKind, provenDoors, rolesByNum } from './node-kind.js';
import { ownDeviceNums } from './node-filter.js';
import { channelKey, setDeviceChannels, roleOf, indexFor } from './channels.js';
import { signalVerdict, marginHealth, hopsTone, blePctTone, verdictBands,
         gapTone, excessLossTone, heardTone } from './signal-verdict.js';
import { signalQuality as sigQualityPct } from './utils.js';
import { budget as linkBudget, marginDb, snrGapDb, theoreticalSnrDb,
         expectedRssiDbm, excessLossDb } from './link-budget.js';
import { getDeviceCfg as lbDeviceCfg } from './device-config.js';
import { haversine as lbHaversine } from './utils.js';
import lbDb from './db.js';

const lbPosStmt = lbDb.prepare('SELECT lat, lon FROM nodes WHERE num = ?');
const lbNodePos = (num) => { try { return lbPosStmt.get(num) || null; } catch { return null; } };

// RANGE-TEST DERIVATION, server-side (B80). The page computed expected RSSI and
// excess loss itself, carrying a third copy of the region table that had drifted
// (JP 920 vs 923, KR 920 vs 921, IN 865 vs 866) and 32.4 for the FSPL constant
// against 32.45 here. Same formula, two answers, both live.
function withRangeBudget(e, loraFor) {
  if (!e || typeof e !== 'object') return e;
  const home = { lat: getConfig('home.lat'), lon: getConfig('home.lon') };
  const pos  = e.from_num != null ? lbNodePos(e.from_num) : null;
  const distKm = (pos?.lat && pos.lat !== 0 && Number.isFinite(home.lat) && home.lat !== 0)
    ? lbHaversine(home.lat, home.lon, pos.lat, pos.lon) : null;
  // Region from the RECEIVING radio, as the page did it.
  const region = loraFor(e.rx_device)?.region ?? 'EU_868';
  const txCfg  = e.from_num != null ? lbDeviceCfg('!' + (e.from_num >>> 0).toString(16)) : null;
  const rxCfg  = e.rx_device ? lbDeviceCfg(e.rx_device) : null;
  const expected = expectedRssiDbm(distKm, region, txCfg, rxCfg);
  return {
    ...e,
    dist_km:       distKm == null ? null : +distKm.toFixed(2),
    expected_rssi: expected,
    excess_loss_db: excessLossDb(e.rssi, expected),
    // tab-range.html:64,157 coloured this itself. Lower is better here, which
    // is precisely the sort of inverted rule a :class attribute gets wrong.
    excess_loss_tone: excessLossTone(excessLossDb(e.rssi, expected)),
  };
}

import { ensureDeviceCfgMac, getDeviceCfg } from './device-config.js';
import { DEFAULTS as CONFIG_DEFAULTS } from './config-api.js';
import { getAutoPurgeCfg } from './auto-purge-api.js';
import { lookupGeocode } from './geocode.js';
import { FF } from './feature-flags.js';
import { traceroute } from './traceroute.js';
import { fmtAgo } from './format.js';
import { board } from './snapshot-api.js';
// Composed HERE rather than in any one of the three API files: reach does not
// own clusters, and terrain does not own reach. ws-relay is already the place
// that assembles a page's data from modules that do not know each other, the
// same way it does for node_status.
import { reachBySector } from './reach.js';
import { clusters } from './clusters.js';
import { visibility } from './terrain.js';

/** The radar's three overlays, in one payload.
 *
 *  EACH ONE FAILS ON ITS OWN. Terrain needs an SRTM sample that may never have
 *  been taken, and clusters need an anchor set that may not exist yet; letting
 *  either throw would take the reach ring down with it and leave a bare radar
 *  with no indication why. A missing overlay is null and the radar simply does
 *  not draw it — which is what the browser already does for a failed fetch,
 *  preserved here rather than reinvented.
 *
 *  Shapes are IDENTICAL to what the three GET routes returned, so the drawing
 *  code did not change: `reach` keeps its achieved/potential split, because
 *  what we have PROVEN and what the GROUND ALLOWS are different kinds of claim
 *  and merging them was already ruled out (reach-api.js, Peter 2026-08-05). */
function radarOverlays() {
  const out = { reach: null, clusters: null, terrain: null };

  try {
    const vis = visibility();
    out.reach = {
      achieved: reachBySector(),
      potential: vis.ready
        ? { bearings_deg: vis.bearings_deg, horizon_km: vis.horizon_km,
            shadow_deg: vis.deepest_deg, observer_asl_m: vis.observer_asl_m,
            basis: 'line-of-sight horizon from SRTM 30 m bare earth — excludes trees and buildings' }
        : { unavailable: vis.reason },
    };
  } catch (e) { console.error(`[radar] reach failed: ${e.message}`); }

  try { out.clusters = clusters({ force: false }); }
  catch (e) { console.error(`[radar] clusters failed: ${e.message}`); }

  try { out.terrain = visibility(); }
  catch (e) { console.error(`[radar] terrain failed: ${e.message}`); }

  return out;
}

// THE SNR EMIT BOUNDARY. Everything leaving for the browser carries dB, never
// the raw quarter-dB the wire uses — see src/snr.js for why that module is
// backend-only. Applied here rather than at storage: the store holds what the
// wire said.
const withSnrDb = (o) => (o && typeof o === 'object')
  ? { ...o, snr_towards: snrDbList(o.snr_towards), snr_back: snrDbList(o.snr_back) }
  : o;

// THE LINK BUDGET IS COMPUTED HERE, NOT IN THE BROWSER. Friis, FSPL, thermal
// noise floor and EIRP moved to src/link-budget.js (task perf-maths-to-backend);
// public/ no longer carries radio physics.
//
// Attributed to the row's OWN tx_device, which is more correct than what the
// browser did: it applied whichever radio the user had selected to every row.
// docs/modules/app-perf.md already says marginTx "measures the DISPATCHING
// radio's TX chain" — now it actually does.
function withLinkBudget(row, loraFor) {
  if (!row || typeof row !== 'object') return row;
  const lora = loraFor(row.tx_device);
  if (!lora) return row;                       // no config for that radio yet
  const dev  = row.tx_device ? lbDeviceCfg(row.tx_device) : null;
  const home = { lat: getConfig('home.lat'), lon: getConfig('home.lon') };

  // Distance to the FIRST HOP where there is one, else the target — the same
  // metric distance the perf page has always used, decided here now.
  const route  = Array.isArray(row.route) ? row.route.filter(n => n != null && n !== 0xffffffff) : [];
  const hopNum = route.length ? route[0] : row.to_num;
  // From the STORE, not nodeList._cache: the cache is a display projection and
  // was returning entries without lat, so every distance came back null and
  // valid_tx was false for all 500 rows.
  const pos    = hopNum != null ? lbNodePos(hopNum) : null;
  const distKm = (pos?.lat && pos.lat !== 0 && Number.isFinite(home.lat) && home.lat !== 0)
    ? lbHaversine(home.lat, home.lon, pos.lat, pos.lon) : null;

  const direct = route.length === 0;
  const snrTx = Array.isArray(row.snr_towards) && row.snr_towards.length ? row.snr_towards[0] : null;
  const back  = Array.isArray(row.snr_back) ? row.snr_back : [];
  const snrRx = back.length ? (route.length ? back[back.length - 1] : back[0]) : null;
  const r2 = (v) => v == null ? null : +v.toFixed(2);
  const validTx = snrTx != null && distKm != null && distKm > 0.1;

  return {
    ...row,
    snr_tx_db:      r2(snrTx),
    snr_rx_db:      r2(snrRx),
    margin_tx_db:   r2(marginDb(snrTx, lora)),
    gap_tx_db:      r2(snrGapDb(snrTx, distKm, lora, dev)),
    theo_snr_db:    r2(theoreticalSnrDb(distKm, lora, dev)),
    metric_dist_km: distKm == null ? null : +distKm.toFixed(1),
    // Enough evidence to plot: a reading, a real distance, and not on our doorstep.
    valid_tx:       validTx,
    // VERDICTS, decided here. The page derived confidence, route kind and the
    // distance label from `direct` and `validTx` itself — BROWSER_CONTRACT: "if
    // a display differs based on a condition, that condition is evaluated in
    // Node.js". `direct` means the target WAS the first hop, i.e. no relay.
    direct,
    route_kind:     direct ? 'direct' : 'first-hop',
    dist_label:     direct ? 'target' : 'first hop',
    confidence:     !validTx ? 'low' : direct ? 'high' : 'medium',
    // HEADROOM VERDICT, decided here. app-perf.js:308-315 turned this same
    // margin into Excellent/Good/Usable/Fragile/Failing, and :333-344 chose the
    // bar count from one band table and the colour from a DIFFERENT one. Both
    // now come from marginHealth(). `bars` is a count; the browser draws them.
    health:         marginHealth(r2(marginDb(snrTx, lora))),
    // tab-perf.html:243 held <15/<35 for the SNR gap. Lower is better.
    gap_tone:       gapTone(r2(snrGapDb(snrTx, distKm, lora, dev))),
  };
}

function makeRotatorThrottle(sendFn) {
  let lastMs    = 0;
  let lastBusy  = undefined;
  let lastStall = undefined;
  let lastDir   = undefined;
  return (data) => {
    const now          = Date.now();
    const stateChanged = data.busy !== lastBusy || data.stall !== lastStall || data.dir !== lastDir;
    const interval     = data.busy ? 100 : 1000;
    if (stateChanged || now - lastMs >= interval) {
      lastMs = now; lastBusy = data.busy; lastStall = data.stall; lastDir = data.dir;
      sendFn(data);
    }
  };
}

// State event types from the bridge BLE state machine — buffered per device
const STATE_EVENT_TYPES = new Set(['device_state', 'device_data']);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

// Module-level map: uppercase BLE MAC → live firmware node_id (!hexid).
// Populated from device_snapshot and device_data events. Used by callers that
// need the authoritative node_id rather than a MAC-derived approximation.
const _liveNodeIds = new Map();

// Assigned inside attachWsRelay; lets device-config re-broadcast the device
// list after a settings write (C2 — the browser reads settings from WS).
let _pokeDeviceList = () => {};
export function pokeDeviceList() { _pokeDeviceList(); }

// Assigned inside attachWsRelay; messages-api calls this after persisting a
// sent message. A gateway radio never receives its own transmission, so
// without this rebroadcast only the sending session (optimistic entry) ever
// saw a TX message (task message-tx-broadcast).
let _broadcastMessageHistory = () => {};
export function broadcastMessageHistory() { _broadcastMessageHistory(); }

// Assigned inside attachWsRelay; device-remove uses it to drop a removed
// device from the in-memory state and push a fresh device_list. Before this
// existed, lastDeviceState was add-only and removed devices were re-broadcast
// forever (task device-remove-op).
let _pruneDevice = () => {};
export function pruneDevice(mac, nodeId = null) {
  _liveNodeIds.delete(mac.toUpperCase());
  _pruneDevice(mac, nodeId);
}

// Settings live on the WS (settings-via-ws): replayed on connect, re-broadcast
// after every config write so all tabs see filter/radar changes immediately.
let _broadcastSettings = () => {};
// GENERIC settings-changed hook. A plugin whose feed depends on a config value
// cannot wait for its own recompute timer — the observatory's is 15 minutes, and a
// control whose effect appears a quarter of an hour later is not a control. Core
// must not import or name the plugin (this file once named pac-host seven times),
// so the plugin subscribes and core merely announces. Task `observatory-window`.
const _settingsListeners = [];
export function registerSettingsListener(fn) { _settingsListeners.push(fn); }

export function broadcastSettings() {
  _broadcastSettings();
  for (const fn of _settingsListeners) {
    // Isolated: one plugin throwing must not stop the others being told, nor
    // fail the config write that triggered this.
    try { fn(); } catch (e) { console.error(`[ws-relay] settings listener failed: ${e.message}`); }
  }
}

// ─── Plugin hooks ────────────────────────────────────────────────────────────
//
// This module is CORE — it serves the WebSocket for every page. It must not
// import, name or branch on a plugin. It used to do all three for pac-host,
// seven times, and deleting the alarm therefore meant editing core.
//
// Peter, 2026-07-29, on being told six of the seven pre-dated that day's work:
// "makes no difference if they were added today or not they break the rules and
// need fixing."
//
// A plugin needs exactly three things from here, all generic: broadcast to every
// client, contribute messages to each new connection, and hint node_status for a
// num. Core learns nothing about what a plugin is for.
const _wsWirings     = [];
const _connectReplays = [];

/** Wire a plugin's own event sources to the WS. Called ONCE from
 *  attachWsRelay with the host services — deferred because `broadcast` is a
 *  closure that does not exist at import time. */
export function registerWsWiring(fn) { _wsWirings.push(fn); }

/** Contribute messages replayed to every NEW connection. Returns an array.
 *  An empty array contributes nothing, which makes "no plugin installed" and
 *  "this plugin has nothing to say yet" the same code path. */
export function registerConnectReplay(fn) { _connectReplays.push(fn); }

// Seed from persisted mapping so ownDeviceNums() is correct immediately on cold start.
for (const [mac, nodeId] of loadNodeMacMap()) {
  _liveNodeIds.set(mac, nodeId);
}

// Resolve a stored message's (device MAC, channel INDEX) to the LOGICAL channel
// name. The stored `channel` is the per-gateway index in both directions, and the
// same number is a different channel on different radios ((OMNI,1)=mqtt vs
// (YAGI,1)=Private) — so resolution MUST be per-device. Pure read of the
// already-maintained lastDeviceChannels cache; no network call. Unnamed PRIMARY
// resolves to 'Primary' (its identity by role); unknown/uncached → null.
export function getChannelNameByMac(mac, index) {
  if (!mac) return null;
  const chans = lastDeviceChannels[mac.toUpperCase()];
  if (!Array.isArray(chans)) return null;
  const c = chans.find(c => c.index === Number(index));
  if (!c) return null;
  return c.name || (c.role === 'PRIMARY' ? 'Primary' : null);
}

export function getLiveNodeIdByMac(mac) {
  return mac ? (_liveNodeIds.get(mac.toUpperCase()) ?? null) : null;
}

export function getLiveMacByNodeId(nodeId) {
  if (!nodeId) return null;
  for (const [mac, id] of _liveNodeIds.entries()) {
    if (id === nodeId) return mac;
  }
  return null;
}

// Session-level seen packet IDs for live TEXT_MESSAGE_APP events.
// Cleared on bridge reconnect. Prevents duplicate live events reaching the browser
// when the same packet is heard by multiple gateway radios.
const _seenLivePktIds = new Set();

// node_status_update carries ONLY a num — never a value. The browser re-requests
// the RPC, so there is exactly one code path producing displayed values and no
// chance of a pushed value disagreeing with a fetched one.
// Throttled per node: a burst of packets must not storm connected browsers.
// This is a delivery concern, not a data decision.
// MAC -> configured channels.
const lastDeviceChannels = {};

const _lastStatusHint = new Map();   // num → ms
const STATUS_HINT_MS = 1000;

function _hintNodeStatus(num, broadcast) {
  if (!num) return;
  const now = Date.now();
  if (now - (_lastStatusHint.get(num) ?? 0) < STATUS_HINT_MS) return;
  _lastStatusHint.set(num, now);
  if (_lastStatusHint.size > 2000) {
    _lastStatusHint.delete(_lastStatusHint.keys().next().value);
  }
  broadcast({ type: 'node_status_update', num });
}

// Tilt broadcasts are heard by both radios — decode each packet id once.
const _seenTiltPktIds = new Set();
// The firmware also emits the same reading twice with DIFFERENT packet ids
// (BLE sendToPhone copy + LoRa broadcast) — dedupe identical payloads per
// device within a short window.
const _lastTiltPayload = new Map(); // devKey → { b64, ts }

// Tilt payload decode — struct version detected by length.
// 24 B: TiltSummaryV2 (centidegrees). 20 B: legacy float32x5 [roll, pitch,
// x_g, y_g, z_g] — the struct current RAK firmware emits. Anything else
// is ignored. devKey is node_id-preferred (interim, task tilt-ingest-v2):
// the browser tilt gate and history slice compare against activeNodeId
// (!hex); tilt_history re-keying to MAC belongs to the identity migration.
function _handleTiltPayload(b64, devKey, fromNum, handleAlertEvent, broadcast) {
  const last = _lastTiltPayload.get(devKey);
  const now  = Date.now();
  if (last && last.b64 === b64 && now - last.ts < 10000) return;
  _lastTiltPayload.set(devKey, { b64, ts: now });
  const buf = Buffer.from(b64 || '', 'base64');
  let dbRow = null, data = null;
  if (buf.length === 24) {
    const v           = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    data = {
      version:      v.getUint8(0),
      sample_count: v.getUint8(1),
      window_ms:    v.getUint16(2,  true),
      roll:         v.getInt16(4,   true) / 100,
      pitch:        v.getInt16(6,   true) / 100,
      avg_roll:     v.getInt16(8,   true) / 100,
      avg_pitch:    v.getInt16(10,  true) / 100,
      min_roll:     v.getInt16(12,  true) / 100,
      max_roll:     v.getInt16(14,  true) / 100,
      min_pitch:    v.getInt16(16,  true) / 100,
      max_pitch:    v.getInt16(18,  true) / 100,
      max_delta:    v.getUint16(20, true) / 100,
      rms_motion:   v.getUint16(22, true) / 100,
    };
    dbRow = { ...data };
  } else if (buf.length === 20) {
    const v     = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const roll  = Math.round(v.getFloat32(0,  true) * 100) / 100;
    const pitch = Math.round(v.getFloat32(4,  true) * 100) / 100;
    const x_g   = Math.round(v.getFloat32(8,  true) * 1000) / 1000;
    const y_g   = Math.round(v.getFloat32(12, true) * 1000) / 1000;
    const z_g   = Math.round(v.getFloat32(16, true) * 1000) / 1000;
    data  = { roll, pitch, x: x_g, y: y_g, z: z_g, version: 0 };
    dbRow = {
      roll, pitch, version: 0,
      sample_count: null, window_ms: null,
      avg_roll: null, avg_pitch: null, min_roll: null, max_roll: null,
      min_pitch: null, max_pitch: null, max_delta: null, rms_motion: null,
    };
  } else {
    return;
  }
  try {
    insertTilt({ ts: Math.floor(Date.now() / 1000), node_id: devKey, ...dbRow });
  } catch (e) { console.error('[tilt] insert failed:', e.message); }
  const tiltEv = { type: 'tilt_update', device: devKey, from_num: fromNum, data };
  handleAlertEvent(tiltEv);
  broadcast(tiltEv);
}

// Returns the set of own gateway node numbers (uint32) from the live node_id map.
function _ownNums() {
  const nums = new Set();
  for (const nodeId of _liveNodeIds.values()) {
    if (nodeId && nodeId.startsWith('!')) {
      const n = parseInt(nodeId.slice(1), 16);
      if (n) nums.add(n);
    }
  }
  return nums;
}

// Pre-compute direction, thread_root_packet_id, is_orphan, reply_depth for
// every row so the browser renders without deriving any of these itself.
function _enrichMessages(rows) {
  const own = _ownNums();
  const byPktId = new Map();
  for (const r of rows) {
    r.direction = own.has(r.from_num) ? 'tx' : 'rx';
    if (r.packet_id) byPktId.set(r.packet_id, r);
  }

  const rootCache = new Map();
  function findRoot(pktId, visited) {
    if (!pktId) return pktId;
    if (rootCache.has(pktId)) return rootCache.get(pktId);
    if (visited.has(pktId)) { rootCache.set(pktId, pktId); return pktId; }
    const r = byPktId.get(pktId);
    if (!r || !r.reply_id || !byPktId.has(r.reply_id)) {
      rootCache.set(pktId, pktId);
      return pktId;
    }
    visited.add(pktId);
    const root = findRoot(r.reply_id, visited);
    rootCache.set(pktId, root);
    return root;
  }

  for (const r of rows) {
    r.thread_root_packet_id = findRoot(r.packet_id, new Set()) ?? r.packet_id;
    r.is_orphan             = !!(r.reply_id && !byPktId.has(r.reply_id));
    let depth = 0, cur = r;
    const visited = new Set();
    while (cur && cur.reply_id && byPktId.has(cur.reply_id) && !visited.has(cur.packet_id)) {
      visited.add(cur.packet_id);
      cur = byPktId.get(cur.reply_id);
      depth++;
    }
    r.reply_depth = depth;
  }

  // Sort into display order: threads newest-first (by latest message in thread),
  // replies within a thread oldest-first directly after their root.
  const threadLatest = new Map();
  for (const r of rows) {
    const root = r.thread_root_packet_id ?? r.packet_id;
    if (root != null && (r.ts || 0) > (threadLatest.get(root) || 0)) {
      threadLatest.set(root, r.ts);
    }
  }
  rows.sort((a, b) => {
    const rootA = a.thread_root_packet_id ?? a.packet_id;
    const rootB = b.thread_root_packet_id ?? b.packet_id;
    const latestDiff = (threadLatest.get(rootB) || 0) - (threadLatest.get(rootA) || 0);
    if (latestDiff !== 0) return latestDiff;
    return (a.ts || 0) - (b.ts || 0);
  });
  return rows;
}

export function attachWsRelay(server, getRangeTimer = () => ({ active: false, endsAt: null, nodeId: null })) {
  const wss = new WebSocketServer({ noServer: true });

  // Last-known BLE state per device (addr → event object).
  // Seeded from device_snapshot on bridge connect, then kept live by WS events.
  // Replayed to new frontend clients on connect — no per-client HTTP calls.
  const lastDeviceState = {};
  // Last-known device list — replayed to new frontend clients on connect.
  // Composed from lastDeviceState in memory — no HTTP calls after startup.
  let lastDeviceList = null;

  // Single enrichment point — every outbound event passes through here.
  // Adds pre-resolved display labels so the UI never needs to resolve names itself.
  function enrichEvent(ev) {
    if (ev.type === 'node_list') {
      // Favourite nav entries are computed HERE, not derived in the browser:
      // BROWSER_CONTRACT — "if a display differs based on a condition, that
      // condition is evaluated in Node.js".
      // Resolved ONCE per emission, not per node: node_list carries hundreds of
      // rows and both of these are set lookups behind a query.
      const _doorSet = provenDoors();
      const _ownNums = ownDeviceNums();
      const _roleMap = rolesByNum();
      return { ...ev, favourites: listFavourites(), nodes: (ev.nodes || []).map(n => {
        // First-hop relay bundle (IDENTITY.md §3) — a traceroute-context
        // fact the browser renders without resolving (task radar-list-via)
        const viaNum = n.last_traceroute?.route?.[0];
        const via = (viaNum != null && viaNum !== 0xffffffff)
          ? { num: viaNum, node_id: '!' + (viaNum >>> 0).toString(16).padStart(8, '0'), short_name: resolveNodeLabel(viaNum) }
          : null;
        // Hops-away DISPLAY decision (backend-owned; UI is presentation only).
        // Verified (traceroute relay count; 0 = direct) takes priority over
        // reported (live packet hops). See ws-relay.md "hops-display".
        // SIGNAL VERDICT, decided here. The browser turned a percentage into
        // "Excellent / Good / Fair / Poor" using >=76/51/26 while the colour ramp
        // beside it used >=75/50/25 — a node at 75% read "Good" in the excellent
        // colour. One set of bands now, in src/signal-verdict.js.
        const hasSig = n.rssi != null || n.snr != null;
        const signal = signalVerdict(hasSig ? sigQualityPct(n.rssi, n.snr) : null,
                                     { hasReading: hasSig });
        const route = n.last_traceroute?.route;
        const hops_verified = Array.isArray(route) ? route.length : null;
        const hops_display = hops_verified ?? (n.hops_away ?? n.hops ?? null);
        // Freshness of the verification: true while the traceroute is within the
        // passive auto-tracer's staleness window (pasv_config.stale_sec, ms ts) —
        // i.e. NOT fresh == old enough that we'd re-trace it. UI shows a green
        // (fresh) vs amber (stale) dot; the threshold decision stays here.
        const staleMs = (getConfig('pasv_config', {}).stale_sec ?? 1800) * 1000;
        const traceTs = n.last_traceroute?.ts;
        const hops_fresh = hops_verified != null && traceTs != null && (Date.now() - traceTs) <= staleMs;
        // Hop-count TONE decided here — app-components.js:43-45 held the
        // 0/1/2 thresholds. The badge's TEXT (Direct vs "n hops", the
        // verified/reported suffix) is display composition and stays there.
        return { ...n, display_name: resolveNodeLabel(n.num), via, hops_verified, hops_display, hops_fresh, signal,
                 hops_tone: hopsTone(hops_display),
                 // WHAT THIS NODE IS TO US — own / door / router / endpoint.
                 // Decided here so the radar can draw a different icon per kind
                 // without deciding which; BROWSER_CONTRACT. `door` outranks
                 // `router` because a relay we have PROVEN we can transmit
                 // through beats one that merely declares the role — 8 of our
                 // 13 doors declare no router role at all. See node-kind.js.
                 node_kind: nodeKind(n.num, n.role, { doors: _doorSet, own: _ownNums, roles: _roleMap }),
                 // tab-nodes.html:163-164 did its own Date.now() arithmetic AND
                 // set the bands. Age is server-side; the row renders a tone.
                 heard_tone: heardTone(n.last_heard == null ? null : (Date.now() / 1000) - n.last_heard) };
      }) };
    }
    if (ev.type === 'device_list') {
      return { ...ev, devices: (ev.devices || []).map(d => ({ ...d, display_name: resolveDeviceLabel(d.node_id) })) };
    }
    if ((ev.type === 'range_test_entry') && ev.data) {
      return { ...ev, from_name: resolveNodeLabel(ev.data.from_num), rx_name: resolveDeviceLabel(ev.device) };
    }
    return ev;
  }

  function broadcast(msg) {
    const data = JSON.stringify(enrichEvent(msg));
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  function sendEnriched(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(enrichEvent(msg)));
  }

  // Plugin wiring. Core hands over its host services and learns nothing about
  // what any plugin does with them. Called here rather than at import time
  // because `broadcast` is a closure created above.
  for (const wire of _wsWirings) {
    wire({ broadcast, hintNodeStatus: (num) => _hintNodeStatus(num, broadcast) });
  }

  bridge.on('connected',    () => { _seenLivePktIds.clear(); broadcast({ type: 'bridge_connected' }); });
  bridge.on('disconnected', () => {
    broadcast({ type: 'bridge_disconnected' });
    handleAlertEvent({ type: 'bridge_disconnected' });
  });

  // Per-device radio lora config, fetched from the gw when a device is READY
  // and after reboots — device_list carries it so the browser never GETs it
  // (C2: page data is WS-only).
  const lastDeviceLora = {};
  async function refreshDeviceLora(addr) {
    if (!addr) return;
    try {
      const r = await bridge.get(`/${addr}/config/lora`);
      if (r?.lora) {
        lastDeviceLora[addr.toUpperCase()] = r.lora;
        broadcastDeviceList();
      }
    } catch (e) { /* device not ready yet — next READY transition retries */ }
  }

  // Configured channels per radio — same lifecycle as lastDeviceLora. The
  // send form lists channels by NAME and hides unconfigured slots, and the
  // browser holds zero gw knowledge, so this rides the device_list too
  // (device-channels-on-list). Refreshed on READY; channel edits that reboot
  // the radio (role changes) self-refresh via the next READY.
  async function refreshDeviceChannels(addr) {
    if (!addr) return;
    try {
      const r = await bridge.get(`/${addr}/channels`);
      if (Array.isArray(r?.channels)) {
        // IDENTITY IS NAME + KEY — see docs/modules/channels.md. Index fails
        // (Private is 2 on one of our radios and 1 on the other), and key alone
        // fails too: our two PRIMARYs share a key while one is unnamed and one is
        // named `Public`, and they are NOT the same channel on air. That mistake
        // cost five days of the YAGI. The KEY ITSELF IS NEVER KEPT, only the
        // hash; `psk` is in the browser's SENSITIVE_FIELDS for the same reason
        // and this must not be the place that walks it back.
        lastDeviceChannels[addr.toUpperCase()] = r.channels
          .map((c, i) => ({
            index: c.index ?? i,
            name:  c.settings?.name ?? '',
            role:  c.role ?? null,
            key:   channelKey(c.settings?.name, c.settings?.psk),
          }))
          .filter(c => c.role === 'PRIMARY' || c.role === 'SECONDARY');
        // One table, two readers. The resolver holds exactly what the send form is
        // built from, so "which channel is this" and "what is in the dropdown" can
        // never disagree.
        //
        // The live node id is passed as an ALIAS because this is the one place
        // that knows both halves. Callers such as callout are handed a node id by
        // dash-mode.transmitterForMode() and never see a MAC; registering both
        // here keeps the conversion at one boundary instead of at every call site.
        setDeviceChannels(addr, lastDeviceChannels[addr.toUpperCase()],
                          getLiveNodeIdByMac(addr));
        broadcastDeviceList();
      }
    } catch (e) { /* device not ready yet — next READY transition retries */ }
  }

  function broadcastDeviceList() {
    // Compose from in-memory lastDeviceState — never makes an HTTP call.
    // lastDeviceState is seeded once at startup from GET /devices, then kept
    // live by the WS event stream. All configured devices are always present.
    // Each device carries its node-dash settings (cfg, MAC-keyed store) and
    // radio lora config so the browser reads page data from WS alone.
    const mode = dashMode.value;
    const devices = Object.values(lastDeviceState).map(d => ({
      ...d,
      cfg:  d.addr ? getDeviceCfg(d.addr) : null,
      lora: d.addr ? (lastDeviceLora[d.addr.toUpperCase()] ?? null) : null,
      // The theory for THIS radio, computed server-side. The browser showed
      // sensitivity/EIRP/max-range by running Friis itself; now it renders them.
      link_budget: d.addr && lastDeviceLora[d.addr.toUpperCase()]
        ? linkBudget(lastDeviceLora[d.addr.toUpperCase()], lbDeviceCfg(d.addr))
        : null,
      // The browser gets a SERVED `designated` ('pub' | 'pri' | null), never the
      // identity hash it was derived from. Two reasons, and the second matters
      // more: the hash is key-derived and has no business leaving the backend,
      // and the browser decides nothing — it must not be handed the raw material
      // to work out a channel's identity for itself. See docs/BROWSER_CONTRACT.md
      // and docs/modules/channels.md.
      // `null` when the radio has not reported yet is PRESERVED, not flattened to
      // []: the send form distinguishes "no channels known" from "none configured".
      channels: (d.addr && lastDeviceChannels[d.addr.toUpperCase()])
        ? lastDeviceChannels[d.addr.toUpperCase()].map(
            ({ key, ...c }) => ({ ...c, designated: roleOf(d.addr, c.index) }))
        : null,
      // WHICH CHANNEL THE SEND FORM STARTS ON, DECIDED HERE.
      //
      // The browser is a presentation layer: it does not choose a channel. It
      // was choosing one — `msgChannel: '0'` at app.js:215, a fallback to 0 in
      // tab-messages.html, and no validation at all in tab-shared.html — and a
      // channel INDEX means different things on different radios. On the YAGI,
      // index 0 is a primary named `Public` that nothing is listening to, and it
      // EXISTS, so a "is this index valid" check passes and the send silently
      // goes nowhere.
      //
      // PRIVATE, not public. `pri` resolves on every radio we have, and an
      // accidental send must never land on the public mesh. Public stays
      // available by deliberately selecting it, which is the point.
      //
      // null when it cannot be resolved — the form must then refuse rather than
      // fall back to a number, exactly as sendMeshText now does.
      default_channel: d.addr ? indexFor(d.addr, 'pri') : null,
      // BLE link tone — app-components.js:80 held >=50/25. This is the BLE
      // percentage the gateway reports, NOT a LoRa measurement, so it keeps its
      // own two bands rather than signalVerdict's 76/51/26.
      signal_pct_tone: blePctTone(d.signal_pct),
      auto_purge: getAutoPurgeCfg(d.node_id ?? d.addr),
      // Per-radio role for the CURRENT mode — the browser renders RX/TX badges
      // from this and makes no decision (BROWSER_CONTRACT).
      mode_role: d.addr ? { rx: isListenerForMode(mode, d.addr), tx: isTransmitterForMode(mode, d.addr) } : null,
    }));
    lastDeviceList = { type: 'device_list', devices };
    broadcast(lastDeviceList);
  }
  _pokeDeviceList = broadcastDeviceList;
  // Enriched message history — used for the on-connect replay and rebroadcast
  // to all clients after a dash send (message-tx-broadcast). 200 rows: bot
  // chatter churned the old 50-row window within hours.
  function buildMessageFeedRows() {
    // hops_tone: tab-messages.html calls hopsBadge(m.hops), which held the
    // 0/1/2 threshold in the browser. Same decision, same owner as the node feed.
    return _enrichMessages(queryMessages(200).map(r => ({
      ...r, display_name: resolveNodeLabel(r.from_num), hops_tone: hopsTone(r.hops),
    })));
  }
  function buildMessageHistoryEvent(rows) {
    return { type: 'message_history', messages: rows ?? buildMessageFeedRows() };
  }
  _broadcastMessageHistory = () => {
    try {
      broadcast(buildMessageHistoryEvent());
    } catch (e) { console.error('[ws-relay] message history rebroadcast failed:', e.message); }
  };

  _pruneDevice = (mac, nodeId) => {
    const MAC = mac.toUpperCase();
    for (const key of Object.keys(lastDeviceState)) {
      const e = lastDeviceState[key];
      // Match by MAC, and by node_id to catch historic node_id-keyed duplicates.
      if (key.toUpperCase() === MAC ||
          (nodeId && (e?.node_id === nodeId || e?.state_event?.node_id === nodeId))) {
        delete lastDeviceState[key];
      }
    }
    delete lastDeviceLora[MAC];
    broadcastDeviceList();
  };

  function settingsEvent() {
    const config = {};
    for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
      config[key] = getConfig(key, fallback);
    }
    return { type: 'settings', config };
  }
  _broadcastSettings = () => broadcast(settingsEvent());

  bridge.on('event', (ev) => {
    // Any event carrying a node num means that node's status may have changed.
    // Hint only — no payload, the browser re-requests. Deliberately format-blind
    // and port-blind: no inspection of what changed, so a new port or field
    // never needs a change here.
    _hintNodeStatus(ev.from_num ?? ev.data?.packet?.from ?? null, broadcast);

    if (ev.type === 'device_snapshot') {
      for (const d of (ev.devices || [])) {
        if (!d.addr) continue;
        ensureDeviceCfgMac(d.addr, d.node_id ?? d.data_event?.node_id);
        // Flatten state_event + data_event into top level so browser reads dev.node_id etc. directly
        const flat = { ...d };
        if (d.state_event) Object.assign(flat, d.state_event);
        if (d.data_event)  Object.assign(flat, d.data_event);
        flat.state_event = d.state_event;
        flat.data_event  = d.data_event;
        // ble_state: lowercase state for UI logic (devBleState, devIsReady, etc.)
        flat.ble_state = (d.state_event?.state || 'OFFLINE').toLowerCase();
        lastDeviceState[d.addr] = flat;
        if (flat.ble_state === 'ready') { refreshDeviceLora(d.addr); refreshDeviceChannels(d.addr); }
        if (flat.node_id) {
          _liveNodeIds.set(d.addr.toUpperCase(), flat.node_id);
          persistNodeMac(flat.node_id, d.addr.toUpperCase());
        }
      }
      broadcastDeviceList();
      return;
    }

    // Keep last-known state current as events flow through, then broadcast.
    // All state types update the in-memory map — OFFLINE devices stay visible.
    // seed populates { addr, state_event:{...}, data_event:{...} } — live events
    // must update the nested key, not spread flat on top of it.
    const evAddr = ev.addr || getLiveMacByNodeId(ev.device) || ev.device;
    if (evAddr && STATE_EVENT_TYPES.has(ev.type)) {
      // Ghost guard (device-remove-op): only a MAC-shaped key may CREATE an
      // entry — node_id-keyed strays previously became no-name ghost devices.
      if (!lastDeviceState[evAddr] && !MAC_RE.test(evAddr)) return;
      if (ev.type === 'device_state' && ev.addr) ensureDeviceCfgMac(ev.addr, ev.node_id);
      const existing = lastDeviceState[evAddr] || { addr: evAddr };
      const { type: _t, ...fields } = ev;
      if (ev.type === 'device_state') {
        lastDeviceState[evAddr] = { ...existing, ...fields, state_event: ev, ble_state: ev.state.toLowerCase() };
        // READY (incl. post-reboot after a config write) — refresh radio lora + channels
        if (ev.state === 'READY') { refreshDeviceLora(evAddr); refreshDeviceChannels(evAddr); }
        // Translate OTA FSM states to legacy ota_start/progress/complete/error events for browser UI.
        // Use ev.node_id when available; fall back to ev.addr for pre-sync devices (e.g. stuck bootloader).
        const otaDev = ev.node_id || ev.addr;
        if (otaDev) {
          const s = ev.state;
          if (s === 'OTA_PENDING' || s === 'OTA_HANDSHAKE') {
            broadcast({ type: 'ota_start', device: otaDev, addr: ev.addr });
          } else if (s === 'OTA_FLASHING') {
            broadcast({ type: 'ota_progress', device: otaDev, addr: ev.addr, data: { pct: ev.pct ?? 0, status: 'flashing' } });
          } else if (s === 'OTA_COMPLETE') {
            broadcast({ type: 'ota_complete', device: otaDev, addr: ev.addr });
          } else if (s === 'OTA_SERIAL_WAIT') {
            broadcast({ type: 'ota_progress', device: otaDev, addr: ev.addr, data: { pct: 0, status: 'nvs_erase_waiting', message: ev.message || '', deadline: ev.deadline ?? null } });
          } else if (s === 'OTA_SERIAL_ERASING') {
            broadcast({ type: 'ota_progress', device: otaDev, addr: ev.addr, data: { pct: 0, status: 'nvs_erasing', message: 'NVS erasing…' } });
          } else if (['OTA_ERROR', 'OTA_BOOTLOADER_STUCK', 'OTA_NVS_MISMATCH'].includes(s)) {
            broadcast({ type: 'ota_error', device: otaDev, addr: ev.addr, data: { error: ev.message || s } });
          }
        }
      } else if (ev.type === 'device_data') {
        lastDeviceState[evAddr] = { ...existing, ...fields, data_event: ev };
        if (ev.node_id) {
          _liveNodeIds.set(evAddr.toUpperCase(), ev.node_id);
          persistNodeMac(ev.node_id, evAddr.toUpperCase());
        }
      }
      broadcastDeviceList();
      return;
    }

    // -- AppRouter typed event translations ----------------------------------
    // AppRouter emits generic events; translate to legacy names for browser compat.

    // signal_update — TWO PRODUCERS, ONE NAME, INCOMPATIBLE SHAPES.
    //
    //   mesh-gw   FLAT    {type, __ble_addr, addr, from_num, snr, rssi, hops}
    //                     one per packet carrying rx_rssi or rx_snr, so constantly
    //   ours      NESTED  {type, data:{signal_num, rssi, snr, ts}}
    //                     active-tracker.js, only while the YAGI is aimed at a node
    //
    // The browser reads ev.data, so every flat one failed its guard and was
    // dropped with no error and no log — 9 in a 60 s window, measured 2026-08-14.
    // On THIS socket the name belongs to the tracker's event, so the gw's is
    // consumed here rather than left to be discarded silently one layer later.
    //
    // Discriminate on the WRAPPER, not on a field list, so a new field on either
    // side never needs a change here. _hintNodeStatus has already run above, so
    // the node's status hint still fires for these packets and nothing is lost.
    //
    // DO NOT wrap the gw's payload in `data` to "fix" the shape: `from_num` is the
    // node the packet came FROM, `signal_num` is the node the YAGI is AIMED AT.
    // Merging them mis-attributes a reading. A consumer for the gw's per-packet
    // rssi/snr gets its own node-dash-owned type name, never this one.
    if (ev.type === 'signal_update' && ev.data === undefined) {
      return;
    }

    // Tilt — V1 typed event (legacy replay shape); fully consumed here
    if (ev.type === 'private_app' && ev.portnum === 256) {
      _handleTiltPayload(ev.payload_b64, ev.node_id ?? ev.addr ?? ev.device ?? '?',
                         ev.from_num, handleAlertEvent, broadcast);
      return;
    }

    // Tilt — V2 shape: raw packet event, decoded.portnum is the STRING
    // 'PRIVATE_APP'. Gating only on the V1 shape above is what silently
    // killed ingest 2026-06-30 → 07-03. Do NOT consume the event — the raw
    // packet still falls through to the browser packet log. Both radios
    // deliver the same broadcast: decode once per packet id.
    if (ev.type === 'packet' && ev.data?.packet?.decoded?.portnum === 'PRIVATE_APP') {
      const pkt = ev.data.packet;
      if (pkt.id == null || !_seenTiltPktIds.has(pkt.id)) {
        if (pkt.id != null) {
          _seenTiltPktIds.add(pkt.id);
          if (_seenTiltPktIds.size > 500) _seenTiltPktIds.delete(_seenTiltPktIds.values().next().value);
        }
        _handleTiltPayload(pkt.decoded.payload, ev.node_id ?? ev.addr ?? ev.device ?? '?',
                           pkt.from, handleAlertEvent, broadcast);
      }
    }

    if (ev.type === 'telemetry' && ev.from_num) {
      const dm = ev.data?.device_metrics;
      const em = ev.data?.environment_metrics;
      if (em && (em.temperature != null || em.relative_humidity != null)) {
        try {
          insertEnvHistory({ ts: Math.floor(Date.now() / 1000), num: ev.from_num, temperature: em.temperature ?? null, relative_humidity: em.relative_humidity ?? null, barometric_pressure: em.barometric_pressure ?? null });
        } catch (e) { console.error('[env] insert failed:', e.message); }
        broadcast({ type: 'telemetry_update', device: ev.addr || ev.device, from_num: ev.from_num, variant: 'environment_metrics', data: em });
      } else if (dm) {
        broadcast({ type: 'telemetry_update', device: ev.addr || ev.device, from_num: ev.from_num, variant: 'device_metrics', data: dm });
      }
      return;
    }

    if (ev.type === 'range_test') {
      const seq = parseInt((ev.data?.text || '').replace(/[^0-9]/g, '')) || null;
      broadcast({
        type: 'range_test_entry',
        device: ev.addr || ev.device,
        data: withRangeBudget({ ts: Math.floor(Date.now() / 1000), from_num: ev.from_num ?? null, rssi: ev.rx_rssi ?? null, snr: ev.rx_snr ?? null, hops: ev.hops ?? null, seq, via_mqtt: ev.via_mqtt ?? false, rx_device: ev.addr || ev.device },
                               mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null),
      });
      return;
    }

    // user, position, admin, node_update — handled server-side; no separate browser event needed.
    // Raw `packet` events (portnum=NODEINFO_APP, POSITION_APP etc.) still flow for browser packet log.
    if (ev.type === 'user' || ev.type === 'position' || ev.type === 'admin' || ev.type === 'node_update') {
      return;
    }

    if (ev.type === 'message_status' && ev.packet_id != null) {
      if (ev.status === 'queued' || ev.status === 'sent') _seenLivePktIds.add(ev.packet_id);
      try { stmts.updateMessageStatus.run({ packet_id: ev.packet_id, status: ev.status }); }
      catch (e) { console.error('[message_status] db update failed:', e.message); }
      // Append the event WITH its identity. `relayed` carries from_num — the node
      // that ACKed our outbound packet — and is non-terminal, so the UPDATE above
      // throws it away moments later. Kept separately in its own right; this is
      // the only outbound-direction relay evidence we receive.
      try {
        stmts.insertMessageStatusEvent.run({
          ts:        Math.floor(Date.now() / 1000),
          packet_id: ev.packet_id,
          status:    ev.status,
          from_num:  ev.from_num ?? null,   // null = event carried no identity, NOT zero
          device:    ev.__ble_addr ?? ev.addr ?? null,
        });
      } catch (e) { console.error('[message_status] event insert failed:', e.message); }
      broadcast(ev);
      return;
    }

    // Live dedup: suppress duplicate TEXT_MESSAGE_APP packet events so the browser
    // receives exactly one event per logical message regardless of how many gateway
    // radios heard it. The second reception is persisted to SQLite and visible in
    // the next message_history replay.
    if (ev.type === 'packet' && ev.data?.packet?.decoded?.portnum === 'TEXT_MESSAGE_APP') {
      const pktId = ev.data.packet.id;
      if (pktId) {
        if (_seenLivePktIds.has(pktId)) return;
        _seenLivePktIds.add(pktId);
      }
    }

    handleAlertEvent(ev);
    broadcast(ev);
  });

  // Rotator status frames also carry the switchable target list + active target
  // so the browser can render a data-driven v4/v5 selector without a REST GET.
  rotator.on('status', makeRotatorThrottle((data) => broadcast({
    type: 'rotator',
    data: { ...data, targets: rotator.targets, active_target: rotator.activeTarget },
  })));
  let lastPointTarget  = null;
  let lastSignalUpdate = null;
  rotator.on('point_target', (data) => {
    lastPointTarget = data;
    broadcast({ type: 'rotator', data });
  });
  rotator.on('signal_update', (data) => {
    lastSignalUpdate = data;
    broadcast({ type: 'signal_update', data });
  });
  // v5 device config schema — pushed on (re)fetch so the browser builds its
  // rotator config form from the device's own field list (shared buildForm).
  rotator.on('schema', (schema) => broadcast({ type: 'rotator', data: { schema } }));
  dashMode.on('change',      (data) => { broadcast({ type: 'rotator', data }); broadcastDeviceList(); });

  scanner.on('start',    (data) => broadcast({ type: 'scan_start',    data }));
  scanner.on('progress', (data) => broadcast({ type: 'scan_progress', data }));
  scanner.on('contact',  (data) => broadcast({ type: 'scan_contact',  data }));
  scanner.on('end',      (data) => broadcast({ type: 'scan_end',      data }));
  passiveTracer.on('tracing', (data) => broadcast({ type: 'passive_trace_start', ...data }));
  // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ────────────────────
  if (!FF.SSOT_TRACEROUTE) {
    passiveTracer.on('traced', (data) => broadcast({ type: 'route_discovered', ...withLinkBudget(withSnrDb(data), mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null) }));
  // ── [V2] SSOT — all traceroute results emit route_discovered, not PASV only
  } else {
    traceroute.on('result', (data) => broadcast({ type: 'route_discovered', ...withLinkBudget(withSnrDb(data), mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null) }));
  }
  // ──────────────────────────────────────────────────────────────────────────
  nodeList.on('change',  (nodes) => broadcast({ type: 'node_list', nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, homePos: nodeList.homePos }));

  // ── [V2] SSOT_ROUTE_RENDER — backend-derived radar display state ──────────
  let _getRadarContext = null; // set below when FF active; used by connection replay
  if (FF.SSOT_ROUTE_RENDER) {
    // Local state for radar_context derivation
    let _rcTracerouteNode     = null;   // node currently being traced (or last traced)
    let _rcActive             = false;  // true while a traceroute dispatch is in flight
    let _rcPassiveTracingNode = null;   // node currently being traced (PASV card spinner)

    // Quantile control points for the radar's adaptive scale.
    //
    // docs/modules/app-radar.md argued this was "sanctioned display arithmetic
    // (derived from the displayed list)". Defensible, but the QUANTILES are a
    // property of the data, and the backend already holds every distance — so
    // computing them twice invites the two sides to disagree, which is exactly
    // what happened with the region-frequency table (B80).
    //
    // The hysteresis lives here too: it exists to stop the rings jittering as
    // nodes come and go, and that only works if one place owns the previous
    // value. Split across the boundary it would fight itself.
    let _radarScalePrev = null;
    function radarScaleCtrl() {
      const maxKm = Number(getConfig('radar.max_range_km', 50)) || 50;
      // `_km` — the SAME field and the SAME filtered list the browser plotted.
      // A node here carries `position` and a precomputed `_km`, NOT a top-level
      // `lat`; reading `n.lat` returned undefined for every node and the scale
      // came back null. Using _km also keeps the quantiles over the DISPLAYED
      // set, so the rings still describe what is on screen rather than the whole
      // store.
      const kms = (nodeList.nodes || [])
        .map(n => n?._km)
        .filter(km => km != null && km > 0 && km <= maxKm)
        .sort((a, b) => a - b);
      // Fewer than four distinct distances cannot describe a distribution; the
      // browser falls back to its fixed pow-0.4 curve, which is the spec'd
      // degraded mode rather than a failure.
      if (new Set(kms.map(k => k.toFixed(1))).size < 4) return null;

      const q = f => kms[Math.min(kms.length - 1, Math.floor(f * kms.length))];
      // Rounded for readable ring labels, but never snapped so hard that
      // quartiles inside the cluster band collapse into one ring.
      const snap = km => km >= 10 ? Math.round(km) : Math.round(km * 2) / 2;
      let pts = [...new Set([q(0.25), q(0.5), q(0.75)].map(snap).filter(k => k < maxKm))];
      if (!pts.length) return null;

      const prev = _radarScalePrev;
      if (prev && prev.max_km === maxKm && prev.kms.length === pts.length &&
          prev.kms.every((k, i) => Math.abs(k - pts[i]) / k <= 0.15)) return prev;

      const fr = pts.map((_, i) => 0.28 + (0.76 - 0.28) * (i / Math.max(1, pts.length - 1)));
      _radarScalePrev = { max_km: maxKm, kms: pts, fracs: pts.length === 1 ? [0.52] : fr };
      return _radarScalePrev;
    }

    function buildRadarContext() {
      const mode      = dashMode.value;      // 0=PASV, 1=ACTV, 2=SCAN
      const targetNum = lastPointTarget?.point_target ?? null;
      const armAz     = (mode !== 0) ? (rotator.status?.target ?? null) : null;

      // tracerouteNode: which node gets crosshairs; traceroute_active: animate its route
      let tracerouteNode = null;
      let activeCard     = null;

      if (mode === 1) {
        // ACTV: crosshairs always on target; animate while traceroute in flight
        tracerouteNode = targetNum;
        activeCard = targetNum ? {
          mode: 'actv', node_num: targetNum, label: 'TARGET',
          border: 'rgba(255,30,30,0.40)', accent: 'rgba(255,30,30,0.75)',
          nameclr: 'rgba(255,30,30,0.95)', divider: 'rgba(255,30,30,0.18)',
        } : null;
      } else if (mode === 0) {
        // PASV: crosshairs on last traced node; card while actively tracing
        tracerouteNode = _rcTracerouteNode;
        activeCard = _rcPassiveTracingNode ? {
          mode: 'pasv', node_num: _rcPassiveTracingNode, label: 'TRACING',
          border: 'rgba(0,255,80,0.35)', accent: 'rgba(0,255,80,0.75)',
          nameclr: 'rgba(0,255,80,0.95)', divider: 'rgba(0,255,80,0.15)',
        } : null;
      } else if (mode === 2) {
        // SCAN: crosshairs on last traced node, no card
        tracerouteNode = _rcTracerouteNode;
        activeCard     = null;
      }

      return {
        type:              'radar_context',
        mode,
        traceroute_node:   tracerouteNode,
        traceroute_active: _rcActive,
        target_arm_az:     armAz,
        active_card:       activeCard,
        // THE SCALE'S CONTROL POINTS. Quantiles of the plotted node distances —
        // a property of the DATA, so decided here. The browser interpolates
        // between them, which is the display half and stays there.
        scale:             radarScaleCtrl(),
      };
    }

    function broadcastRadarContext() {
      broadcast(buildRadarContext());
    }
    _getRadarContext = buildRadarContext;

    // Wire up triggers
    // THE AIMING ANIMATION, from EVERY path. Peter: "the beauty and refinement
    // of the radar is it actually animates the whole traceroute — the antenna
    // aiming, the target node, and an animated route." That was fed only by
    // rotator's point_target, emitted only by active-tracker in ACTV, so any
    // other path animated nothing. run() emits these for all of them.
    traceroute.on('aiming', (d) => broadcast({ type: 'trace_aiming', ...d }));
    traceroute.on('aimed',  (d) => broadcast({ type: 'trace_aimed',  ...d }));

    traceroute.on('start', ({ to }) => {
      _rcTracerouteNode = to;
      _rcActive         = true;
      broadcastRadarContext();
    });
    traceroute.on('result', (data) => {
      _rcTracerouteNode = data.from;
      _rcActive         = false;
      if (dashMode.value === 0) _rcPassiveTracingNode = null;
      broadcastRadarContext();
    });
    traceroute.on('cancel', ({ row } = {}) => {
      _rcActive = false;
      broadcastRadarContext();
      // Failed attempts reach the perf page live — same channel as results
      if (row) broadcast({ type: 'traceroute_failed', row: withLinkBudget(withSnrDb(row), mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null) });
    });
    passiveTracer.on('tracing', (data) => {
      _rcPassiveTracingNode = data.from;
      broadcastRadarContext();
    });
    rotator.on('point_target', () => broadcastRadarContext());
    dashMode.on('change', () => {
      if (dashMode.value !== 0) _rcPassiveTracingNode = null;
      broadcastRadarContext();
    });
    scanner.on('contact', () => broadcastRadarContext());
  }
  // ─────────────────────────────────────────────────────────────────────────

  wss.on('connection', (ws) => {
    // A quiet node emits no ingest hint, but its server-formatted relative age
    // still changes with wall time. Retain only the last successful status
    // reply's clock state; never rebuild histories merely to advance "ago".
    let nodeStatusAge = null;
    let nodeStatusAgeTimer = null;

    function stopNodeStatusAge() {
      // scheduleTime returns an idempotent stop(), not a timer id.
      if (nodeStatusAgeTimer) nodeStatusAgeTimer();
      nodeStatusAgeTimer = null;
      nodeStatusAge = null;
    }

    function rememberNodeStatusAge(payload) {
      const lastHeard = payload?.header?.last_heard;
      if (!lastHeard || lastHeard.raw == null) {
        stopNodeStatusAge();
        return;
      }
      nodeStatusAge = {
        num: Number(payload.num),
        raw: lastHeard.raw,
        ago: lastHeard.ago,
      };
      if (nodeStatusAgeTimer) return;
      // EVENT DRIVEN, NOT POLLED. This was a 1000 ms setInterval that recomputed,
      // compared and discarded — 3,600 wakes an hour to produce one change on an
      // hour-old fact. scheduleTime wakes at the computed transition and only
      // there. See docs/modules/served-time.md.
      nodeStatusAgeTimer = scheduleTime(nodeStatusAge.raw, (ago) => {
        if (!nodeStatusAge || ws.readyState !== 1) return;
        nodeStatusAge.ago = ago;
        ws.send(JSON.stringify({
          type: 'node_status_age',
          num: nodeStatusAge.num,
          raw: nodeStatusAge.raw,
          ago,
        }));
      });
    }

    ws.once('close', stopNodeStatusAge);

    // The coulomb age-push lived here until 2026-08-17. It served the alarm's
    // Control panel, which is now mt-alarm-1's own service. The pattern it used
    // survives directly above in node_status_age, and that is the one to copy:
    // a server-formatted "12 minutes ago" changes with wall time even when the
    // subject is silent, so the SERVER pushes the changed string on a scheduled
    // transition. BROWSER_CONTRACT: "browser timers that recompute server facts
    // … are forbidden freshness mechanisms."

    // Send current bridge connection state immediately
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: bridge.connected ? 'bridge_connected' : 'bridge_disconnected' }));
    }
    // Plugin replays, spliced at EXACTLY this position — between bridge state
    // and settings. Order is part of the contract: a page's first paint depends
    // on it, and moving these after `settings` would change what the Control
    // page shows on connect.
    //
    // Deliberately NOT routed through sendEnriched: broadcast() applies
    // enrichEvent, this path never has, and quietly enriching a replay would
    // change the payload (docs/WS_PLUGIN_HOOKS_SPEC.md §4).
    for (const replay of _connectReplays) {
      for (const msg of replay()) {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      }
    }
    // Settings replay — page state never comes from a GET (settings-via-ws)
    if (ws.readyState === 1) ws.send(JSON.stringify(settingsEvent()));

    // Snapshot board — REPLAYED ON CONNECT, at the server's default window.
    //
    // Without this the board is empty on a fresh load: the page asks for it in
    // x-init, which runs before the socket is open, so the request is dropped
    // and nothing retries. Measured — the page contract test read "—" for every
    // window while the socket-driven update worked perfectly on a page that had
    // already been open.
    //
    // Replay-on-connect is the rule the rest of this file already follows
    // (BROWSER_CONTRACT: page data is replayed on connect and pushed on
    // change), and it is what makes the browser's request a REFINEMENT — asking
    // for a different window — rather than the only way to get any data at all.
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'snapshot', ...board() })); }
      catch (e) { console.error(`[snapshot] connect replay failed: ${e.message}`); }
    }

    // Radar overlays — reach ring, clusters, terrain mask. Replayed for the
    // same reason as the board: the page asks in x-init, before the socket is
    // open, so a request-only design renders an empty radar on every fresh load.
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'radar', ...radarOverlays() })); }
      catch (e) { console.error(`[radar] connect replay failed: ${e.message}`); }
    }
    // Client→server RPC. geocode: on-demand address lookup — the Nominatim
    // queue in lookupGeocode serializes requests regardless of caller.
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.type === 'geocode' && msg.num) {
        const address = await lookupGeocode(msg.num).catch(() => null);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'geocode_result', num: msg.num, address }));
      }
      // node_status: works for ANY node in the mesh, not a designated subset.
      // Returns display-ready sections; the browser renders and decides nothing.
      if (msg?.type === 'node_status' && msg.num) {
        let payload;
        try {
          payload = buildNodeStatus(Number(msg.num), msg.window_h);
        } catch (e) {
          console.error(`[node_status] build failed for ${msg.num}: ${e.message}`);
          payload = { num: Number(msg.num), found: false, header: null, sections: [] };
        }
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'node_status', ...payload }));
          rememberNodeStatusAge(payload);
        }
      }

      // The `coulomb` WS RPC lived here until 2026-08-17 and left with the alarm.
      // Its ONLY consumers were public/plugins/alarm/{app-control.js,
      // tab-control.html,plugin.js} — nothing in core ever read it — and the
      // series it served could not be built anyway: alarm-host's getObs always
      // threw ("no history store — the series needs `record`, which is unbuilt").
      //
      // The rule it demonstrated stands for whatever replaces it: on-demand page
      // data goes over the SOCKET, never a GET. A GET for exactly this shape was
      // added once and was a real bug (Peter, 2026-07-25) — the browser fetched
      // on click, which is neither real-time nor permitted. See geocode and
      // node_status for the surviving examples.

      // snapshot: the whole board for one window.
      //
      // Replaces FIVE browser GETs — /snapshot/frontier, /distribution,
      // /new-ground, /productivity, /health — which fired on page load and
      // again on every window change. Peter, 2026-08-13: "no HTTP GETS for live
      // data, ws feeds for everything except static data / forms."
      //
      // One reply rather than five: they are one screen, and five replies can
      // interleave with a window change and paint bands that disagree about
      // which window they describe. `days` is echoed so the browser can drop a
      // reply for a window it has moved off — addressing, not a decision.
      if (msg?.type === 'snapshot') {
        let payload;
        try {
          payload = board(msg.days);
        } catch (e) {
          // The board is five queries over the whole store. A failure here is a
          // real fault and the page must say so rather than render empty bands
          // that read as "nothing has happened".
          console.error(`[snapshot] board failed: ${e.message}`);
          payload = { days: msg.days ?? null, error: `Could not build the board: ${e.message}`,
                      frontier: null, distribution: null, new_ground: null,
                      productivity: null, health: null };
        }
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', ...payload }));
      }

      // radar: the three overlays the radar draws over the node plot.
      //
      // Replaces GET /reach, GET /clusters and GET /terrain/visibility. One
      // reply rather than three: they are drawn onto the same canvas in the
      // same frame, and three replies can land across a redraw leaving a ring,
      // a hull set and a terrain mask that describe different moments.
      if (msg?.type === 'radar') {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'radar', ...radarOverlays() }));
      }
    });
    // Replay last-known BLE state for each device — no HTTP
    for (const state of Object.values(lastDeviceState)) {
      if (ws.readyState === 1) ws.send(JSON.stringify(state));
    }
    // Replay device list — fetch fresh from gateway if not yet populated
    if (lastDeviceList) {
      sendEnriched(ws, lastDeviceList);
    } else {
      broadcastDeviceList();
    }

    // Always send current dash mode + switchable targets — rotator may be
    // offline but mode is persisted and the selector must still render so the
    // user can switch TO an offline/other device.
    ws.send(JSON.stringify({ type: 'rotator', data: {
      _mode: dashMode.value,
      targets: rotator.targets,
      active_target: rotator.activeTarget,
      schema: rotator.schema,
    } }));
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: dashMode.value } }));
    }
    if (lastPointTarget) {
      ws.send(JSON.stringify({ type: 'rotator', data: lastPointTarget }));
    }
    if (lastSignalUpdate) {
      ws.send(JSON.stringify({ type: 'signal_update', data: lastSignalUpdate }));
    }
    if (_getRadarContext) {
      ws.send(JSON.stringify(_getRadarContext()));
    }
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz,
        contacts: scanner.contacts,
      }}));
    }
    sendEnriched(ws, { type: 'node_list', nodes: nodeList.nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, homePos: nodeList.homePos });

    // All named nodes from cache — unfiltered, for message addressing only
    const knownNodes = Array.from(nodeList._cache.values())
      .filter(n => n.user?.long_name)
      .map(n => ({ num: n.num, display_name: resolveNodeLabel(n.num), user: { short_name: n.user.short_name, long_name: n.user.long_name } }));
    ws.send(JSON.stringify({ type: 'known_nodes', nodes: knownNodes }));

    // Tilt calibration
    const cal = getTiltCal();
    ws.send(JSON.stringify({ type: 'tilt_cal', zero: cal.zero, north_angle: cal.north_angle }));

    // History snapshots — pushed once on connect; real-time events append from here
    try {
      const since24h = Math.floor(Date.now() / 1000) - 86400;

      const feedRows = buildMessageFeedRows();
      ws.send(JSON.stringify(buildMessageHistoryEvent(feedRows)));

      const tiltRows = queryAllTiltHistory(since24h);
      ws.send(JSON.stringify({ type: 'tilt_history', rows: tiltRows }));

      const since7d = Math.floor(Date.now() / 1000) - 7 * 86400;
      const envRows = queryAllEnvHistory(since7d);
      ws.send(JSON.stringify({ type: 'env_history', rows: envRows }));

      const rangeLog = queryRangeTestLog(500).map(r => withRangeBudget({
        ...r, from_name: resolveNodeLabel(r.from_num), rx_name: resolveDeviceLabel(r.rx_device),
      }, mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null));
      ws.send(JSON.stringify({ type: 'range_test_log', log: rangeLog }));

      const timer = getRangeTimer();
      ws.send(JSON.stringify({ type: 'range_test_timer', ...timer }));

      // Sole transport for perf-page history (C1: page data is WS-only; the
      // REST GET is browser-blocked). failure_epoch rides along so the
      // success-rate stat never needs a config GET.
      const traceRows = stmts.queryTracerouteHistory.all({ to_num: null, limit: 500 }).map(r => ({
        ...r,
        route:           JSON.parse(r.route           || '[]'),
        route_back:      JSON.parse(r.route_back      || '[]'),
        // CONVERTED HERE, at the emit boundary. The store keeps raw wire
        // units; the browser is handed dB and decides nothing.
        snr_towards:     snrDbList(JSON.parse(r.snr_towards || '[]')),
        snr_back:        snrDbList(JSON.parse(r.snr_back    || '[]')),
        relay_positions: JSON.parse(r.relay_positions || '{}'),
      })).map(r => withLinkBudget(r, mac => mac ? (lastDeviceLora[mac.toUpperCase()] ?? null) : null));
      ws.send(JSON.stringify({ type: 'traceroute_history', rows: traceRows,
                               failure_epoch: getConfig('perf.failure_epoch', null) }));
      // The band tables themselves. Per-row `health` covers rows; the perf
      // page's HEADLINE figures are client-side medians (perfSummary ->
      // _perfMedian over the user's selected radio/kind) and so have no row to
      // carry a verdict. Serving the table lets the browser look up without
      // owning a single threshold — docs/modules/verdict-bands.md, same shape
      // as SPLIT_READINESS §4's recommendation for the radar scale.
      //
      // Static config, so once on connect rather than on every broadcast.
      ws.send(JSON.stringify({ type: 'verdict_bands', ...verdictBands() }));
    } catch (e) {
      console.error('[ws-relay] history push failed:', e.message);
    }
  });

  // -- Per-device /!{nodeId}/events — snapshot first, pre-filtered -----------
  const wssDevice = new WebSocketServer({ noServer: true });

  function attachDeviceClient(ws, nodeId) {
    // nodeId from URL is !hexid; lastDeviceState is keyed by BLE MAC (ev.addr).
    // Resolve the MAC by scanning for a matching node_id in existing state entries.
    const addr = Object.keys(lastDeviceState).find(k =>
      lastDeviceState[k]?.node_id === nodeId || lastDeviceState[k]?.state_event?.node_id === nodeId
    ) ?? nodeId;

    // Replay last-known state for this device — no HTTP
    const state = lastDeviceState[addr];
    if (state && ws.readyState === 1) {
      ws.send(JSON.stringify(state));
    }

    // Always send current dash mode + switchable targets — rotator may be
    // offline but mode is persisted and the selector must still render so the
    // user can switch TO an offline/other device.
    ws.send(JSON.stringify({ type: 'rotator', data: {
      _mode: dashMode.value,
      targets: rotator.targets,
      active_target: rotator.activeTarget,
      schema: rotator.schema,
    } }));
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: dashMode.value } }));
    }
    if (lastPointTarget) {
      ws.send(JSON.stringify({ type: 'rotator', data: lastPointTarget }));
    }
    if (lastSignalUpdate) {
      ws.send(JSON.stringify({ type: 'signal_update', data: lastSignalUpdate }));
    }
    if (_getRadarContext) {
      ws.send(JSON.stringify(_getRadarContext()));
    }
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz, contacts: scanner.contacts,
      }}));
    }
    sendEnriched(ws, { type: 'node_list', nodes: nodeList.nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, homePos: nodeList.homePos });

    function onEvent(ev) {
      if (ws.readyState !== 1) return;
      const evAddr = ev.addr || ev.__ble_addr || ev.device;
      if (!evAddr || evAddr === addr || ev.node_id === nodeId || ev.type?.startsWith('ota_')) sendEnriched(ws, ev);
    }

    const onRotatorStatus = makeRotatorThrottle((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
    });
    const onRotatorTarget = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
    };
    const onSignalUpdate = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal_update', data }));
    };

    function onDashMode(data) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
    }

    function onScan(type) {
      return (data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
    }
    const onScanStart    = onScan('scan_start');
    const onScanProgress = onScan('scan_progress');
    const onScanContact  = onScan('scan_contact');
    const onScanEnd      = onScan('scan_end');

    function onNodeList(nodes) {
      sendEnriched(ws, { type: 'node_list', nodes, total: nodeList._cache.size, homePos: nodeList.homePos });
    }

    bridge.on('event', onEvent);
    rotator.on('status',        onRotatorStatus);
    rotator.on('point_target',  onRotatorTarget);
    rotator.on('signal_update', onSignalUpdate);
    dashMode.on('change', onDashMode);
    scanner.on('start',    onScanStart);
    scanner.on('progress', onScanProgress);
    scanner.on('contact',  onScanContact);
    scanner.on('end',      onScanEnd);
    nodeList.on('change',  onNodeList);

    ws.on('close', () => {
      bridge.off('event', onEvent);
      rotator.off('status',        onRotatorStatus);
      rotator.off('point_target',  onRotatorTarget);
      rotator.off('signal_update', onSignalUpdate);
      dashMode.off('change', onDashMode);
      scanner.off('start',    onScanStart);
      scanner.off('progress', onScanProgress);
      scanner.off('contact',  onScanContact);
      scanner.off('end',      onScanEnd);
      nodeList.off('change',  onNodeList);
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const deviceMatch = req.url?.match(/^\/(![0-9a-f]+)\/events(?:\?.*)?$/i);
    if (deviceMatch) {
      const nodeId = deviceMatch[1];
      wssDevice.handleUpgrade(req, socket, head, (ws) => {
        attachDeviceClient(ws, nodeId);
      });
      return;
    }

    const url = req.url?.split('?')[0];
    if (url === '/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  return wss;
}
