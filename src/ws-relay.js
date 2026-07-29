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
import { ensureDeviceCfgMac, getDeviceCfg } from './device-config.js';
import { DEFAULTS as CONFIG_DEFAULTS } from './config-api.js';
import { getAutoPurgeCfg } from './auto-purge-api.js';
import { lookupGeocode } from './geocode.js';
import { FF } from './feature-flags.js';
import { traceroute } from './traceroute.js';
import { fmtAgo } from './format.js';

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
export function broadcastSettings() { _broadcastSettings(); }

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
        return { ...n, display_name: resolveNodeLabel(n.num), via, hops_verified, hops_display, hops_fresh };
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
        lastDeviceChannels[addr.toUpperCase()] = r.channels
          .map((c, i) => ({ index: c.index ?? i, name: c.settings?.name ?? '', role: c.role ?? null }))
          .filter(c => c.role === 'PRIMARY' || c.role === 'SECONDARY');
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
      channels: d.addr ? (lastDeviceChannels[d.addr.toUpperCase()] ?? null) : null,
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
    return _enrichMessages(queryMessages(200).map(r => ({ ...r, display_name: resolveNodeLabel(r.from_num) })));
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
        data: { ts: Math.floor(Date.now() / 1000), from_num: ev.from_num ?? null, rssi: ev.rx_rssi ?? null, snr: ev.rx_snr ?? null, hops: ev.hops ?? null, seq, via_mqtt: ev.via_mqtt ?? false },
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
    passiveTracer.on('traced', (data) => broadcast({ type: 'route_discovered', ...data }));
  // ── [V2] SSOT — all traceroute results emit route_discovered, not PASV only
  } else {
    traceroute.on('result', (data) => broadcast({ type: 'route_discovered', ...data }));
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
      };
    }

    function broadcastRadarContext() {
      broadcast(buildRadarContext());
    }
    _getRadarContext = buildRadarContext;

    // Wire up triggers
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
      if (row) broadcast({ type: 'traceroute_failed', row });
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
      if (nodeStatusAgeTimer) clearInterval(nodeStatusAgeTimer);
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
      nodeStatusAgeTimer = setInterval(() => {
        if (!nodeStatusAge || ws.readyState !== 1) return;
        const ago = fmtAgo(nodeStatusAge.raw);
        if (ago == null || ago === nodeStatusAge.ago) return;
        nodeStatusAge.ago = ago;
        ws.send(JSON.stringify({
          type: 'node_status_age',
          num: nodeStatusAge.num,
          raw: nodeStatusAge.raw,
          ago,
        }));
      }, 1000);
    }

    ws.once('close', stopNodeStatusAge);

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

      const rangeLog = queryRangeTestLog(500).map(r => ({
        ...r, from_name: resolveNodeLabel(r.from_num), rx_name: resolveDeviceLabel(r.rx_device),
      }));
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
        snr_towards:     JSON.parse(r.snr_towards     || '[]'),
        snr_back:        JSON.parse(r.snr_back        || '[]'),
        relay_positions: JSON.parse(r.relay_positions || '{}'),
      }));
      ws.send(JSON.stringify({ type: 'traceroute_history', rows: traceRows,
                               failure_epoch: getConfig('perf.failure_epoch', null) }));
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
