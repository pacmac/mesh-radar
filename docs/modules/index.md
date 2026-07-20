---
module: index
source: src/index.js
source_hash: 90ba83643ee37656f2f6eaa67c07bf522b8ef095a96a51771f354b5bbfa70f8d
updated: 2026-07-20
---

# Module: index

## Purpose

The process entry point and REST orchestrator. It builds the Express app, mounts
every router in a deliberate order, wires the HTTP server to the WebSocket relays,
runs one-shot data migrations, and starts the long-lived subsystems. It contains
almost no business logic of its own — its job is **composition and ordering**.

Does **not**: implement feature logic (each router/module owns its own), talk to
the mesh-gw except to proxy (see `bridge.js`), or hold runtime state beyond the
`broadcastAll` forward-reference.

## Responsibilities

- Register the identity resolvers before anything consumes them (MAC↔node_id↔num).
- Create the Express app and the browser-facing route surface.
- Enforce the WS-only guard on real-time endpoints.
- Serve `/utils.js` as the browser SSOT copy of `src/utils.js`.
- Assemble `index.html` from partials and route SPA pages vs API calls.
- Mount all node-dash routers, then the bridge proxy, then static, then the SPA
  catch-all — order is load-bearing (see Invariants).
- Create the HTTP server, attach the dashboard WS relay and the align WS.
- Run guarded one-shot migrations.
- On `listen`: start bridge, rotator, alert poller, imap receiver, and resume a
  saved scan.
- Wire bridge events, lifecycle, startup handlers, and the optional transport plugin.

## Dependencies

Routers mounted: `config-api`, `nodes-api`, `settings-api`, `device-config`,
`device-remove`, `rotator-api`, `performance-api`, `geocode`, `align-api`,
`range-test-api`, `traceroute-api`, `auto-purge-api`, `messages-api`, `alerts-api`,
`op-manager`. Infrastructure: `bridge`, `ws-relay` (`attachWsRelay`), `align-api`
(`attachAlignWs`), `db` (config + migration statements), `rotator`, `scanner`,
`node-list`, `alerts` (`startAlertPoller`), `imap-receiver`, `startup`,
`lifecycle`, `transport-plugin`, `node-filter`, `node-label`, `device-config`
(`resolvePrimaryNodeId`), `bridge-config-schema`, `rotator-config-schema`,
`bridge-events`. Env: `PORT` (default 8000), `BRIDGE_URL` (default
`http://localhost:8001`).

## Public interface

None exported — this is the top-level script (`node src/index.js`, run under PM2).
It ends with a top-level `await loadTransport()`.

## Route surface (mount order is the contract)

1. `express.json()`.
2. **WS-only guard** — `GET` to a `WS_ONLY_ROUTES` first-segment (`/devices`,
   `/traceroute_history`, `/auto-purge`, `/geocode`) or exact `WS_ONLY_EXACT`
   (`/config`) is rejected **410** when the request carries `Sec-Fetch-Dest: empty`
   (a real browser `fetch()`). Server-side / curl (no such header) is allowed. This
   forces browser page-data onto the `/events` WS (transport rule, BROWSER_CONTRACT).
3. `GET /utils.js` — reads `src/utils.js`, strips comments + `export`, assigns the
   named funcs (`haversine`, `bearing`, `signalQuality`, `numToNodeId`,
   `nodeIdToNum`) to `window`. The browser's copy is generated from the one source.
4. **SPA page stubs** — for each known page path, serve assembled `index.html`
   **only** when `Accept: text/html` (a navigation); an XHR/`fetch()` falls through
   to the API. Registered **before** conflicting API routes (e.g. `/messages`,
   `/config`, `/devices`) so the browser gets the SPA while XHR hits the API.
4b. **chunk-api** — `chunkRouter` (`POST /nodes/:num/chunk-fetch`) mounted among
   the node-dash routers; and `express.static(chunkPayloadDir)` at `/chunk-images`
   serves the stored images read-only. Both precede the SPA catch-all.
4c. **command-api** — `commandRouter` (`POST /nodes/:num/command`) mounted among
   the routers: the addressed command/response send on the Private channel (chat
   stays on `messages-api` → Primary). Precedes the SPA catch-all.
