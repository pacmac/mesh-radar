---
module: pac-host
source: src/pac-host.js
source_hash: 5a6458983de60f17329651974817cd634a2396a7b007d886fcd4e5a68c862881
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
- Forward a command to a pac-host unit (`POST /v1/mesh/queue`). Pure
  passthrough — no verb validation, no mesh mechanics, per mt-transport's
  explicit instruction that node-dash should not need to know any (xsession,
  `[ownership-2-correction]`, archived 2026-07-25).
- Keep every commandable unit's queue ledger fresh by polling
  `GET /v1/mesh/queue/:target` on its own faster interval (`QUEUE_POLL_MS`,
  5s — separate from the 30s health/roster poll) and push it over WS. This is
  backend-to-pac-host traffic, not browser-facing — the browser has **no**
  route to fetch this itself (fixed as a real bug, task
  `control-queue-push-not-get`, 2026-07-25: a GET route existed briefly and
  the Control page silently went stale between clicks — BROWSER_CONTRACT
  requires push, not on-demand fetch, regardless of how "interactive" the
  trigger looks).
- Fetch pac-host's unit roster (`GET /v1/mesh/nodes`) in the same poll cycle
  as health, when available, and include it as `units` in `connectMessage()`.
  This is the *only* legitimate node-list-shaped data this module carries —
  it answers "which units can I command", a pac-host-owned fact, not "what
  are this node's stats" (ruled out entirely, see Purpose). Note the roster
  is pac-host's **whole** mesh-gw-observed view, not just its own units —
  callers must filter (task `app-control.js` filters on `user.role === 200`,
  the PAC_ALARM firmware's own self-declared role).

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
export function queuesMessage()  // → { type: 'pac_host_queues', queues: {[unitNum]: entries[]} } — ready to JSON.stringify and send as-is; each entry carries a server-computed `since` (see below)
export const events              // EventEmitter, emits 'change' (status) and 'queuesChanged' (queue data) separately
export async function queueCommand({ unit, verb, args }) // → POST /v1/mesh/queue body, returns the raw JSON response ({id, ...}) or throws Error('pac-host <status>: <detail>')
export async function getQueue(unit)                     // → GET /v1/mesh/queue/:target, returns the raw ledger array; throws the same way. Called internally by the queue-poll loop; not used by any HTTP route (there is none) — kept exported in case a future task needs a one-off lookup, but nothing browser-facing may call it directly.
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
  units: [{ id, num, name, lastHeard, hops, raw }] | [], // pac-host's whole roster, empty when unavailable
  lastCheckedMs: number | null,
  error: string | null,     // set only when status === 'unreachable'
}
```

## Dependents

- `src/index.js` — imports and calls `start()` at boot, alongside `bridge.start()`.
- `src/ws-relay.js`:
  1. Import: `import * as pacHost from './pac-host.js';`
  2. On connect: `ws.send(JSON.stringify(pacHost.connectMessage()))` then `ws.send(JSON.stringify(pacHost.queuesMessage()))` — a newly-connected browser has full status AND queue data before it does anything at all.
  3. Two change-listeners near `broadcast()`'s definition: `pacHost.events.on('change', () => broadcast(pacHost.connectMessage()))` and `pacHost.events.on('queuesChanged', () => broadcast(pacHost.queuesMessage()))` — kept as separate events/broadcasts so a queue tick (every 5s while pac-host is up) doesn't force-resend the larger, rarer-changing status payload.
- `src/pac-command-api.js` (task `pac-host-command-surface`) — thin Express router, `POST /nodes/:num/pac-command` only, calling `queueCommand()`. **No GET route** — see Invariants.
- `public/app.js`/`public/app-ws.js`/`public/index.html` (task `pac-host-header-badge`) — render `pac_host_status` as a small navbar badge.
- `public/app-control.js`/`public/partials/tab-control.html` (tasks `pac-host-command-surface`, `control-queue-push-not-get`) — Control page reads `pacHostQueues` (from `pac_host_queues`) as pure pushed state; zero fetch anywhere in that file.

## Relative "since" display (task `control-since-and-pending-split`, 2026-07-25)

Each ledger entry gains a `since` field (`"5m ago"` etc.) computed by
`_pollQueues()` via `fmtAgo()` (`format.js`) from `entry.enqueuedAt` (epoch
ms → epoch seconds) every poll cycle, before push. Replaces an earlier
browser-side `YYMMDD-HHMMSS` absolute stamp — BROWSER_CONTRACT requires
relative-time values be server-formatted and re-pushed on change, not
recomputed client-side with a timer. Deliberately reuses the existing 5s
queue-poll cadence rather than adding a new per-connection 1s timer (unlike
`node_status_age` in `ws-relay.js`): queue data doesn't need second-level
precision, and `since`'s bucket (s/m/h/d) changing is itself a real content
change that already flows through the existing `queuesChanged` diff/emit.

## State

- `_timer` — the health/roster poll interval handle.
- `_queueTimer` — the queue poll interval handle, separate cadence (5s vs 30s).
- `_lastStatus` — cached `status()` result, compared each poll to decide whether to emit `change`.
- `_queues` — `{[unitNum]: entries[]}`, compared each queue poll to decide whether to emit `queuesChanged`. On a transient per-unit fetch error, keeps that unit's last-known entries rather than blanking it (a momentary pac-host hiccup should not flash the Control page empty).

## Events emitted

- `change` — fired when `status()`'s shape changes (state transition, `modules`, or `units` list). Not fired on every poll if nothing changed.
- `queuesChanged` — fired when any commandable unit's queue ledger changes. Separate from `change` deliberately (see Dependents).

## Invariants

- Never throws on an unreachable host — a connection failure resolves to `status: 'unreachable'`, not a rejected promise a caller has to catch.
- Never blocks startup — `start()` fires the first poll asynchronously; node-dash serves every page before the first poll resolves.
- `PAC_HOST_URL` follows house convention (`process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1'`), same shape as `BRIDGE_URL` — auto-probes by default, no separate on/off flag. Absence of a running service, not absence of config, is what disables the integration.
- **The queue ledger has no browser-facing GET, ever, anywhere.** `_pollQueues()` (polling `getQueue()`) is the only reader of pac-host's queue REST endpoint; the browser only ever receives `pac_host_queues` pushed over WS. A GET route for this existed for a few commits and was a real, reported bug — see `control-queue-push-not-get`. Do not reintroduce one; if a future page needs different query semantics (e.g. filtered/paginated), extend the push shape, don't add a fetch.
- Queue polling only runs `while isAvailable()` — no wasted requests when pac-host is down, and `_queues` is cleared (pushed as empty) rather than left stale when it goes unreachable.

## Test notes

- Functional check available now (pac-host not deployed): `PAC_HOST_URL` pointing at nothing running → `connectMessage()` reports `status: 'unreachable'` within one poll interval, `queuesMessage()` reports `{}`, node-dash boots and serves normally.
- Verified live 2026-07-25 against the real running pac-host service: `connectMessage()` reports `status: 'ready'`; `queuesMessage()` correctly returns both known units' real ledgers, keyed by node num, pushed on connect before any client interaction — confirmed via a raw WS script (bypassing the browser entirely) and via Playwright's network panel (zero requests fired on unit-click, confirming no fetch anywhere in the click path).

## Out of scope

- Node data of any kind — see Purpose. Not staged for later; ruled out by design.
- Verb validation, argument shaping, or any mesh-mechanics knowledge for commands — `queueCommand()` is a pure passthrough; pac-host owns what a verb means.
- SSE (`GET /v1/events`) consumption. The queue-poll interval (5s) is the "real time" mechanism for now — a genuine future upgrade would subscribe to `mesh.reply` for sub-poll-interval latency, but polling backend-side (never browser-side) already satisfies the actual architectural requirement: the browser reacts to pushed state and never fetches.
