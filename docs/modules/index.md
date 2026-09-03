---
module: index
source: src/index.js
source_hash: b8f4811a9cef51e417732af654c8131f6359346488cdce73d4eb895e0ecd965b
updated: 2026-09-03
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
- Create the HTTP server and attach the dashboard WS relay.
- Run guarded one-shot migrations.
- On `listen`: start bridge, rotator, alert poller, imap receiver, and resume a
  saved scan.
- Wire bridge events, lifecycle, and startup handlers.

## Dependencies

Routers mounted (2026-09-03): `config-api`, `nodes-api`, `terrain`, `clusters`,
`reach`, `snapshot-api`, `performance-api`, `geocode`, `range-test-api`,
`traceroute-api`, `auto-purge-api`, `alerts-api`, `op-manager`, plus
`proxyToBridge` for `BRIDGE_PREFIXES` and any `!hexid`/MAC-shaped path.
Infrastructure: `bridge`, `ws-relay` (`attachWsRelay`), `db` (config +
migration statements), `aim-client`, `scanner`, `node-list`, `alerts`
(`startAlertPoller`), `imap-receiver`, `startup`, `lifecycle`, `node-filter`,
`node-label`, `device-config` (named exports only — `resolvePrimaryNodeId`,
resolvers, `onHomePosChange`; no router, no default export), `bridge-config-schema`,
`bridge-events`. Env: `PORT` (default 8000), `BRIDGE_URL` (default
`http://localhost:8001`).

**Removed 2026-09-03** (task `devices-management-removed-meshgw-owns-it`):
`device-config`'s router, `device-remove`, `radio-admin`, `radio-admin-api`.
**Removed earlier, same session**: `rotator-api`, `rotator`, `rotator-config-schema`
(task `rotator-command-duplicates-meshgw-radio-knowledge` — replaced by
`aim-client`), `messages-api` (task `messages-frontend-and-browser-route-removed`).

**Resolved 2026-09-03** (task `devices-removal-residue-cleanup`, entry
`backend-still-proxies-removed-device-management-routes`): `PAGES` no longer
lists `/messages` or `/device-config` (both pages are gone); `BRIDGE_PREFIXES`
no longer proxies `/ble`, `/ble_devices`, `/ota` or `/sections` — zero
remaining callers, verified by grepping every `public/*.js` and test file.
`/devices` stays in both — it is a real, tested (`test_node.py`) device-listing
endpoint, unrelated to device management; there is just no browser page or tab
for it any more. `/schema` also stays: still serves `/schema/bridge_config`
and `/schema/rotator_config`, both live.

## Public interface

None exported — this is the top-level script (`node src/index.js`, run under PM2).

## Route surface (mount order is the contract)

0. **NO-STORE, and ETags off** — `app.set('etag', false)` plus a middleware
   registered before everything else that sets `Cache-Control: no-store, no-cache,
   must-revalidate, max-age=0`, `Pragma`, `Expires` on every response. First in
   the stack so no later route can opt out. `express.static` is mounted with
   `etag/lastModified/cacheControl` all off for the same reason. A four-week-old
   cached 410 on `/devices` is why — see `docs/modules/no-cache.md`, and note that
   the WS-only guard below is exactly the kind of route that MUST NOT be cached,
   because it answers differently for the same URL.
1. `express.json()`.
2. **WS-only guard** — `GET` to a `WS_ONLY_ROUTES` first-segment (`/devices`,
   `/traceroute_history`, `/auto-purge`, `/geocode`) or exact `WS_ONLY_EXACT`
   (`/config`) is rejected **410** when the request carries `Sec-Fetch-Dest: empty`
   (a real browser `fetch()`). Server-side / curl (no such header) is allowed. This
   forces browser page-data onto the `/events` WS (transport rule,
   BROWSER_CONTRACT). Document navigations are exempt when identified by
   `Accept: text/html`, `Sec-Fetch-Mode: navigate`, or
   `Upgrade-Insecure-Requests: 1`; 410 responses are `no-store` so a prior API
   rejection cannot poison a later page navigation.
3. `GET /utils.js` — reads `src/utils.js`, strips comments + `export`, assigns the
   named funcs (`haversine`, `bearing`, `signalQuality`, `numToNodeId`,
   `nodeIdToNum`) to `window`. The browser's copy is generated from the one source.
4. **SPA page stubs** — for each known page path, serve assembled `index.html`
   **only** when `Accept: text/html` (a navigation); an XHR/`fetch()` falls through
   to the API. Registered **before** conflicting API routes (e.g. `/config`,
   `/devices`) so the browser gets the SPA while XHR hits the API.
5. node-dash APIs: `GET /status`, `GET|DELETE /nodes`, `GET|PUT /home_pos`,
   `POST /mode`, `POST /scan/start`, `POST /scan/abort`, then the mounted
   routers, then the node-dash-owned `GET /schema/bridge_config` (registered
   before the bridge proxy so it wins over the `/schema` `BRIDGE_PREFIXES`
   entry — `GET /schema/rotator_config` has no local handler and falls through
   to that same `/schema` prefix, proxied to mesh-gw), then
   performance/geocode/range/traceroute/auto-purge.
6. **Bridge proxy** — `proxyToBridge` forwards to `${BRIDGE_URL}${originalUrl}` for
   the `BRIDGE_PREFIXES` and for per-device paths (`/!hex…` and `/AA:BB:…:FF…`
   regexes). MAC is the canonical device key (IDENTITY.md §2).
7. `/alerts`, then **OpManager** `/ops` (registered before static to dodge the
   catch-all).
8. `express.static(public)`, `GET /debug`, then the **SPA catch-all**
   (`serveIndex`) last.

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
`initLifecycle()`, and `registerStartupHandlers(bridge)`.

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
- **THE ALARM IS GONE — it runs as its own service** (task
  `remove-alarm-from-node-dash`, 2026-08-17). Peter: *"you can delete it all. I
  will re-add it necessary in the new dash."* It lives at
  `/usr/share/pac/dev/projects/mt-alarm-1/html`, pm2 service `html`, serving on
  **`:8791`** (`/health`, `/state`, `/control`, `/api`, `/schema` all 200 when
  this was written). node-dash names it nowhere.

  > **The wiring invariant that used to live here was DISCHARGED, not deleted.**
  > It said every alarm reference must stay "a bare wiring line, deletable on its
  > own, leaving node-dash fully functional — that is the property that matters".
  > That property was tested on 2026-08-17 by actually deleting them, and it
  > held: the twelve lines came out with no core change required. The invariant
  > did its job; it is recorded here because a discipline that pays off should be
  > visible after the fact, not silently dropped.
  >
  > It also carried a correction (ledger B48) about an earlier version being
  > false. That history is kept in git, not repeated here.

  **Nothing may re-import it.** If the alarm ever needs to reach node-dash, or
  node-dash it, that is an HTTP/WS call between two services — never an import.

  Core modules that are **not** the composition root — `ws-relay.js`,
  `node-status.js`, `db.js`, everything else — must not import, name or branch
  on the plugin. They reach it only through the registration hooks.

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
