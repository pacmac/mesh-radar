import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';
import { scanner } from './scanner.js';
import { nodeList } from './node-list.js';
import { insertTilt } from './db.js';

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
  rotator.on('status', (data) => broadcast({ type: 'rotator', data }));
  rotator.on('point_target', (data) => broadcast({ type: 'rotator', data }));
  rotator.on('mode', (data) => broadcast({ type: 'rotator', data }));

  scanner.on('start',    (data) => broadcast({ type: 'scan_start',    data }));
  scanner.on('progress', (data) => broadcast({ type: 'scan_progress', data }));
  scanner.on('contact',  (data) => broadcast({ type: 'scan_contact',  data }));
  scanner.on('end',      (data) => broadcast({ type: 'scan_end',      data }));
  nodeList.on('change',  (nodes) => broadcast({ type: 'node_list', nodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));

  wss.on('connection', (ws) => {
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: rotator.mode } }));
    }
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz,
        contacts: scanner.contacts,
      }}));
    }
    ws.send(JSON.stringify({ type: 'node_list', nodes: nodeList.nodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));
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
      ws.send(JSON.stringify({ type: 'rotator', data: { ...rotator.status, _mode: rotator.mode } }));
    }
    // Scan state resume
    if (scanner.active) {
      ws.send(JSON.stringify({ type: 'scan_start', data: {
        resumed: true, az: scanner.az, dwell_az: scanner.dwellAz, contacts: scanner.contacts,
      }}));
    }
    // Node list snapshot
    ws.send(JSON.stringify({ type: 'node_list', nodes: nodeList.nodes, total: nodeList._cache.size, hasHomePos: nodeList.homePos != null }));

    function onEvent(ev) {
      if (ws.readyState !== 1) return;
      if (!ev.device || ev.device === nodeId || ev.type?.startsWith('ota_')) ws.send(JSON.stringify(ev));
    }

    function onRotator(data) {
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
    rotator.on('status', onRotator);
    rotator.on('point_target', onRotator);
    rotator.on('mode', onRotator);
    scanner.on('start',    onScanStart);
    scanner.on('progress', onScanProgress);
    scanner.on('contact',  onScanContact);
    scanner.on('end',      onScanEnd);
    nodeList.on('change',  onNodeList);

    ws.on('close', () => {
      bridge.off('event', onEvent);
      rotator.off('status', onRotator);
      rotator.off('point_target', onRotator);
      rotator.off('mode', onRotator);
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
