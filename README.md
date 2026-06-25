# mesh-radar — Meshtastic Node Dashboard

[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20NC-blue)](LICENSE)

A real-time web dashboard for Meshtastic mesh networks with directional antenna tracking. Connects to a [mesh-gw](https://github.com/pacmac/mesh-gw) bridge instance, stores node and message data in SQLite, and controls a directional Yagi antenna rotator to actively acquire and measure signal from mesh nodes.

---

## Features

- **Live radar display** — plots all visible mesh nodes by bearing and distance on a polar radar
- **Route overlays** — traceroute hop chains drawn on the radar for every node with known route data; animated dots while a traceroute is actively in flight
- **Traceroute** — auto-dispatched in all modes; results stored per-node and drawn as route overlays; SSOT lifecycle managed by `src/traceroute.js`
- **Mast Tilt display** — polar tilt chart on the overview page showing live roll/pitch from a LIS3DH accelerometer on the antenna mast, with 4h/24h history
- **Message view** — threaded chat with DM and channel support
- **Node table** — filterable list with signal quality, hops, position, telemetry
- **ACTV mode** — proactive scheduler rotates the Yagi antenna through all radar-visible nodes; click any node in the list to manually target it
- **SCAN mode** — full 360° sweep recording signal contacts at each azimuth; auto-dispatches traceroutes on contact
- **PASV mode** — passive listening; auto-traceroutes nodes as they are heard
- **Persistent node tracking** — `nodeinfo` table survives restarts; per-node Yagi contact history (visit count, contact count, best RSSI/SNR, last contact)
- **Range test logging** — records individual signal readings from the pointed target
- **Shared signal quality calculation** — `src/utils.js` served to both backend and browser as a single source of truth

---

## Architecture

```
mesh-gw (BLE bridge)
    │  REST + WebSocket
    ▼
src/bridge.js          ← connects to mesh-gw, emits node/packet events
src/index.js           ← Express server, API routes, event dispatch
src/db.js              ← SQLite (better-sqlite3), schema, prepared statements
src/node-list.js       ← in-memory filtered node list, position enrichment
src/node-filter.js     ← SSOT filter logic (hops, age, source, role, etc.)
src/traceroute.js      ← SSOT traceroute lifecycle: dispatch, decode, storage, broadcast
src/passive-tracer.js  ← PASV mode: auto-traceroute on packet receipt
src/active-tracker.js  ← ACTV mode: proactive scheduler, manual targeting
src/scanner.js         ← SCAN mode: 360° sweep
src/rotator.js         ← WebSocket client to rotator hardware
src/dash-mode.js       ← PASV/ACTV/SCAN state, persisted in config table
src/ws-relay.js        ← broadcasts events to browser; derives radar_context display state
src/utils.js           ← pure shared functions (haversine, bearing, signalQuality, node ID)
public/                ← static frontend (Alpine.js, Tailwind CSS, SVG radar)
```

Consumers connect to the dashboard at `http://host:8000`. The frontend communicates over a single WebSocket for live updates.

---

## Requirements

- Node.js 20+
- A running [mesh-gw](https://github.com/pacmac/mesh-gw) instance
- (Optional) Antenna rotator with WebSocket interface (ESP32-based)

---

## Setup

```bash
pnpm install
```

Copy and edit environment config as needed (see **Configuration** below), then:

```bash
node src/index.js
# or with pm2:
pm2 start src/index.js --name node-dash
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Dashboard HTTP/WS port |
| `BRIDGE_URL` | `http://localhost:8001` | mesh-gw REST base URL |
| `BRIDGE_WS_URL` | `ws://localhost:8001` | mesh-gw WebSocket URL |
| `ROTATOR_WS_URL` | `ws://192.168.10.186:81` | Rotator controller WebSocket |
| `DB_PATH` | `./data/node-dash.db` | SQLite database path |

Runtime settings (home position, node filters, radar range, bridge config) are stored in the `config` table and edited via the dashboard UI.

---

## Dashboard Modes

Modes are UI/backend state only — no mode commands are ever sent to rotator firmware.

| Mode | Behaviour |
|---|---|
| **PASV** | Passive — rotator idle. Auto-dispatches traceroutes to nodes as packets are heard (5-minute cooldown per node). Route overlays animate while a traceroute is in flight. |
| **ACTV** | Active — proactive scheduler targets each radar-visible node for 90 s, in order of least-recently-visited. Click a node row to manually jump to it. Live RSSI/SNR displayed in the targeted node card. Traceroute dispatched on each visit. |
| **SCAN** | Scan — sweeps 360° in configured steps, records signal contacts at each bearing. Traceroute dispatched on each new contact. |

---

## Node Filtering

All filter logic lives in `src/node-filter.js` (SSOT). Filters are configurable via the UI and stored in the `config` table under `node_filters.*`:

| Key | Description |
|---|---|
| `max_age` | Maximum seconds since last heard (0 = disabled) |
| `max_hops` | Maximum mesh hops (`hops_away`) |
| `named_only` | Require a long name |
| `has_pos` | Require a known position |
| `hide_mqtt` | Exclude MQTT-sourced nodes |
| `has_signal` | Require RSSI or SNR |
| `has_telem` | Require device telemetry |
| `node_source` | `both` / `yagi` / `omni` — filter by which radio heard the node |
| `roles` | Restrict to specific Meshtastic device roles |

Own devices (configured in the device config) are always excluded from the node list and can never be targeted.

---

## Database

| Table | Persists | Contents |
|---|---|---|
| `nodeinfo` | Yes | Node metadata, position, Yagi contact history (`yagi_*` columns) |
| `messages` | Yes | Chat messages with full metadata |
| `range_test_log` | Yes | Individual signal readings from pointed target |
| `tilt_history` | Yes | LIS3DH mast tilt history (roll, pitch, raw XYZ) |
| `config` | Yes | All runtime settings |
| `nodes` | No | Ephemeral node state (cleared on restart) |
| `events` | Yes | Raw event log |

---

## API Routes (selected)

| Method | Path | Description |
|---|---|---|
| `GET` | `/status` | Bridge + device status |
| `POST` | `/rotator/mode` | Set dashboard mode (0=PASV, 1=ACTV, 2=SCAN) |
| `POST` | `/rotator/target` | Manually target a node by num (ACTV only) |
| `POST` | `/rotator/scan/start` | Start 360° scan |
| `POST` | `/rotator/scan/abort` | Abort current scan |
| `GET` | `/utils.js` | Shared utility functions (served as browser-compatible script) |
| `GET` | `/config/:key` | Read a config value |
| `PUT` | `/config/:key` | Write a config value |

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal, research, and non-commercial use.
