import { WebSocketServer } from 'ws';
import { bridge } from './bridge.js';
import { rotator } from './rotator.js';

export function attachWsRelay(server) {
  const wss = new WebSocketServer({ server, path: '/events' });

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

  return wss;
}
