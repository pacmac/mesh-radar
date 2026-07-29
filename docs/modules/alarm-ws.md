---
module: alarm-ws
source: src/alarm-ws.js
source_hash: 32d69986141d733bb6548abd09bc571df359528d22c7ea869e85ba851063962d
updated: 2026-07-29
---

# Module: alarm-ws

## Purpose

**ALARM PLUGIN — not core.** Wires pac-host's events to the WebSocket and
contributes its three replay messages to each new connection. Delete this file
and its one import in `index.js` and core is unchanged.

Peter, 2026-07-29, on being told six of the seven couplings pre-dated that day's
work: *"makes no difference if they were added today or not they break the rules
and need fixing."*

`src/ws-relay.js` is core — it serves the WS for every page — and it named
`pac-host` seven times. Task `ws-relay-plugin-boundary` moved that wiring here.
Companion to `alarm-sections.js`, which did the same for `node-status.js`.

## Responsibilities

- Rebroadcast `pac_host_status` / `pac_host_queues` / `pac_host_align` when
  pac-host's own events fire
- Hint `node_status` for every unit when the roster changes
- Contribute the three replay messages sent to each new WS connection

## Dependencies

- `ws-relay.js` — `registerWsWiring`, `registerConnectReplay` (host services only)
- `pac-host.js` — the plugin's own boundary module

## Public interface

None. Self-registers on import, exports nothing.

## The contract

```
core → registerWsWiring(fn)      fn({ broadcast, hintNodeStatus })  — called ONCE
core → registerConnectReplay(fn) fn() → [msg, …]                    — per connection
```

Core learns nothing about what a plugin is for. `hintNodeStatus` is a bound
wrapper; `_hintNodeStatus` stays module-private in core.

## Invariants

- **Core must never import, name or branch on this module.** The only permitted
  reference is `index.js`'s single import.
- **The import must be STATIC and top-level.** `registerWsWiring` is read ONCE by
  `attachWsRelay` (`index.js:263`); a registration arriving later silently never
  fires. See Test notes — this was measured, not theorised.
- **Replay ORDER is part of the contract.** Core splices the replay list between
  the bridge-state message and `settings`. Moving it changes the Control page's
  first paint.
- **Replays are NOT enriched.** `broadcast()` applies `enrichEvent`; the
  connect-replay path never has. Routing replays through `sendEnriched` would
  silently change the payload.
- Message shapes are unchanged from when this lived in core — only the wiring
  location moved.

## Test notes

**A real regression was caught here, and it is the reason the static-import
invariant exists.** The first implementation used
`import('./alarm-ws.js')` inside `server.listen()`. Measured result:

| | connect replay | live broadcasts / 110 s |
|---|---|---|
| dynamic import inside `listen()` | worked | **0** |
| static top-level import | worked | **21** |

The replay kept working because `_connectReplays` is read per-connection, so a
late registration still lands. `_wsWirings` is read once at attach time, so it
did not. **That failure mode is invisible from the UI**: the Control page paints
correctly on load and then never updates.

Live cadence after the fix: `pac_host_queues` every ~5 s, `pac_host_status`
every ~30 s — matching pac-host's own poll intervals.

**Plugin-absent test, 2026-07-29.** With both `alarm-*` imports commented out and
node-dash restarted: **0** `pac_host_*` messages, no load errors, and the full
core set intact (`packet`, `node_list`, `device_list`, `rotator`, `tilt_cal`,
`message_history`, `env_history`, `range_test_log`, `node_status_update`).
Connect order with the plugin present is byte-for-byte what it was before the
move: `bridge_connected, pac_host_status, pac_host_queues, pac_host_align,
settings, …`

## Out of scope

- Every other handler in `ws-relay.js` — bridge, rotator, scanner, tilt. Those
  are core, not plugins.
- The `pac_host_*` message shapes — owned by `pac-host.js`.
- `alarm-sections.js` — a different hook, already correct.
