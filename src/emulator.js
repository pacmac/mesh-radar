// Standalone bridge emulator — runs on :8002, node-dash points at it via env vars:
//   BRIDGE_URL=http://localhost:8002 BRIDGE_WS_URL=ws://localhost:8002
// Usage: node src/emulator.js  (run from node-dash/ directory)
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

const PORT     = parseInt(process.env.EMULATOR_PORT) || 8002;
const DWELL_MS = parseInt(process.env.DWELL_MS)      || 8000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'node-dash.db');

const db = new Database(DB_PATH, { readonly: true });

const DEVICE_YAGI = '!fa39f7b4';
const DEVICE_OMNI = '!2687afb1';

// ── helpers ──────────────────────────────────────────────────────────────────

function loadNodes(namedOnly = false) {
  const where = namedOnly
    ? 'lat IS NOT NULL AND lon IS NOT NULL AND long_name IS NOT NULL'
    : 'lat IS NOT NULL AND lon IS NOT NULL';
  return db.prepare(
    `SELECT num, node_id, short_name, long_name, hw_model, lat, lon FROM nodes WHERE ${where} LIMIT 20`
  ).all();
}

function nodeToEntry(n) {
  const nodeId = n.node_id || `!${n.num.toString(16)}`;
  return {
    num: n.num,
    user: {
      id:               nodeId,
      long_name:        n.long_name  || '',
      short_name:       n.short_name || '',
      macaddr:          '',
      hw_model:         n.hw_model   || 'UNSET',
      public_key:       '',
      is_unmessagable:  false,
    },
    position: {
      latitude_i:      Math.round(n.lat * 1e7),
      longitude_i:     Math.round(n.lon * 1e7),
      altitude:        0,
      time:            Math.floor(Date.now() / 1000),
      location_source: 'LOC_MANUAL',
      ground_speed:    0,
      ground_track:    0,
      precision_bits:  14,
    },
    last_heard: Math.floor(Date.now() / 1000),
    via_mqtt:   false,
    hops:       1,
  };
}

function buildNodesResponse(nodes) {
  const map = {};
  for (const n of nodes) map[String(n.num)] = nodeToEntry(n);
  return { total: nodes.length, count: nodes.length, nodes: map };
}

const DEVICE_STATUS = { ble_state: 'ready', config_complete: true };

const STATUS_RESPONSE = {
  server: 'mesh-rest-bridge-multi',
  devices: [
    { node_id: DEVICE_OMNI, ble_state: 'ready', config_complete: true, node_count: 50 },
    { node_id: DEVICE_YAGI, ble_state: 'ready', config_complete: true, node_count: 50 },
  ],
};

const DEVICES_RESPONSE = [
  { id: DEVICE_OMNI, ble_state: 'ready', config_complete: true, node_count: 50 },
  { id: DEVICE_YAGI, ble_state: 'ready', config_complete: true, node_count: 50 },
];

// ── HTTP server ───────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const [pathname, search] = req.url.split('?');
  const namedOnly = search?.includes('named_only=true');

  if (pathname === '/status')  return res.end(JSON.stringify(STATUS_RESPONSE));
  if (pathname === '/devices') return res.end(JSON.stringify(DEVICES_RESPONSE));
  if (pathname === '/nodes')   return res.end(JSON.stringify(buildNodesResponse(loadNodes(namedOnly))));

  if (pathname === `/${DEVICE_YAGI}/status` || pathname === `/${DEVICE_OMNI}/status`)
    return res.end(JSON.stringify(DEVICE_STATUS));

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
}

// ── WS broadcast ─────────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── event builders ────────────────────────────────────────────────────────────

function makeNodeUpdate(n) {
  const nodeId = n.node_id || `!${n.num.toString(16)}`;
  return {
    type:   'node_update',
    device: DEVICE_YAGI,
    data: {
      num:  n.num,
      user: {
        id:              nodeId,
        long_name:       n.long_name  || '',
        short_name:      n.short_name || '',
        macaddr:         '',
        hw_model:        n.hw_model   || 'UNSET',
        public_key:      '',
        is_unmessagable: false,
      },
      position: {
        latitude_i:      Math.round(n.lat * 1e7),
        longitude_i:     Math.round(n.lon * 1e7),
        altitude:        0,
        time:            Math.floor(Date.now() / 1000),
        location_source: 'LOC_INTERNAL',
        ground_speed:    0,
        ground_track:    0,
        precision_bits:  14,
      },
      snr:        5.0,
      last_heard: Math.floor(Date.now() / 1000),
      hops_away:  1,
      via_mqtt:   false,
      rssi:       -80,
      hops:       1,
    },
  };
}

function makePacket(num) {
  return {
    type:   'packet',
    device: DEVICE_YAGI,
    data: {
      packet: {
        from:    num,
        to:      4294967295,
        decoded: {
          portnum: 'TELEMETRY_APP',
          payload: 'AAAA',
        },
        id:       Math.floor(Math.random() * 0xFFFFFFFF),
        rx_time:  Math.floor(Date.now() / 1000),
        hop_limit: 3,
        priority: 'BACKGROUND',
      },
    },
  };
}

// ── step loop ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runLoop() {
  const nodes = loadNodes(false);
  if (!nodes.length) {
    console.error('[emulator] no nodes with lat/lon in DB');
    process.exit(1);
  }
  console.log(`[emulator] ${nodes.length} nodes loaded — dwell ${DWELL_MS}ms`);

  let i = 0;
  while (true) {
    const n = nodes[i % nodes.length];
    console.log(`[emulator] → ${n.short_name || n.num} (${n.num})`);

    broadcast(makeNodeUpdate(n));
    await sleep(1000);

    for (let j = 0; j < 3; j++) {
      broadcast(makePacket(n.num));
      await sleep(1000);
    }

    await sleep(DWELL_MS);
    i++;
  }
}

// ── start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

const wss = new WebSocketServer({ server, path: '/events' });
wss.on('connection', ws => {
  console.log('[emulator] WS client connected');
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`[emulator] listening on :${PORT}  (db: ${DB_PATH})`);
  runLoop();
});
