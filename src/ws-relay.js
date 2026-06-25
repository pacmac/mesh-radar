import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { insertTilt, getTiltCal } from './db.js';
import { handleAlertEvent } from './alerts.js';
import { dashMode } from './dash-mode.js';
import { passiveTracer } from './passive-tracer.js';
import { resolveNodeLabel, resolveDeviceLabel } from './node-label.js';
import { FF } from './feature-flags.js';
import { traceroute } from './traceroute.js';

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
const STATE_EVENT_TYPES = new Set([
  'snapshot', 'ready', 'connecting', 'syncing', 'reconnecting',
  'error', 'idle', 'failed', 'sync_progress',
]);

export function attachWsRelay(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Last-known BLE state per device (node_id → event object).
  // Seeded from HTTP once on bridge (re)connect, then kept live by WS events.
  // Replayed to new frontend clients on connect — no per-client HTTP calls.
  const lastDeviceState = {};

  // Last-known device list — replayed to new frontend clients on connect.
  // Refreshed via one HTTP call whenever the set of connected devices changes.
  let lastDeviceList = null;
  const activeDeviceIds = new Set();

  // Single enrichment point — every outbound event passes through here.
  // Adds pre-resolved display labels so the UI never needs to resolve names itself.
  function enrichEvent(ev) {
    if (ev.type === 'node_list') {
      return { ...ev, nodes: (ev.nodes || []).map(n => ({ ...n, display_name: resolveNodeLabel(n.num) })) };
    }
    if (ev.type === 'device_list') {
      return { ...ev, devices: (ev.devices || []).map(d => ({ ...d, display_name: resolveDeviceLabel(d.node_id) })) };
    }
    if (ev.type === 'range_test_entry' && ev.data) {
      return { ...ev, from_name: resolveNodeLabel(ev.data.from_num), rx_name: resolveDeviceLabel(ev.device) };
    }
    if (ev.type === 'text_message' && ev.data?.from_num != null) {
      return { ...ev, from_name: resolveNodeLabel(ev.data.from_num) };
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

  bridge.on('connected',    () => broadcast({ type: 'bridge_connected' }));
  bridge.on('disconnected', () => {
    broadcast({ type: 'bridge_disconnected' });
    handleAlertEvent({ type: 'bridge_disconnected' });
  });

  function broadcastDeviceList() {
    const devices = Object.entries(lastDeviceState)
      .filter(([k]) => !k.startsWith('ble:'))
      .map(([nodeId, s]) => ({ node_id: nodeId, ...s }));
    lastDeviceList = { type: 'device_list', devices };
    broadcast(lastDeviceList);
  }

  bridge.on('event', (ev) => {
    if (ev.type === 'device_removed' && ev.device) {
      delete lastDeviceState[ev.device];
      activeDeviceIds.delete(ev.device);
      broadcastDeviceList();
      return;
    }

    // Keep last-known state current as events flow through
    if (ev.device && STATE_EVENT_TYPES.has(ev.type)) {
      // Merge so identity fields (short_name, long_name, hw_model) from 'ready'
      // are preserved across subsequent state events that don't include them.
      lastDeviceState[ev.device] = { ...lastDeviceState[ev.device], ...ev };

      // Detect device list changes and broadcast device_list
      const isActive = ev.type !== 'idle' && ev.type !== 'failed';
      const wasActive = activeDeviceIds.has(ev.device);
      if (isActive && !wasActive) {
        activeDeviceIds.add(ev.device);
        broadcastDeviceList();
      } else if (!isActive && wasActive) {
        activeDeviceIds.delete(ev.device);
        broadcastDeviceList();
      }
    }

    if (ev.type === 'tilt_update' && ev.data) {
      try {
        insertTilt({
          ts:      Math.floor(Date.now() / 1000),
          node_id: ev.device || '?',
          pitch:   ev.data.pitch ?? 0,
          roll:    ev.data.roll  ?? 0,
          x_g:     ev.data.x    ?? null,
          y_g:     ev.data.y    ?? null,
          z_g:     ev.data.z    ?? null,
        });
      } catch (e) { console.error('[tilt] insert failed:', e.message); }
    }
    handleAlertEvent(ev);
    broadcast(ev);
  });

  rotator.on('status', makeRotatorThrottle((data) => broadcast({ type: 'rotator', data })));
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
  dashMode.on('change',      (data) => broadcast({ type: 'rotator', data }));

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
    traceroute.on('cancel', () => {
      _rcActive = false;
      broadcastRadarContext();
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
    // Send current bridge connection state immediately
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: bridge.connected ? 'bridge_connected' : 'bridge_disconnected' }));
    }
    // Replay last-known BLE state for each device — no HTTP
    for (const state of Object.values(lastDeviceState)) {
      if (ws.readyState === 1) ws.send(JSON.stringify(state));
    }
    // Replay device list — no HTTP
    if (lastDeviceList) sendEnriched(ws, lastDeviceList);

    // Always send current dash mode — rotator may be offline but mode is persisted
    ws.send(JSON.stringify({ type: 'rotator', data: { _mode: dashMode.value } }));
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

    // Tilt calibration — replayed so browser never needs HTTP for this
    const cal = getTiltCal();
    ws.send(JSON.stringify({ type: 'tilt_cal', zero: cal.zero, north_angle: cal.north_angle }));
  });

  // -- Per-device /!{nodeId}/events — snapshot first, pre-filtered -----------
  const wssDevice = new WebSocketServer({ noServer: true });

  function attachDeviceClient(ws, nodeId) {
    // Replay last-known state for this device — no HTTP
    const state = lastDeviceState[nodeId];
    if (state && ws.readyState === 1) {
      ws.send(JSON.stringify(state));
    }

    // Always send current dash mode — rotator may be offline but mode is persisted
    ws.send(JSON.stringify({ type: 'rotator', data: { _mode: dashMode.value } }));
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
      if (!ev.device || ev.device === nodeId || ev.type?.startsWith('ota_')) sendEnriched(ws, ev);
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

  // -- Single upgrade router — exactly one WSS handles each request ----------
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
