import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { events as aimEvents } from './aim-client.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { insertTilt, insertEnvHistory, getTiltCal, getConfig, queryRangeTestLog, queryAllTiltHistory, queryAllEnvHistory, stmts, persistNodeMac, loadNodeMacMap } from './db.js';
import { buildNodeStatus } from './node-status.js';
import { listFavourites, lastTraceByNode } from './db.js';
import { queryMessages } from './filters.js';
import { handleAlertEvent } from './alerts.js';
import { dashMode, isListenerForMode, isTransmitterForMode } from './dash-mode.js';
import { resolveNodeLabel, resolveDeviceLabel } from './node-label.js';
import { scheduleTime } from './served-time.js';
// Re-imported 2026-08-18 for the status feed. It was dropped when the last
// traceroute broadcast went; this subscribes to ONE event ('status') and
// relays it verbatim, rather than the five it used to assemble.
import { traceroute } from './traceroute.js';
import { nodeKind, provenDoors, rolesByNum } from './node-kind.js';
import { ownDeviceNums } from './node-filter.js';
// src/channels.js DELETED 2026-08-19 — this repo no longer resolves channels.
// See docs/modules/channels.md and _resolvedChannels below.
// marginHealth and gapTone dropped 2026-08-17 — both scored a traceroute row.
import { signalVerdict, hopsTone, blePctTone, verdictBands,
         excessLossTone, heardTone } from './signal-verdict.js';
import { signalQuality as sigQualityPct } from './utils.js';
// marginDb / snrGapDb / theoreticalSnrDb dropped with withLinkBudget, the only
// caller. link-budget.js itself is untouched and still serves the per-RADIO
// budget via `budget`.
import { budget as linkBudget, expectedRssiDbm, excessLossDb } from './link-budget.js';
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

import { ensureDeviceCfgMac, getDeviceCfg, registerInstallLookup } from './device-config.js';
import { DEFAULTS as CONFIG_DEFAULTS } from './config-api.js';
import { getAutoPurgeCfg } from './auto-purge-api.js';
import { lookupGeocode } from './geocode.js';
import { FF } from './feature-flags.js';
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

// withSnrDb() and withLinkBudget() are REMOVED — 2026-08-17, task
// `traceroute-remove-backend-remainder`. Both took a traceroute_history row:
// the first converted snr_towards/snr_back from the wire's quarter-dB to dB at
// the emit boundary, the second attached the per-row link budget (margin, gap,
// theoretical SNR, metric distance, valid_tx) attributed to that row's OWN
// tx_device. Every caller went with the feeds that carried the rows.
//
// TWO RULES IN THEM ARE WORTH RE-READING BEFORE ANY REWRITE, both bought with
// real bugs:
//   - convert to dB ONCE, at the emit boundary, never at storage — the store
//     holds what the wire said. Three consumers each doing their own /4 is how
//     an unmeasured hop got drawn as a confident -32.0 dB.
//   - take positions from the STORE, not nodeList._cache — the cache is a
//     display projection and was returning entries with no lat, so every
//     distance came back null and valid_tx was false for all 500 rows.
//
// src/link-budget.js is untouched and still serves the per-RADIO budget the
// Performance page shows. Only the per-ROW attachment is gone.

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

/** device key (MAC or node id, upper-cased) -> the gateway's `resolved` object,
 *  verbatim: {public: N, private: M} — or null when it has not answered.
 *
 *  CACHED, NEVER COMPUTED. The only consumer is the inbound privacy gate, which
 *  needs an integer because received events carry one and no role. Everything we
 *  SEND uses the words 'public'/'private' and never looks in here.
 *  docs/modules/channels.md. */
const _resolvedChannels = new Map();

/** Did this packet arrive on the radio's PRIVATE channel?
 *
 *  FAILS CLOSED. No cached answer, or a null private, returns false and the
 *  caller does nothing — silence is the safe failure, acting on a command shouted
 *  at the public mesh is not. `index` is compared with ===, so an undefined index
 *  can never equal a resolved 0. */
