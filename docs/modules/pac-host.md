---
module: pac-host
source: src/pac-host.js
source_hash: efb5e973138e39e49126adba60066d455658b00a0b5c9af44780d7011997d23a
updated: 2026-08-01
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
- Fetch pac-host's unit roster (`GET /v1/mesh/devices`, task
  `control-devices-endpoint`, 2026-07-25 — supersedes the earlier
  `GET /v1/mesh/nodes` + `user.role === 200` filter) in the same poll cycle as
  health, when available, and include it as `units` in `connectMessage()`.
  This is the *only* legitimate node-list-shaped data this module carries —
  it answers "which units can I command", a pac-host-owned fact, not "what
  are this node's stats" (ruled out entirely, see Purpose). `/mesh/devices`
  is **already scoped to our alarm devices only** (mt-transport, xsession
  `[devices-live]`) — no downstream filter needed anywhere, unlike the old
  `/mesh/nodes` roster which was pac-host's whole mesh-gw-observed view.
  Includes `present: false` units (declared but not currently in the gateway
  roster, e.g. asleep since pac-host's last restart) — callers must render
  these, never drop them.
- Keep the antenna-alignment view-model fresh by polling `GET /v1/mesh/align`
  on its own cadence (`ALIGN_POLL_MS`, 2s — faster than the queue poll, since
  burst progress over a ~30s burst should feel live) and push it over WS
  (task `yagi-align-rebuild`, 2026-07-25). Also runs the **PASV interlock**:
  watches the pushed model's `running` field and forces dash mode to PASV
  for the session's duration, restoring the prior mode on stop — mt-transport
  no longer drives our rotator at all and explicitly flagged this as ours
  alone to replicate ("If the Yagi moves during a burst, the readings are
  silently wrong rather than obviously broken, which is the worst kind of
  wrong"). See the dedicated section below.

## Dependencies

- `log.js` — `log.info/warn/debug('pac-host', ...)`, matching the tag
  convention `bridge.js`/archived `transport-plugin.js` use.
- Global `fetch` (Node 18+, already relied on by `bridge.js` — no new
  dependency).
- `dash-mode.js` — `dashMode.value`/`dashMode.set()`, for the align PASV
  interlock only (task `yagi-align-rebuild`, 2026-07-25). No circular import:
  `dash-mode.js`'s own dependencies (`db.js`, `device-config.js`) do not
  import `pac-host.js`.

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
export async function getImagesProgress(unit)            // → GET /v1/mesh/images/:target/progress, returns { target, transfers: [...] }. LOCAL read of pac-host's own memory — synchronous, measured 1.2 ms — so it is safe on a poll path. `transfers: []` means IDLE, not unknown. Called only by the alarm-images plugin.
export function alignMessage()                           // → { type: 'pac_host_align', model } — ready to JSON.stringify and send as-is
export async function alignPing({ target, n })            // → POST /v1/mesh/align/ping body, returns the raw JSON response; throws (incl. 409 if a burst is already active)
export async function alignStop()                         // → POST /v1/mesh/align/stop, returns the raw JSON response
export async function alignConfig({ replyWindowSec })     // → POST /v1/mesh/align/config body, returns the raw JSON response
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
  units: [{ id, num, name, shortName, label, source, present, mode, awake, slp,
             lastHeard, lastHeardMs, fw, position, hops, rssi, snr }] | [],
  // GET /v1/mesh/devices — our alarm devices only, empty when unavailable
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
- `src/pac-align-api.js` (task `yagi-align-rebuild`, 2026-07-25) — thin Express router, `POST /align/ping|stop|config`, calling `alignPing()`/`alignStop()`/`alignConfig()`. **No GET route**, same reasoning.
- `public/app.js`/`public/app-ws.js`/`public/index.html` (task `pac-host-header-badge`) — render `pac_host_status` as a small navbar badge.
- `public/app-control.js`/`public/partials/tab-control.html` (tasks `pac-host-command-surface`, `control-queue-push-not-get`) — Control page reads `pacHostQueues` (from `pac_host_queues`) as pure pushed state; zero fetch anywhere in that file.
- `public/app-align.js`/`public/partials/tab-control.html` (task `yagi-align-rebuild`) — Yagi Align sub-tab reads `alignModel` (from `pac_host_align`) as pure pushed state.

## Relative "since" display (task `control-since-and-pending-split`, 2026-07-25)

Each ledger entry gains a `since` field (`"5m ago"` etc.) computed by
`_pollQueues()` via `fmtAgo()` (`format.js`) every poll cycle, before push.
Replaces an earlier browser-side `YYMMDD-HHMMSS` absolute stamp —
BROWSER_CONTRACT requires relative-time values be server-formatted and
re-pushed on change, not recomputed client-side with a timer. Deliberately
reuses the existing 5s queue-poll cadence rather than adding a new
per-connection 1s timer (unlike `node_status_age` in `ws-relay.js`): queue
data doesn't need second-level precision, and `since`'s bucket (s/m/h/d)
changing is itself a real content change that already flows through the
existing `queuesChanged` diff/emit.

**Source field depends on settlement (task `settled-age-wrong-timestamp`,
2026-07-25 — mt-transport chat report, mcpp-chat
`mt-transport--node-dash`#25).** A live row (`state` is `queued`/`trying`)
ages from `entry.createdAt` — how long it has been waiting, the useful
number for something not yet settled. A settled row (`done`/`failed`/
`expired`) ages from `entry.settledAt` instead — when it actually finished
— falling back to `createdAt` only if `settledAt` is absent. Before this
fix every row used `createdAt` unconditionally, so a settled command that
waited a long time for a reply (normal for a sleeping unit — mt-transport's
own `nextTryAt`/wake-window semantics, above) showed its reply as having
landed the moment it was queued. `settledAt` is a genuinely new field on
mt-transport's ledger, confirmed present on live data as of tonight.

## Ledger field rename (task `ledger-field-rename`, 2026-07-25)

mt-transport shipped a full command-ledger rewrite (commit `975449e`,
xsession `[request-ledger]`) with no old-shape fallback — every field
renamed, live, the moment it landed. `_pollQueues()` reads `entry.createdAt`
(was `enqueuedAt`) to compute `since`; every other field rename
(`status`→`state`, `attempts`/`maxAttempts`→`tries`/`maxTries`,
`receipt`→`result`, `lastError` string→`error` `{code,message}` object, plus
new `kind: 'command'|'text'`) passes through this module untouched — it's
opaque here, only `app-control.js`/`tab-control.html` (Domain 2) interpret
those fields. Peter caught the resulting breakage independently
("now it only shows 1 line, the command") before this fix landed; root
cause was confirmed via the live raw API (`status`/`enqueuedAt` were `null`
on every entry) before responding to him.

**A generic key-value receipt display was ALSO discussed with mt-transport
for `receipt`/`result` field labels (xsession `[receipt-schema]`) — that
remains unresolved and unrelated to this rename**: the labels question is
about human-readable field names, this fix is about which field holds the
data at all.

## Antenna alignment + PASV interlock (task `yagi-align-rebuild`, 2026-07-25)

`_pollAlign()` polls `GET /v1/mesh/align` every `ALIGN_POLL_MS` (2s) and
pushes `pac_host_align` on change, the same poll-and-push shape as
`_pollQueues()`. SSE (`mesh.align`) is live on pac-host's side but not
consumed here — same deferral as the command ledger's SSE swap, a separate
follow-up task, not bundled with this one.

**PASV interlock**: the archived `src/align-api.js` forced `dashMode.set(0)`
for a session's duration and restored the previous mode on stop, so the
Yagi would not auto-swing mid-burst. mt-transport's align module does not
drive our rotator ("we do NOT drive the rotator, deliberately... If pointing
is to be automated later it must talk to the hardware directly") and
explicitly named this as node-dash's sole responsibility to replicate.
Reproduced here by watching `_alignModel.running`'s transition (the only
signal available now — pac-host owns the session, not us):

- `false → true`: `_alignPrevMode = dashMode.value; dashMode.set(0)`.
- `true → false`: `dashMode.set(_alignPrevMode); _alignPrevMode = null`.
- Guarded on `_alignPrevMode == null` so a poll tick can't double-save/
  double-restore.

**Known limitation, same class as the archived bugs-backlog item #29** (align
session PASV-forced-forever on a mid-session process restart): `_alignPrevMode`
lives only in memory. If node-dash restarts while a session it force-PASV'd
is still running, the saved prior mode is lost — the persisted dash-mode
value already reads PASV (that part survives, since `dashMode.set()`
persists to `db.js`), but there is no way to know what to restore to when
the session eventually ends. Not solved here; accepted as a narrow,
pre-existing-class edge case rather than expanding this task's scope to fix
session-restart durability.

## State

- `_timer` — the health/roster poll interval handle.
- `_queueTimer` — the queue poll interval handle, separate cadence (5s vs 30s).
- `_alignTimer` — the align poll interval handle, separate cadence again (2s).
- `_lastStatus` — cached `status()` result, compared each poll to decide whether to emit `change`.
- `_queues` — `{[unitNum]: entries[]}`, compared each queue poll to decide whether to emit `queuesChanged`. On a transient per-unit fetch error, keeps that unit's last-known entries rather than blanking it (a momentary pac-host hiccup should not flash the Control page empty).
- `_alignModel` — last pushed align view-model, compared each poll to decide whether to emit `alignChanged`. `null` until the first successful poll.
- `_alignPrevMode` — dash mode saved when the PASV interlock engaged; `null` when not currently holding it.

## Events emitted

- `change` — fired when `status()`'s shape changes (state transition, `modules`, or `units` list). Not fired on every poll if nothing changed.
- `queuesChanged` — fired when any commandable unit's queue ledger changes. Separate from `change` deliberately (see Dependents).
- `alignChanged` — fired when the align view-model changes. Separate again, same reasoning — a 2s align tick must not force-resend the larger status/queue payloads.

## Invariants

- Never throws on an unreachable host — a connection failure resolves to `status: 'unreachable'`, not a rejected promise a caller has to catch.
- Never blocks startup — `start()` fires the first poll asynchronously; node-dash serves every page before the first poll resolves.
- `PAC_HOST_URL` follows house convention (`process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1'`), same shape as `BRIDGE_URL` — auto-probes by default, no separate on/off flag. Absence of a running service, not absence of config, is what disables the integration.
- **The queue ledger has no browser-facing GET, ever, anywhere.** `_pollQueues()` (polling `getQueue()`) is the only reader of pac-host's queue REST endpoint; the browser only ever receives `pac_host_queues` pushed over WS. A GET route for this existed for a few commits and was a real, reported bug — see `control-queue-push-not-get`. Do not reintroduce one; if a future page needs different query semantics (e.g. filtered/paginated), extend the push shape, don't add a fetch.
- Queue polling only runs `while isAvailable()` — no wasted requests when pac-host is down, and `_queues` is cleared (pushed as empty) rather than left stale when it goes unreachable.
- **Only `/images/<t>/progress` is safe on a poll path.** It is a local read of pac-host's own memory. The other image routes are not — see below.

## The image routes and what each one costs

`getImagesProgress()` is the only image call this module makes, and the only one
anything on a page path may make.

| route | cost | safe on a page path? |
|---|---|---|
| `/mesh/images/<t>/progress` | local, ~1.2 ms | **yes** — this module polls it |
| `/mesh/images/<t>/stored` | local, measured 1.8 ms | yes (added by services `160a4a1`, 2026-07-30; **not yet called from node-dash**) |
| `/mesh/images/<t>/<pid>` | local when cached, measured 3.3 ms; **radio otherwise** | only when cached |
| `/mesh/images/<t>/<pid>?refresh=1` | radio round-trip, minutes | **no** — costs a wake window |
| `/mesh/images/<t>` | radio round-trip | **no** |

The inline comment on `getImagesProgress()` predates services' `160a4a1` and
still says both non-progress image routes are radio round-trips. That was true
when written and is now only half true — `/<pid>` serves from disk when the bytes
are already held. **Correcting that comment and adding a `/stored` call belongs to
the Image-card task, not here**; it is recorded rather than silently fixed so the
next reader does not trust a stale claim.

## Test notes

- Functional check available now (pac-host not deployed): `PAC_HOST_URL` pointing at nothing running → `connectMessage()` reports `status: 'unreachable'` within one poll interval, `queuesMessage()` reports `{}`, node-dash boots and serves normally.
- Verified live 2026-07-25 against the real running pac-host service: `connectMessage()` reports `status: 'ready'`; `queuesMessage()` correctly returns both known units' real ledgers, keyed by node num, pushed on connect before any client interaction — confirmed via a raw WS script (bypassing the browser entirely) and via Playwright's network panel (zero requests fired on unit-click, confirming no fetch anywhere in the click path).
- Align + PASV interlock verified live 2026-07-25 against a real, already-running align session (not one this task opened): `_pollAlign()`'s very first tick logged `align session started, forced PASV (was 0)`, confirming the interlock engaged correctly on observing `running:true`. `alignMessage()` correctly returned the live model via a raw WS script. A real `/align/ping` against BNCH opened a burst (`burst.active:true`, confirmed via the raw API mid-burst), which resolved to `warning:"No replies — try again."` after the burst window — expected, not a bug (see `docs/modules/app-align.md`). Session-end/PASV-restore was **not** exercised (the live session tested against was not this task's to stop) — restore-path logic is verified by code review only.

### `unitForNum(num)` / `unitNums()` — task `node-page-reachability`, 2026-07-29

Read-only views of `_units`, the LAST POLL's roster. Never a fetch, so a caller
on a request path (`node-status.js`'s Reachability section) costs nothing and
cannot block. Staleness is bounded by `HEALTH_POLL_MS`.

`unitNums()` exists so `ws-relay` can hint `node_status` for every unit when the
`change` event fires. Before that, `_hintNodeStatus` was driven **only** by
mesh-gw packet events, so a pac-host unit's reachability facts would have
refreshed exactly when a packet arrived — i.e. when the unit is reachable — and
frozen while it was silent. Measured: with the hint removed, a sleeping GARG
received **0** `node_status_update` in 68 s; with it, 2, exactly 30 s apart.

Measured while verifying this: `change` now fires on **essentially every 30 s
poll**, because services' per-fact `<field>At` siblings advance whenever a packet
is heard. The 1 s per-node throttle in `_hintNodeStatus` absorbs it. Recorded in
the `bugs` ledger (step 42) as a thing to watch, not a fault found.

## Out of scope

- Node data of any kind — see Purpose. Not staged for later; ruled out by design.
  **`unitForNum`/`unitNums` do not breach this**: they hand back pac-host's own
  unit objects unchanged. This module still interprets nothing and formats
  nothing; `node-status.js` owns the reading of those fields.
- Verb validation, argument shaping, or any mesh-mechanics knowledge for commands — `queueCommand()` is a pure passthrough; pac-host owns what a verb means.
- SSE (`GET /v1/events`) consumption. The queue-poll interval (5s) is the "real time" mechanism for now — a genuine future upgrade would subscribe to the now-live `mesh.request-queued/-trying/-done/-sent/-failed/-expired/-cancelled` events (xsession `[request-ledger]`, 2026-07-25) for sub-poll-interval latency and zero polling overhead, but polling backend-side (never browser-side) already satisfies the actual architectural requirement: the browser reacts to pushed state and never fetches. Explicitly deferred to a separate follow-up task (Peter, 2026-07-25) rather than bundled with the urgent field-rename fix. Same deferral applies to `mesh.align`.
- Rotator hardware control of any kind, beyond the PASV interlock's mode
  switch — mt-transport does not drive it and neither does this module;
  the operator turns the antenna by hand.
