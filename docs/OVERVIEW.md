# node-dash — Architecture Overview

## Purpose

Real-time web dashboard for Meshtastic mesh networks with directional antenna tracking.
Connects to mesh-gw (BLE bridge) via apiV2, ingests node and packet events, stores
them in SQLite, and exposes a REST + WebSocket API for the browser frontend.

Stack: Node.js (ESM), Express 5, better-sqlite3, Alpine.js + Tailwind CSS, WebSocket.

---

## Two domains — never mixed

Every module, spec, and task belongs to exactly one domain.

**Domain 1 — Backend (`src/`):** Owns gw connection, event ingestion, SQLite storage,
node tracking, rotator control, traceroute lifecycle, config, alerts, and all business
logic. Consumes mesh-gw via apiV2 only. Has zero browser knowledge.

**Domain 2 — Browser (`public/`):** Owns rendering and user interaction only. Consumes
the node-dash backend API only. Has zero mesh-gw knowledge.

---

## Module map

### Entry point

| Module | Role |
|---|---|
| `index.js` | Express app, route mounts, static files, WS relay, server listen. **No domain logic.** |

### Bridge / connectivity

| Module | Role |
|---|---|
| `bridge.js` | mesh-gw WS+REST client (apiV2) |
| `startup.js` | `bridge.on('connected')` — seed node-list from gw, persist named nodes |
| `bridge-events.js` | `bridge.on('event')` dispatch — routes node_update/packet/traceroute/rangetest |
| `lifecycle.js` | Wires scanner/dashMode/rotator/passiveTracer events; manages mode transitions |

### Storage

| Module | Role |
|---|---|
| `db.js` | SQLite schema, migrations, all prepared statements |
| `persist.js` | gw event → SQLite routing (portnum handlers) |

### Node state

| Module | Role |
|---|---|
| `node-list.js` | In-memory node cache, filters, scan buffering state machine |
| `node-filter.js` | Node visibility filter config SSOT |
| `node-label.js` | Display name resolution (3-step priority) |

### Operational modes

| Module | Role |
|---|---|
| `dash-mode.js` | Dashboard mode SSOT (PASV=0, ACTV=1, SCAN=2) |
| `active-tracker.js` | ACTV mode — proactive node targeting cycle |
| `scanner.js` | SCAN mode — 360° sweep state machine |
| `passive-tracer.js` | PASV mode — auto-traceroute scheduling |
| `traceroute.js` | SSOT traceroute lifecycle (dispatch, decode, store, broadcast) |

### Rotator

| Module | Role |
|---|---|
| `rotator.js` | ESP32 Yagi rotator — WS client and command proxy |

### REST API routers (mounted by index.js)

| Module | Mount point | Role |
|---|---|---|
| `config-api.js` | `/config` | Display/filter settings |
| `device-config.js` | `/device-config` | BLE device registry |
| `rotator-api.js` | `/rotator` | Rotator control endpoints (11 routes) |
| `alerts-api.js` | `/alerts` | Alert config and rules |
| `messages-api.js` | — | `POST /:nodeId/messages` send + TX persist |
| `traceroute-api.js` | — | `POST /:nodeId/traceroute`, `GET /traceroute_history` |
| `range-test-api.js` | `/range_test` | Timer state, log, start/stop |
| `auto-purge-api.js` | `/auto-purge` | Scheduled node-DB purge |
| `op-manager.js` | `/ops` | Config operation state machine |

### Utilities / support

| Module | Role |
|---|---|
| `geocode.js` | Queued Nominatim reverse-geocode with SQLite cache; `GET /geocode` |
| `alerts.js` | Alert polling and event-driven alert evaluator |
| `mailer.js` | SMTP alert delivery |
| `imap-receiver.js` | IMAP reply-token polling → bridge DM send |
| `filters.js` | `queryMessages`, `queryNodes` for REST responses |
| `ws-relay.js` | WS broadcast to browser — event routing and on-connect replay |
| `feature-flags.js` | SSOT refactor gates |
| `utils.js` | Pure shared functions (served to browser and used by backend) |
| `log.js` | Levelled console logger (available; currently unused) |
| `bridge-config-schema.js` | Static bridge config field schema for browser UI |
| `rotator-config-schema.js` | Static rotator config field schema for browser UI |
| `emulator.js` | Standalone bridge API emulator — dev tool, not imported by index.js |

---

## Data flow

```
mesh-gw ──WS/REST──▶ bridge.js ──event──▶ bridge-events.js ──▶ persist.js
                                                              ──▶ node-list.js
                                                              ──▶ active-tracker.js
                                                              ──▶ scanner.js
                                                              ──▶ traceroute.js (FF.SSOT_TRACEROUTE)

                         └──connected──▶ startup.js ──▶ node-list.js
                                                     ──▶ persist.js (named node seed)

node-list.js ──▶ ws-relay.js ──WS /events──▶ browser
index.js ──REST──▶ browser
rotator.js ──WS──▶ ESP32 rotator
```

---

## Development phases

### Phase 1 — Backend proven (current)

All `src/` modules have current specs. `python scripts/check_specs.py` exits 0.
No browser-facing work (Phase 2) begins until this gate passes.

### Phase 2 — Browser API

Define the browser API from UI requirements, never from what the backend happens to emit.
Implement browser-facing endpoints and WS event contracts after Phase 1 is complete.

---

## index.js refactor (in progress)

`index.js` is being refactored from a 923-line monolith into a ~150-line pure web server.
All domain logic, state, and feature-specific routes are extracted into dedicated modules.

**Target index.js owns only:**
- Express app setup + JSON middleware
- SPA page routing + HTML partial assembly + `GET /utils.js`
- Route mounts (`app.use(...)`)
- Bridge proxy (`proxyToBridge` + `BRIDGE_PREFIXES`)
- WS-only enforcement guard
- Static file serving + debug route + catch-all
- `http.Server` creation + WS relay attachment + `broadcastAll`
- Server `listen()` + module startup calls (`bridge.start`, `rotator.start`, etc.)

Each extraction is a separate `/idiot` task with its own spec, implementation, and passing
`check_specs.py` before close.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP/WS listen port |
| `BRIDGE_URL` | `http://localhost:8001` | mesh-gw REST base URL |
| `BRIDGE_WS_URL` | `ws://localhost:8001` | mesh-gw WebSocket URL |
| `DB_PATH` | `data/node-dash.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Console log verbosity |

---

## Operational modes

| Mode | Value | Meaning |
|---|---|---|
| PASV | 0 | Passive listen — rotator tracks strongest signal automatically |
| ACTV | 1 | Active targeting — rotator tracks a chosen node |
| SCAN | 2 | 360° sweep — rotator steps through azimuths recording contacts |
