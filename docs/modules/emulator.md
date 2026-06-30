---
module: emulator
source: src/emulator.js
source_hash: 8ae7cf9343f3df52c4d4325d0c0c4cf6d0b9744a56bc9d07186c58857017177c
updated: 2026-06-30
---

# Module: emulator

## Purpose

Standalone bridge API emulator for development and testing. Mimics the subset of
the mesh-gw REST and WebSocket API consumed by node-dash, using real node data from
the node-dash DB. Not imported by the main process — run separately.

## Usage

```sh
# From node-dash/
BRIDGE_URL=http://localhost:8002 BRIDGE_WS_URL=ws://localhost:8002 node src/emulator.js
# then start node-dash normally
```

## Responsibilities

- Serve a minimal HTTP REST API on `:8002` that satisfies node-dash's startup queries
- Serve a WebSocket endpoint at `/events` that emits a continuous stream of mock events
- Load real nodes with lat/lon from the node-dash SQLite DB for realistic data
- Cycle through nodes emitting `node_update` + `packet` events at a configurable interval

## Dependencies

- `ws` — `WebSocketServer`
- `better-sqlite3` — read-only access to the node-dash DB
- `node:http`, `node:path`, `node:url` — standard Node.js

**Not imported by any other module.** This file is an executable entry point only.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `EMULATOR_PORT` | `8002` | HTTP/WS listen port |
| `DWELL_MS` | `8000` | Milliseconds between node cycles |
| `DB_PATH` | `data/node-dash.db` | Path to the node-dash SQLite DB (read-only) |

## Fixed device identities

```js
DEVICE_YAGI = '!fa39f7b4'
DEVICE_OMNI = '!2687afb1'
```

These are hard-coded as the two emulated gateway radios.

## HTTP endpoints

All responses are JSON. Unknown paths → 404 `{ error: 'not found' }`.

### `GET /status`

Returns a `STATUS_RESPONSE` with `server: 'mesh-rest-bridge-multi'` and a `devices` array listing both YAGI and OMNI as `{ node_id, ble_state: 'ready', config_complete: true, node_count: 50 }`.

### `GET /devices`

Returns `DEVICES_RESPONSE` — array of `{ id, ble_state: 'ready', config_complete: true, node_count: 50 }` for both devices.

### `GET /nodes[?named_only=true]`

Loads up to 20 nodes from the DB with `lat IS NOT NULL AND lon IS NOT NULL`. If `named_only=true`, also requires `long_name IS NOT NULL`. Returns `{ total, count, nodes: { [num]: entry } }` in the bridge REST format.

Each `entry` shape:
```js
{
  num, user: { id, long_name, short_name, macaddr, hw_model, public_key, is_unmessagable },
  position: { latitude_i, longitude_i, altitude, time, location_source, ground_speed, ground_track, precision_bits },
  last_heard, via_mqtt: false, hops: 1,
}
```

`latitude_i`/`longitude_i` are `Math.round(lat * 1e7)` (Meshtastic integer encoding).

### `GET /!fa39f7b4/status` and `GET /!2687afb1/status`

Returns `{ ble_state: 'ready', config_complete: true }`.

## WebSocket — `/events`

Accepts connections; adds each to a `clients` Set. Removes on close. No authentication.

## Event loop (`runLoop`)

Runs forever after the server starts listening. Loads all nodes with lat/lon (up to 20) from the DB at startup. Exits with code 1 if no nodes found.

Per cycle (one node per cycle):

1. `broadcast(makeNodeUpdate(n))` — emit a `node_update` event
2. `sleep(1000)`
3. 3× `broadcast(makePacket(n.num))` with 1000ms between each
4. `sleep(DWELL_MS)` — wait before advancing to the next node

Cycles wrap: `i % nodes.length` ensures infinite cycling through the node set.

## WS event shapes

### `node_update`

```js
{
  type:   'node_update',
  device: '!fa39f7b4',   // always DEVICE_YAGI
  data: {
    num, user: { id, long_name, short_name, macaddr, hw_model, public_key, is_unmessagable },
    position: { latitude_i, longitude_i, altitude, time, location_source: 'LOC_INTERNAL', ... },
    snr: 5.0, last_heard, hops_away: 1, via_mqtt: false, rssi: -80, hops: 1,
  },
}
```

### `packet`

```js
{
  type:   'packet',
  device: '!fa39f7b4',   // always DEVICE_YAGI
  data: {
    packet: {
      from:    <num>,
      to:      4294967295,  // broadcast
      decoded: { portnum: 'TELEMETRY_APP', payload: 'AAAA' },
      id:      <random uint32>,
      rx_time: <unix seconds>,
      hop_limit: 3,
      priority: 'BACKGROUND',
    },
  },
}
```

## Invariants

- The DB is opened read-only — the emulator never writes to the node-dash DB.
- Node data is loaded once at startup; changes to the DB after startup are not reflected.
- `makePacket` uses `Math.random()` for packet IDs — results are non-deterministic.
- **v1 event format**: events use the `device` field (v1 bridge format). These events will not be processed correctly by node-dash after bridge.js is aligned to v2 (`__ble_addr`).
- The emulator does not emit `device_snapshot`, `device_state`, or `device_data` events — node-dash will start but show no device state on the browser WS relay.
- The emulator does not implement any write endpoints (`PUT`, `POST`, `DELETE`). Operations like sending messages or updating config will fail with 404.

## Out of scope

- The main node-dash runtime — this is a development tool only
- Accuracy of emulated data — values are plausible but fixed (SNR=5, RSSI=-80, hops=1)
- Full bridge API coverage — only the read endpoints node-dash calls at startup are emulated
