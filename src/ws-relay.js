import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { insertTilt } from './db.js';
import { dashMode } from './dash-mode.js';

// Returns a wrapper that throttles rotator status pushes:
//   - state change (busy/stall/dir flip) → immediate
//   - busy=true  → at most every 100ms  (10 Hz)
//   - busy=false → at most every 1000ms ( 1 Hz heartbeat)
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

export function attachWsRelay(server) {
  // Both WSSes use noServer so they never compete on the upgrade event.
  // All routing is done manually in the server 'upgrade' handler below.

  // -- Unified /events — all devices (backward compat) -----------------------
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  bridge.on('event', (ev) => {
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
    broadcast(ev);
  });
  rotator.on('status', makeRotatorThrottle((data) => broadcast({ type: 'rotator', data })));
  rotator.on('point_target', (data) => broadcast({ type: 'rotator', data }));
  dashMode.on('change',      (data) => broadcast({ type: 'rotator', data }));

  scanner.on('start',    (data) => broadcast({ type: 'scan_start',    data }));
  scanner.on('progress', (data) => broadcast({ type: 'scan_progress', data }));
  scanner.on('contact',  (data) => broadcast({ type: 'scan_contact',  data }));
  scanner.on('end',      (data) => broadcast({ type: 'scan_end',      data }));
  nodeList.on('change',  (nodes) => broadcast({ type: 'node_list', nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));

  wss.on('connection', (ws) => {
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: dashMode.value } }));
    }
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz,
        contacts: scanner.contacts,
      }}));
    }
    ws.send(JSON.stringify({ type: 'node_list', nodes: nodeList.nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));
  });

  // -- Per-device /!{nodeId}/events — snapshot first, pre-filtered -----------
  const wssDevice = new WebSocketServer({ noServer: true });

  function attachDeviceClient(ws, nodeId) {
    // Send snapshot immediately so the client is never blind on connect
    bridge.get(`/${nodeId}/status`).then(status => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'snapshot', device: nodeId, ...status }));
      }
    }).catch(() => {});

    // Rotator status
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: dashMode.value } }));
    }
    // Scan state resume
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz, contacts: scanner.contacts,
      }}));
    }
    // Node list snapshot
    ws.send(JSON.stringify({ type: 'node_list', nodes: nodeList.nodes, device_nodes: nodeList.ownDeviceNodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));

    function onEvent(ev) {
      if (ws.readyState !== 1) return;
      if (!ev.device || ev.device === nodeId || ev.type?.startsWith('ota_')) ws.send(JSON.stringify(ev));
    }

    const onRotatorStatus = makeRotatorThrottle((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
    });
    const onRotatorTarget = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
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
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'node_list', nodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));
    }

    bridge.on('event', onEvent);
    rotator.on('status',       onRotatorStatus);
    rotator.on('point_target', onRotatorTarget);
    dashMode.on('change', onDashMode);
    scanner.on('start',    onScanStart);
    scanner.on('progress', onScanProgress);
    scanner.on('contact',  onScanContact);
    scanner.on('end',      onScanEnd);
    nodeList.on('change',  onNodeList);

    ws.on('close', () => {
      bridge.off('event', onEvent);
      rotator.off('status',       onRotatorStatus);
      rotator.off('point_target', onRotatorTarget);
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

    // Unknown WS path — reject cleanly
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  return wss;
}
