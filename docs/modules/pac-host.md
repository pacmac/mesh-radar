---
module: pac-host
source: src/pac-host.js
source_hash: 0b6b6c22735f6cb84c75b7d478eb0150fac1b8d0943cc77a6bb5478a19d6d3da
updated: 2026-07-25
---

# Module: pac-host

## Purpose

Detects, monitors and talks to the optional external "pac-host" service
(mt-transport's custom/alarm backend — see
`/usr/share/pac/dev/pio/projects/mt-transport/clients/host/API.md`, now
**LIVE** v1). Absence is the normal state: a machine with no pac-host running
boots clean and serves every page identically to today.

This module is the **only** place in node-dash that knows pac-host's URL,
routes or wire shapes. Everything else — status detection, and now command
dispatch — is a small function call from here; no other file ever branches
on pac-host's behalf (task `custom-app-extension-point`, hard-won over
several design corrections this session — see its notes for the "why").

**Node data is out of scope by design, not by staging.** pac-host's units
(`!8cee336b`/BNCH, `!987ab80f`/GARG) are, by explicit architecture decision,
ordinary Meshtastic nodes — read via mesh-gw exactly like any other node,
with no special key, no separate treatment, no involvement from this module
at all (confirmed 2026-07-25, see xsession history and task
`custom-app-extension-point` notes; an earlier version of this module briefly
carried a `pac_host`-node-enrichment stub built on the opposite assumption —
removed, task `pac-host-strip-node-enrichment`). This module's only job is
the health/status signal.

## Responsibilities

- Poll `GET {PAC_HOST_URL}/health` on startup and on a fixed interval.
- Derive an availability state from the response (`ok`/`status`/`modules`),
  never from "did the TCP connection succeed" alone — an unreachable host and
  a reachable-but-degraded host are different states, both real.
- Expose that state to the rest of node-dash via a plain getter — no
  `import()`-time capability negotiation (unlike the archived
  `transport-plugin.js` pattern, which loads an in-process npm module; this
  is a separate OS process reached over HTTP, a different problem).
- Forward a command to a pac-host unit (`POST /v1/mesh/queue`) and fetch that
  unit's queue ledger for receipt polling (`GET /v1/mesh/queue/:target`).
  Pure passthrough — no verb validation, no mesh mechanics, per mt-transport's
  explicit instruction that node-dash should not need to know any (xsession,
  `[ownership-2-correction]`, archived 2026-07-25).

## Dependencies

- `log.js` — `log.info/warn/debug('pac-host', ...)`, matching the tag
  convention `bridge.js`/archived `transport-plugin.js` use.
- Global `fetch` (Node 18+, already relied on by `bridge.js` — no new
  dependency).

## Public interface

Deliberately small — every function the rest of node-dash needs is
ready-made here, so no call site outside this file needs to know pac-host's
event shapes or message types.

```js
export function start()          // begin polling; idempotent
export function stop()           // clear the poll timer (tests/shutdown)
export function isAvailable()    // boolean — true only when status is 'ready' or 'degraded'
export function connectMessage() // → { type: 'pac_host_status', ...status() } — ready to JSON.stringify and send as-is
export const events              // EventEmitter, emits 'change' when status() changes
export async function queueCommand({ unit, verb, args }) // → POST /v1/mesh/queue body, returns the raw JSON response ({id, ...}) or throws Error('pac-host <status>: <detail>')
export async function getQueue(unit)                     // → GET /v1/mesh/queue/:target, returns the raw ledger array; throws the same way
```

`status()` is internal (backs `connectMessage()`/`isAvailable()`) —
not exported separately, so there is exactly one place (`connectMessage()`)
that defines the wire shape of "pac-host's current state."

### `connectMessage()` shape

```js
{
  type: 'pac_host_status',
  available: boolean,       // false until first successful poll, or on any poll failure
  status: 'ready'|'degraded'|'down'|'unreachable', // 'unreachable' = our poll couldn't connect at all — not one of pac-host's own states, added here to distinguish "no service" from "service says down"
  modules: [{ name, status, error? }] | [],
  lastCheckedMs: number | null,
  error: string | null,     // set only when status === 'unreachable'
}
```

## Dependents

- `src/index.js` — imports and calls `start()` at boot, alongside `bridge.start()`.
- `src/ws-relay.js`:
  1. Import: `import * as pacHost from './pac-host.js';`
  2. In the connection handler, alongside the existing `bridge_connected` send: `ws.send(JSON.stringify(pacHost.connectMessage()));` — this is how a newly-connected browser gets the current status immediately.
  3. One wiring line near `broadcast()`'s definition: `pacHost.events.on('change', () => broadcast(pacHost.connectMessage()));` — this is how already-connected browsers get told when status changes.
- `src/pac-command-api.js` (task `pac-host-command-surface`) — thin Express router, `POST /nodes/:num/pac-command` and `GET /nodes/:num/pac-command`, calling `queueCommand()`/`getQueue()`. Owns HTTP request/response shape only; no pac-host knowledge of its own.
- `public/app.js`/`public/app-ws.js`/`public/index.html` (task `pac-host-header-badge`) — render `pac_host_status` as a small navbar badge. Pure presentation of what this module already sends; no other coupling.

## State

- `_timer` — the poll interval handle (module scope, not exported).
- `_lastStatus` — cached `status()` result, compared each poll to decide whether to emit `change`.

## Events emitted

- `change` — fired when `status()`'s shape changes (state transition or `modules` list changes). Not fired on every poll if nothing changed (avoids a `pac_host_status` broadcast storm every interval).

## Invariants

- Never throws on an unreachable host — a connection failure resolves to `status: 'unreachable'`, not a rejected promise a caller has to catch.
- Never blocks startup — `start()` fires the first poll asynchronously; node-dash serves every page before the first poll resolves.
- `PAC_HOST_URL` follows house convention (`process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1'`), same shape as `BRIDGE_URL` — auto-probes by default, no separate on/off flag. Absence of a running service, not absence of config, is what disables the integration.

## Test notes

- Functional check available now (pac-host not deployed): `PAC_HOST_URL` pointing at nothing running → `connectMessage()` reports `status: 'unreachable'` within one poll interval, node-dash boots and serves normally.
- Verified live 2026-07-25 against the real running pac-host service: `connectMessage()` correctly reports `status: 'ready'`, `mesh`/`recorder` both `ready`.

## Out of scope

- Node data of any kind — see Purpose. Not staged for later; ruled out by design.
- Verb validation, argument shaping, or any mesh-mechanics knowledge for commands — `queueCommand()` is a pure passthrough; pac-host owns what a verb means.
- SSE (`GET /v1/events`) consumption — not needed for health polling or the queue's REST ledger; deferred to whichever future task actually needs live pac-host events (e.g. `mesh.reply` for instant receipts instead of polling the ledger).
