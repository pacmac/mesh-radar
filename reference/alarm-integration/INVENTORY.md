# Alarm Integration Reference

Status: reference only
Captured: 2026-07-23
Live product: `node-dash`
Previous implementation: PAC alarm-node management embedded in `node-dash`

## Purpose

This directory preserves the alarm-specific implementation removed from the live
`node-dash` backend and browser UI. Its tree mirrors the original repository, so
every preserved file retains its original relative path.

Nothing in this directory is loaded, served, tested, or imported by `node-dash`.
It is design evidence for a future integration supplied by an external transport
module. New integration work must use an explicit module boundary; code must not
be copied back into shared dashboard modules.

The preserved files are exact working-tree copies taken before removal. This
includes uncommitted changes that existed in the alarm UI at capture time.

## Product boundary

The live dashboard retains:

- Standard Meshtastic node information, position, telemetry, text messaging,
  traceroute, range test, radio/channel/admin configuration, and the registered
  `DETECTION_SENSOR_APP` text payload.
- The independent mast-tilt integration on private port 256.
- The independent directional gateway, Yagi rotator, scanner, and active tracker.
- The independent email and alerting integration.

The live dashboard removes:

- PAC role 200 and legacy `SENSOR` → `PAC_ALARM` inference.
- The named `Private` channel requirement and `@<target> <verb>` alarm grammar.
- Port 260 config/debug/calc parsing and storage.
- Port 261 chunk/image transfer, capture, and image viewer.
- Alarm settings, arbitrary control commands, camera capture, and alignment ping.
- Alarm-specific message taxonomy and command feed.
- All alarm navigation, pages, state, and editable node-status controls.
- Runtime loading of the previous transport adapter/plugin.

## Preserved custom-only backend files

| Original path | Responsibility | Future integration implication |
|---|---|---|
| `src/client-role.js` | PAC role 200 and legacy `SENSOR` classification | External integration must identify its own compatible nodes without changing standard node roles. |
| `src/transport-plugin.js` | Optional module loader and capability allow-list | Replace with the transport module's published contract; do not restore a dashboard-owned transport implementation. |
| `src/transport-adapter.js` | Adapter for port 260/261 operations | Belongs with the external transport module. |
| `src/node-settings.js` | Alarm schema, validation, Private-channel resolution, command/reply correlation | Transport owns schema, addressing, validation, and correlation. |
| `src/settings-api.js` | Alarm settings HTTP endpoint | A future UI adapter may expose a transport-owned operation through a narrow host API. |
| `src/command-api.js` | Alarm command grammar and HTTP endpoint | Must not return as a generic dashboard command endpoint. |
| `src/capture-api.js` | `cam grab` request/reply workflow | Transport capability, not core node behavior. |
| `src/chunk-api.js` | Port 261 transfer, storage, progress, and image listing | Transport capability and storage policy must be external. |
| `src/align-api.js` | Alarm ping/pong alignment session and dedicated WebSocket | Optional integration UI, implemented outside core. |
| `src/message-type.js` | Alarm/camera/diagnostic text classification | Integration-owned interpretation; core treats text as text. |

## Shared backend files that contained alarm hooks

The reference contains the complete pre-removal version of each file. The live
version retains unrelated standard or site-specific behavior.

| Original path | Removed alarm hooks |
|---|---|
| `src/index.js` | Alarm imports, routers, image serving, `/align`, alignment WS, and transport loading. |
| `src/bridge-events.js` | Settings, capture, chunk, and alignment reply consumers. |
| `src/persist.js` | PAC JSON interpretation on standard detection text and port 260 state ingest. |
| `src/filters.js` | Global alarm message-bucket classification. |
| `src/db.js` | `nodes.client_role`, PAC detection columns, `node_app_state`, and their statements/helpers. |
| `src/node-list.js` | `client_role` stamping on every node feed item. |
| `src/node-status.js` | Port 260 config/debug/calc sections, boot count, alarm JSON formatting, and edit metadata. |
| `src/ws-relay.js` | Chunk progress/image state, command feed, and alignment upgrade exception. |
| `src/mesh-send.js` | Pre-removal comments and sender assumptions tied to alarm operations. |

