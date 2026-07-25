---
module: pac-host
source: src/pac-host.js
source_hash: 00346590fadf53b93f9d550e57115d489c07a0d94efc4c36820ca3d4eebd70e8
updated: 2026-07-25
---

# Module: pac-host

## Purpose

Detects and monitors the optional external "pac-host" service (mt-transport's
custom/alarm backend — see
`/usr/share/pac/dev/pio/projects/mt-transport/clients/host/API.md`, DRAFT
v1). Absence is the normal state: a machine with no pac-host running boots
clean and serves every page identically to today.

This module owns exactly one thing: knowing whether pac-host is reachable and
what it reports. It does **not** implement any pac-host feature surface
(mesh node data, recorder status, commands) — those land in later, separate
tasks once pac-host's `mesh`/`recorder` modules actually ship (currently
DRAFT, not deployed; `mtmesh` still serves the old unversioned `:8787`
daemon this replaces).

## Responsibilities

- Poll `GET {PAC_HOST_URL}/health` on startup and on a fixed interval.
- Derive an availability state from the response (`ok`/`status`/`modules`),
  never from "did the TCP connection succeed" alone — an unreachable host and
  a reachable-but-degraded host are different states, both real.
- Expose that state to the rest of node-dash via a plain getter — no
  `import()`-time capability negotiation (unlike the archived
  `transport-plugin.js` pattern, which loads an in-process npm module; this
  is a separate OS process reached over HTTP, a different problem).
- Provide a stub per-node lookup (`forNode`) that always returns `undefined`
  today. It exists so `ws-relay.js` can wire its call site now — the
  wiring is real, the data behind it is not, because pac-host's `mesh`
  module (the source of any real per-node data) is still DRAFT.

## Dependencies

- `log.js` — `log.info/warn/debug('pac-host', ...)`, matching the tag
  convention `bridge.js`/archived `transport-plugin.js` use.
- Global `fetch` (Node 18+, already relied on by `bridge.js` — no new
  dependency).

## Public interface

Deliberately small — every function the rest of node-dash needs is
ready-made here, so no call site outside this file needs to know pac-host's
event shapes, message types, or per-node data format. Adding a second
pac-host-derived field later (e.g. once `mesh` ships for real) means editing
`enrichOutbound()` in this file only — zero changes anywhere else.

```js
export function start()          // begin polling; idempotent
export function stop()           // clear the poll timer (tests/shutdown)
export function isAvailable()    // boolean — true only when status is 'ready' or 'degraded'
export function connectMessage() // → { type: 'pac_host_status', ...status() } — ready to JSON.stringify and send as-is
export function enrichOutbound(ev) // → ev unchanged, OR a shallow copy with pac-host fields merged in. The ONLY function that knows which outbound event types pac-host cares about (today: node_list). Safe to call on every outbound event unconditionally — anything it doesn't recognise passes through untouched.
export const events              // EventEmitter, emits 'change' when status() changes
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

## Dependents (wiring added by this task — every touch point below is one line)

- `src/index.js` — imports and calls `start()` at boot, alongside `bridge.start()`. (2 lines: import + call.)
- `src/ws-relay.js` — the only other file touched, four single-line additions, no existing logic edited:
  1. Import: `import * as pacHost from './pac-host.js';`
  2. In the connection handler, alongside the existing `bridge_connected` send: `ws.send(JSON.stringify(pacHost.connectMessage()));`
  3. One wiring line near `broadcast()`'s definition: `pacHost.events.on('change', () => broadcast(pacHost.connectMessage()));`
  4. `broadcast()` and `sendEnriched()` each wrap their existing `enrichEvent(msg)` call: `JSON.stringify(enrichEvent(msg))` → `JSON.stringify(pacHost.enrichOutbound(enrichEvent(msg)))`. `enrichEvent()` itself and all its `if (ev.type === ...)` branches are NOT touched — the pac-host-aware step is a second, separate pipe stage after enrichEvent runs, not a change mixed into its matching logic.

Today `enrichOutbound()`'s `node_list` handling always leaves `pac_host` absent on every node (its lookup is the `forNode`-equivalent stub described above, private to this module) — so steps 2-4 are wired and testable, but produce no visible change in any WS payload until pac-host's `mesh` module actually ships and this file's internals (only this file's) get updated.

## State

- `_timer` — the poll interval handle (module scope, not exported).
- `_lastStatus` — cached `status()` result, compared each poll to decide whether to emit `change`.

## Events emitted

- `change` — fired when `status()`'s shape changes (state transition or `modules` list changes). Not fired on every poll if nothing changed (avoids a `pac_host_status` broadcast storm every interval).

## Invariants

- Never throws on an unreachable host — a connection failure resolves to `status: 'unreachable'`, not a rejected promise a caller has to catch.
- Never blocks startup — `start()` fires the first poll asynchronously; node-dash serves every page before the first poll resolves.
- `PAC_HOST_URL` follows house convention (`process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1'`), same shape as `BRIDGE_URL` — auto-probes by default, no separate on/off flag. Absence of a running service, not absence of config, is what disables the integration.
- `enrichOutbound()`'s internal per-node lookup is a permanent, explicit stub in this task, always yielding no `pac_host` field — replacing it is a separate task once pac-host's `mesh` module ships and its real node-data shape is known. All future pac-host field additions land inside this one function; no other file needs to change. This spec's `source_hash` covers only the stub.

## Test notes

- Functional check available now (pac-host not deployed): `PAC_HOST_URL` pointing at nothing running → `connectMessage()` reports `status: 'unreachable'` within one poll interval, `enrichOutbound(ev)` returns every event unchanged, node-dash boots and serves normally.
- Cannot test the `ready`/`degraded` path against a real pac-host yet (DRAFT, not deployed) — deferred until mt-transport cuts over.

## Out of scope

- Any real pac-host feature surface (mesh nodes, recorder, commands) — future tasks, once `enrichOutbound()`'s internal stub is replaced.
- SSE (`GET /v1/events`) consumption — not needed for a health-poll-only capability flag; deferred to whichever future task actually needs live pac-host events.
- Browser-side rendering of `pac_host_status` or `node.pac_host` — Domain 2, separate task, per the two-domain rule.
