import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';

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

  bridge.on('event', (ev) => broadcast(ev));
  rotator.on('status', (data) => broadcast({ type: 'rotator', data }));
  rotator.on('point_target', (data) => broadcast({ type: 'rotator', data }));

  wss.on('connection', (ws) => {
    if (rotator.connected && Object.keys(rotator.status).length > 0) {
      ws.send(JSON.stringify({ type: 'rotator', data: rotator.status }));
    }
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
      ws.send(JSON.stringify({ type: 'rotator', data: rotator.status }));
    }

    function onEvent(ev) {
      if (ws.readyState !== 1) return;
      if (!ev.device || ev.device === nodeId || ev.type?.startsWith('ota_')) ws.send(JSON.stringify(ev));
    }

    function onRotator(data) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rotator', data }));
    }

    bridge.on('event', onEvent);
    rotator.on('status', onRotator);
    rotator.on('point_target', onRotator);

    ws.on('close', () => {
      bridge.off('event', onEvent);
      rotator.off('status', onRotator);
      rotator.off('point_target', onRotator);
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