## Preserved custom-only browser files

| Original path | Responsibility |
|---|---|
| `public/app-control.js` | Alarm command-console state and requests. |
| `public/partials/tab-control.html` | Alarm Control tab. |
| `public/push.html` | Standalone alarm image/capture/transfer viewer. |
| `public/align.html` | Standalone mobile alignment page. |
| `public/app-align.js` | Alignment session client. |
| `public/align.css` | Alignment page styling. |

## Shared browser files that contained alarm hooks

| Original path | Removed alarm hooks |
|---|---|
| `public/app.js` | Control mixin and command/edit state. |
| `public/app-nav.js` | `/control` route and tab mapping. |
| `public/app-ws.js` | `command_history` and chunk event consumers. |
| `public/app-messages.js` | Alarm message-bucket rendering data. |
| `public/app-node-status.js` | Alarm setting-edit workflow. |
| `public/partials/drawer-sidebar.html` | Control navigation item. |
| `public/partials/tab-node.html` | Editable alarm config controls. |
| `public/index.html` | Control tab mount. |
| `ecosystem.config.cjs` | Previous external transport path and loader environment. |
| `radar.conf` | Previous alignment WebSocket reverse-proxy route. |

## Preserved tests and operational tools

- `tests/test_capture_api.mjs`
- `tests/test_transport_adapter.mjs`
- `tests/test_transport_plugin.mjs`
- `tests/fixtures/transport-broken.mjs`
- `tests/fixtures/transport-good.mjs`
- `scripts/push-observer.mjs`
- `scripts/transfer-guard.mjs`

These validate or observe the removed implementation only. They are retained as
historical examples and are not part of the live test suite.

## Preserved specifications

Alarm-only specifications and the pre-removal versions of affected shared-module
specifications are mirrored under `docs/`. They document the implementation as
it existed; they are not contracts for the cleaned dashboard.

This includes affected node-focus specifications and the operational observer
specifications, even where only part of a document described alarm behavior.

The previous `docs/modules/transport-plugin.md` claimed that core code knew none
of the private protocol. The audit disproved that claim: only chunk transfer used
the capability seam. Settings, commands, capture, alignment, port 260 ingest,
role classification, database state, message classification, and browser routing
bypassed it.

## External transport integration contract

A future integration should be delivered separately and expose a declarative
host contract resembling:

```text
integration metadata
  id, version, compatible node predicate

capabilities
  settings schema/read/write
  addressed command
  capture
  payload listing/fetch/progress
  optional alignment session

ingest
  accepts an immutable standard packet/event
  returns integration-owned state/events
  never changes core persistence ordering

browser contribution
  explicit navigation/page descriptors
  assets owned by the integration
  no direct edits to the core dashboard state object

lifecycle
  start(host), stop()
  capability discovery
  health/status
```

Core must provide only stable host services such as sending a Meshtastic packet,
subscribing to immutable received events, resolving configured radios/channels,
publishing isolated integration events, and registering/unregistering routes.
The integration must own private port numbers, payload schemas, target discovery,
reply correlation, persistence, and UI interpretation.

## Database note

The cleaned source does not create or query alarm-specific columns/tables.
Existing installations may still contain historical `client_role`,
`node_app_state`, or expanded `detection_events` storage in their SQLite file.
It is deliberately left untouched during a code purge to avoid destroying user
data. A separately approved data-retention migration may archive or drop it.

## Re-integration rule

Do not copy preserved files back into `src/` or `public/`. Use this inventory to
map the external module onto explicit host extension points, and test that
`node-dash` still boots and operates with the integration entirely absent.