5. node-dash APIs: `GET /status`, `GET /messages`, `GET|DELETE /nodes`, then the
   mounted routers, `GET|PUT /home_pos`, `/rotator`, the node-dash-owned schema
   endpoints (`/schema/rotator_config`, `/schema/bridge_config`) **before** the
   bridge proxy, then performance/geocode/align/range/traceroute/auto-purge/messages.
6. **Bridge proxy** — `proxyToBridge` forwards to `${BRIDGE_URL}${originalUrl}` for
   the `BRIDGE_PREFIXES` and for per-device paths (`/!hex…` and `/AA:BB:…:FF…`
   regexes). MAC is the canonical device key (IDENTITY.md §2).
7. `/alerts`, then **OpManager** `/ops` (registered before static to dodge the
   catch-all).
8. `express.static(public)`, `GET /debug`, `GET /align` (standalone documents),
   then the **SPA catch-all** (`serveIndex`) last.

## State

- `broadcastAll(msg)` sends a JSON message to every open dashboard WS client
  (`wss.clients`, `readyState === 1`). A module-scope `_broadcast` forward-reference
  is wired to it after `wss` exists, so `OpManager` (built earlier) can broadcast.

## One-shot migrations (all guarded by a `migrations.*` / `perf.*` config flag)

- `traceroute_tx_device` — backfill historic traceroute rows to the primary radio.
- `perf.failure_epoch` — stamp when failure recording began (pre-epoch success
  rates would read a fake 100%).
- `device_vocab_mac` — rewrite `!hex` device ids → MAC in `traceroute_history` /
  `messages` (identity Phase B).
- `node_device_mac` — rewrite `nodes.device` `!hex` → MAC.
- `signal_history_backfill` — seed `signal_history` from `messages` (same envelope
  datum, deduped).

Each runs once and sets its flag; re-runs are skipped.

## Startup sequence (`server.listen` callback and after)

`listen` → `bridge.start()`, `rotator.start()`, `startAlertPoller(nodeList)`,
`startImapReceiver()`, and scan-resume (restore `scan_nodes`, resume the scanner
once the rotator reports status). After the listener: `registerBridgeEvents(bridge)`,
`initLifecycle()`, `registerStartupHandlers(bridge)`, and `await loadTransport()`
(optional alarm-transport plugin; resolves to a null object when absent, so a stock
box boots unchanged).

## Invariants

- **Mount order is load-bearing.** Page stubs precede conflicting API routes;
  node-dash-owned schema endpoints precede the bridge proxy; `/ops` and named
  routes precede `express.static`; the SPA catch-all is last.
- **Resolvers are registered first** (top of file) so any later consumer has them.
- **The WS-only guard keys on `Sec-Fetch-Dest`**, which JS cannot forge — browser
  page-data GETs are hard-410'd; server-side calls pass. New page-data endpoints
  must be added to `WS_ONLY_ROUTES`/`WS_ONLY_EXACT`.
- **`broadcastAll` is defined after `wss`**; the `_broadcast` closure bridges the
  forward reference for `OpManager`.
- **`attachAlignWs` mounts a separate narrow WS** (`/align/events`) — deliberately
  not the dashboard `/events` stream (which pushes ~7.2 MB on connect).

## Test notes

- Boot: `pm2 logs` shows `[node-dash] listening on port 8000`, migrations log once,
  no dangling-import crash.
- WS-only guard: `curl /devices` (no `Sec-Fetch-Dest`) → proxied 200; a browser
  `fetch('/devices')` → 410 `ws_only`.
- `/utils.js` returns a classic script assigning the named functions to `window`.
- A page path with `Accept: text/html` returns assembled HTML; the same path via
  XHR returns the API JSON.

## Out of scope

- Every mounted router's own behaviour — documented in that router's module spec.
- mesh-gw semantics — `bridge.js` and `docs/gw/`.
- Known stale wiring (`startImapReceiver`, auto-purge) belongs to the
  `remove-legacy-mesh-features` task, not here.