export function isPrivateChannel(device, index) {
  if (typeof device !== 'string' || !Number.isInteger(index)) return false;
  const resolved = _resolvedChannels.get(device.toUpperCase());
  const priv = resolved?.private;
  return Number.isInteger(priv) && priv === index;
}

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
  // mesh-gw SSOT wiring (2026-09-03): device-config.js cannot import this
  // module (this module already imports getDeviceCfg from device-config.js),
  // so the live `install` lookup is handed over by callback — same pattern as
  // registerMacToNodeIdResolver.
  registerInstallLookup(mac => lastDeviceState[mac]?.install ?? null);
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
      // ONE grouped read for the whole list. See docs/modules/node-recency-ssot.md.
      const _lastTrace = lastTraceByNode();
      return { ...ev, favourites: listFavourites(), nodes: (ev.nodes || []).map(n => {
        // `via` — the first-hop relay bundle (IDENTITY.md §3) — is now always
        // null. It was read from last_traceroute.route[0], and nothing writes
        // last_traceroute (2026-08-17, task
        // `traceroute-remove-backend-remainder`). It is still SENT, as null,
        // because the radar list renders a column for it and a missing key and
        // an unknown first hop are different statements.
        const via = null;
        // Hops-away DISPLAY decision (backend-owned; UI is presentation only).
        // SIGNAL VERDICT, decided here. The browser turned a percentage into
        // "Excellent / Good / Fair / Poor" using >=76/51/26 while the colour ramp
        // beside it used >=75/50/25 — a node at 75% read "Good" in the excellent
        // colour. One set of bands now, in src/signal-verdict.js.
        const hasSig = n.rssi != null || n.snr != null;
        const signal = signalVerdict(hasSig ? sigQualityPct(n.rssi, n.snr) : null,
                                     { hasReading: hasSig });
        // hops_display is now the REPORTED count and nothing else — 2026-08-17,
        // task `traceroute-remove-backend-remainder`.
        //
        // It used to prefer hops_verified (the traceroute relay count, 0 =
        // direct) over the live packet hops, and hops_fresh said whether that
        // verification was still inside the passive tracer's staleness window.
        // Both are gone with the tracer: a "verified" claim that can never be
        // renewed decays into a lie, and the browser was drawing a green dot to
        // assert it.
        const hops_display = n.hops_away ?? n.hops ?? null;
        // Hop-count TONE decided here — app-components.js held the 0/1/2
        // thresholds. The badge's TEXT (Direct vs "n hops") is display
        // composition and stays there.
        return { ...n, display_name: resolveNodeLabel(n.num), via, hops_display, signal,
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
                 heard_tone: heardTone(n.last_heard == null ? null : (Date.now() / 1000) - n.last_heard),
                 // WHEN WE LAST TRACED THIS NODE, and whether it answered.
                 // Recorded in traceroute_history since the beginning and never
                 // published — Peter, 2026-08-18: "we have no record of last
                 // trace. that last one I challenge, because every traceroute
                 // saves to and / or updates tables." He was right; it was there.
                 //
                 // ATTEMPT and HIT are separate because they answer different
                 // questions: HOME has 730 attempts in 7 days and has answered
                 // NONE, and one merged "last traced" would hide that entirely.
                 // Raw unix seconds — the browser derives no age from them.
                 last_trace_attempt: _lastTrace.get(n.num)?.attempt ?? null,
                 last_trace_hit:     _lastTrace.get(n.num)?.hit     ?? null };
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
        // NO IDENTITY IS COMPUTED HERE ANY MORE. This used to hash
        // name + NUL + psk per slot so channels.js could resolve pub/pri itself.
        // Peter, 2026-08-19: "you need to know nothing about channels, channel
        // indexes, PSKs, PKI, all you need to know is public and private."
        // The gateway resolves; we do not. docs/modules/channels.md.
        lastDeviceChannels[addr.toUpperCase()] = r.channels
          .map((c, i) => ({ index: c.index ?? i, name: c.settings?.name ?? '', role: c.role ?? null }))
          .filter(c => c.role === 'PRIMARY' || c.role === 'SECONDARY');

        // THE GATEWAY'S OWN ANSWER, CACHED VERBATIM — not a resolution.
        //
        // Needed for ONE thing: deciding whether a RECEIVED packet arrived on the
        // private channel, which is what stops an "@ping" shouted on the public
        // mesh driving the rotator. Inbound events carry an integer and no role
        // (docs/gw/API_SSE.md:135), so the comparison cannot be made in words yet.
        // Raised as `inbound-packets-carry-no-channel-role`; when they label the
        // packet this goes too.
        //
        // mesh-gw asked for exactly this: "if you keep any index-derived logic at
        // all, source the index from `resolved` rather than from your own pass
        // over the channel list."
        _resolvedChannels.set(addr.toUpperCase(), r.resolved ?? null);
        const nodeId = getLiveNodeIdByMac(addr);
        if (nodeId) _resolvedChannels.set(nodeId.toUpperCase(), r.resolved ?? null);
        // LOGGED BECAUSE THE FAILURE IS SILENT. isPrivateChannel fails closed, so
        // an absent or null `resolved` does not error — it just makes every
        // inbound command look public and quietly stops every automation
        // answering. Without this line there is no way to tell that state from
        // "nobody sent a command". Warn, not info, when it is missing.
        if (r.resolved && Number.isInteger(r.resolved.private)) {
          console.log(`[channels] ${nodeId ?? addr} resolved private=${r.resolved.private} public=${r.resolved.public}`);
        } else {
          console.warn(`[channels] ${nodeId ?? addr} gateway returned no private channel — automations on this radio will not answer`);
        }

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
      // Slots as the radio reports them, for DISPLAY only — name and index, so
      // the Channels tab can show what is configured. No `designated` and no
      // identity hash: the browser decides nothing about which channel is which,
      // and after 2026-08-19 neither does this process.
      // docs/BROWSER_CONTRACT.md, docs/modules/channels.md.
      // `null` when the radio has not reported yet is PRESERVED, not flattened to
      // []: the send form distinguishes "no channels known" from "none configured".
      channels: (d.addr && lastDeviceChannels[d.addr.toUpperCase()])
        ? lastDeviceChannels[d.addr.toUpperCase()]
        : null,
      // WHICH CHANNEL THE SEND FORM STARTS ON — now a WORD, not an index.
      //
      // It was `indexFor(d.addr, 'pri')`, a per-radio integer, and before that the
      // browser picked `'0'` for itself. An index means different things on
      // different radios: private is 2 on the OMNI and 1 on the YAGI, and index 0
      // on the YAGI is a primary named `Public` that nothing listens to — it
      // EXISTS, so an "is this index valid" check passes and the send goes
      // nowhere.
      //
      // PRIVATE, not public, and unconditional. The word resolves on whichever
      // radio the send is addressed to, so there is nothing left to be null and
      // nothing to fall back from. Public stays available by deliberately
      // selecting it, which is the point.
      default_channel: 'private',
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
    return {
      type: 'settings',
      config,
      // The PORT the browser reaches mesh-gw's aim plugin on directly, for
      // rotator commands (2026-09-03, task rotator-command-via-meshgw-aim) —
      // "post_to is why a hardcoded write URL is refused and a server-supplied
      // one is not" (mesh-gw's own dashboard.md). Same host as this page
      // (window.location.hostname); only the port differs and only the
      // server knows it (BRIDGE_URL). Never hardcode a LAN address in client JS.
      meshgw_port: new URL(process.env.BRIDGE_URL || 'http://localhost:8001').port || '8001',
    };
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

  // Rotator status/target-list/schema broadcasting — REMOVED 2026-09-03, task
  // rotator-command-via-meshgw-aim. node-dash no longer holds a live rotator
  // connection to report status from, and mesh-gw's aim plugin has no push
  // feed to relay ("stop diagnosing the rotator... busy or done is the whole
  // contract" — docs/gw/modules/aim_plugin.md). What remains — point_target,
  // signal_update — describes active-tracker's OWN tracking state, not the
  // rotator's wire status, and now comes from aim-client.js's events bus.
  let lastPointTarget  = null;
  let lastSignalUpdate = null;
  aimEvents.on('point_target', (data) => {
    lastPointTarget = data;
    broadcast({ type: 'rotator', data });
  });
  aimEvents.on('signal_update', (data) => {
    lastSignalUpdate = data;
    broadcast({ type: 'signal_update', data });
  });
  dashMode.on('change',      (data) => { broadcast({ type: 'rotator', data }); broadcastDeviceList(); });

  scanner.on('start',    (data) => broadcast({ type: 'scan_start',    data }));
  scanner.on('progress', (data) => broadcast({ type: 'scan_progress', data }));
  scanner.on('contact',  (data) => broadcast({ type: 'scan_contact',  data }));
  scanner.on('end',      (data) => broadcast({ type: 'scan_end',      data }));
  // ── traceroute_status ──────────────────────────────────────────────────────
  //
  // Peter, 2026-08-18: "traceroute needs a ws status feed that can be subscribed
  // to, i.e by the radar", and on the payload: "we know everything about what
  // its doing, what radio it is using etc etc. whether or not all of it will be
  // consumed is irrelevant."
  //
  // ONE EVENT TYPE CARRYING A PHASE, not the five overlapping types this
  // replaces (trace_aiming, trace_aimed, passive_trace_start, route_discovered,
  // traceroute_failed — all removed 2026-08-17 when their emitters went). Five
  // types serving four callers is why the browser's handling of them sprawled;
  // one typed event lets a consumer switch on one thing.
  //
  // THE PAYLOAD IS ASSEMBLED IN traceroute.js, NOT HERE. This is a relay: it
  // must not enrich, because the module that ran the traceroute is the only one
  // that knows the radio, the aim and the budget at the same instant. Spec:
  // docs/modules/traceroute-status-feed.md.
  traceroute.on('status', (s) => broadcast({ type: 'traceroute_status', ...s }));
  nodeList.on('change',  (nodes) => broadcast({ type: 'node_list', nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, homePos: nodeList.homePos }));

  // ── [V2] SSOT_ROUTE_RENDER — backend-derived radar display state ──────────
  let _getRadarContext = null; // set below when FF active; used by connection replay
  if (FF.SSOT_ROUTE_RENDER) {
    // Local state for radar_context derivation.
    //
    // _rcTracerouteNode / _rcActive / _rcPassiveTracingNode are GONE — 2026-08-17,
    // task `traceroute-remove-backend-remainder`. All three were written only by
    // traceroute.js and passiveTracer events, and nothing dispatches now.

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
      // No live rotator status to sample any more — lastPointTarget already
      // carries the az from the most recent command (2026-09-03).
      const armAz     = (mode !== 0) ? (lastPointTarget?.az ?? null) : null;

      // focus_node: WHICH NODE GETS CROSSHAIRS. Renamed from traceroute_node —
      // 2026-08-17, task `traceroute-remove-backend-remainder`.
      //
      // The old name was wrong, and removing the traceroute surface is what
      // exposed it: in ACTV this has always carried the TRACKER's target, which
      // is where the rotator is pointing. It has nothing to do with a
      // traceroute, and deleting the field along with everything else
      // traceroute-shaped would have taken ACTV's crosshair and its signal
      // overlay with it.
      //
      // In PASV and SCAN it used to carry the last TRACED node, which no longer
      // exists, so those modes now have no focus node. `traceroute_active`,
      // which only ever animated a dispatch in flight, is gone outright.
      let focusNode  = null;
      let activeCard = null;

      if (mode === 1) {
        focusNode = targetNum;
        activeCard = targetNum ? {
          mode: 'actv', node_num: targetNum, label: 'TARGET',
          border: 'rgba(255,30,30,0.40)', accent: 'rgba(255,30,30,0.75)',
          nameclr: 'rgba(255,30,30,0.95)', divider: 'rgba(255,30,30,0.18)',
        } : null;
      }
      // PASV (mode 0) and SCAN (mode 2): no focus node and no card. PASV's
      // "TRACING" card named the node the passive tracer was working on; with
      // no tracer the card could only misrepresent what the station is doing.

      return {
        type:              'radar_context',
        mode,
        focus_node:        focusNode,
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

    // Wire up triggers.
    //
    // Five traceroute-fed triggers were REMOVED here 2026-08-17 (task
    // `traceroute-remove-backend-remainder`): traceroute.on('aiming'/'aimed')
    // broadcasting trace_aiming/trace_aimed, on('start')/on('result') moving
    // the focus node, on('cancel') broadcasting traceroute_failed, and
    // passiveTracer.on('tracing') raising the PASV card.
    //
    // Peter, 2026-08-04, on what the first two were for: "the beauty and
    // refinement of the radar is it actually animates the whole traceroute —
    // the antenna aiming, the target node, and an animated route." Worth
    // rebuilding on the replacement; the animation was never the broken part.
    //
    // What remains is what never depended on a traceroute: the rotator's own
    // target, the mode, and the scan.
    aimEvents.on('point_target', () => broadcastRadarContext());
    dashMode.on('change', () => broadcastRadarContext());
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

    // Always send current dash mode so the mode selector renders even before
    // any rotator command has been issued this session. No more switchable
    // target list or live status to replay (2026-09-03) — node-dash holds
    // neither any more.
    ws.send(JSON.stringify({ type: 'rotator', data: { _mode: dashMode.value } }));
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

      // The traceroute_history replay is REMOVED — 2026-08-17, task
      // `traceroute-remove-backend-remainder`. Peter kept the 37,424 rows and
      // dropped the reads: they stay in the table for the redesign, and no
      // surface serves them. It read 500 rows, decoded SNR to dB at this emit
      // boundary and attached each row's link budget; that decode-once-at-the-
      // boundary rule is worth keeping when something reads them again.
      // The band tables themselves. Per-row `health` covers rows; the perf
      // page's HEADLINE figures are client-side medians (perfSummary ->
      // _perfMedian over the user's selected radio/kind) and so have no row to
      // carry a verdict. Serving the table lets the browser look up without
      // owning a single threshold — docs/modules/verdict-bands.md, same shape
      // as SPLIT_READINESS §4's recommendation for the radar scale.
      //
      // Static config, so once on connect rather than on every broadcast.
      ws.send(JSON.stringify({ type: 'verdict_bands', ...verdictBands() }));

      // IN-FLIGHT TRACEROUTES, so a client connecting mid-trace is not blind
      // until the next transition — which for a 60 s trace may be the end of it.
      // Nothing in flight sends nothing, rather than an empty frame nobody can
      // distinguish from "the feed is broken".
      for (const s of traceroute.inFlight()) {
        ws.send(JSON.stringify({ type: 'traceroute_status', ...s, replay: true }));
      }
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

    // Always send current dash mode — no more switchable target list or live
    // status to replay (2026-09-03, task rotator-command-via-meshgw-aim).
    ws.send(JSON.stringify({ type: 'rotator', data: { _mode: dashMode.value } }));
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
    aimEvents.on('point_target',  onRotatorTarget);
    aimEvents.on('signal_update', onSignalUpdate);
    dashMode.on('change', onDashMode);
    scanner.on('start',    onScanStart);
    scanner.on('progress', onScanProgress);
    scanner.on('contact',  onScanContact);
    scanner.on('end',      onScanEnd);
    nodeList.on('change',  onNodeList);

    ws.on('close', () => {
      bridge.off('event', onEvent);
      aimEvents.off('point_target',  onRotatorTarget);
      aimEvents.off('signal_update', onSignalUpdate);
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
