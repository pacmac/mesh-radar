---
module: transport-plugin
source: src/transport-plugin.js
source_hash: 318dba9e350ca7ccb53ec5952b0a31dce8dcaf1d9633fb0b46c7ba4a69abedc4
updated: 2026-07-19
---

# Module: transport-plugin

## Purpose

The single seam between node-dash and everything the PAC alarm carries that
**stock Meshtastic does not** — portnums 256/260/261, the `@<target> <verb>`
text-command grammar, chunked binary transfer, and pull/dequeue messaging.

Node-dash core knows none of that. It asks this module what is available and
calls through it. The implementation lives in a separate repo
(`mt-transport/clients/node`) and is **optional at runtime**.

This module is the *interface and loader*. It is not the protocol implementation
and must never grow protocol knowledge — a portnum literal appearing in this file
is a bug.

## Responsibilities

- Locate and load a transport implementation at boot, if one is installed
- Publish a stable capability set describing what the loaded implementation can do
- Provide a null-object fallback so an absent implementation is a normal state,
  never an exception at the call site
- Normalise implementation errors into a single documented result shape
- Own nothing else: no HTTP, no SQLite, no WebSocket, no rendering

## Dependencies

- `log.js` — load outcome is logged once at boot, at info (found) or debug (absent)
- Node builtins only otherwise. **No import of the implementation at module scope**
  — it is resolved dynamically so a missing implementation cannot break startup.

## Public interface

```js
export async function loadTransport()      // → Transport   (idempotent; caches)
export function transport()                // → Transport   (throws if called pre-load)
export const CAPABILITIES                   // → readonly string[]
```

### `Transport`

```js
{
  available: boolean,          // false ⇒ null-object fallback is in use
  source:    string|null,      // resolved path, or null when absent
  can(cap):  boolean,          // cap ∈ CAPABILITIES
  // capability methods — each present only when can(cap) is true
}
```

### `CAPABILITIES`

| capability | covers | node-dash surface today |
|---|---|---|
| `configSet`  | validate + send a setting, confirm by device reply | `node-settings.js`, `settings-api.js` |
| `debug260`   | portnum 260 JSON: debug, config broadcast | `persist.js:152`, `node-status.js` |
| `tilt256`    | portnum 256 tilt decode | `ws-relay.js:497` |
| `chunkFetch` | portnum 261 chunked transfer (JPEG etc) | none — net-new |
| `pullQueue`  | store-and-forward messages the alarm dequeues | none — net-new |

Capability names are the contract. Callers branch on `can(cap)`, never on
`typeof fn === 'function'` and never on try/catch.

### Result shape

Every capability method resolves to:

```js
{ ok: true,  state: 'applied',  value: <result> }
{ ok: false, state: 'unavailable'|'invalid'|'rejected'|'no_reply'|'error', error: string }
```

The vocabulary is `node-settings.js`'s existing one (`applied | rejected |
no_reply | invalid`) verbatim, so `settings-api.js`'s 400/409/504 mapping carries
over unchanged. `unavailable` is the single addition and is **reserved**: only the
null object returns it.

Anything the implementation throws is normalised to `state:'error'` — it is
another repo's code and may throw, reject, or return a bare value; callers should
not have to care. A result already carrying `ok` is passed through untouched.

## State

Module-level singleton holding the resolved implementation and its capability
set. Populated once by `loadTransport()`; `transport()` reads it.

Deliberately module-scope and **not** exported as a mutable binding — see
`app-node-status.js`, where Chart instances stored on reactive state got wrapped
in a Proxy and broke. Same lesson: singletons that hold live objects stay in
module scope.

## Events emitted

_N/A_ — this module does not emit. Implementations that produce a stream (260
debug, chunk progress) expose it via a capability method returning an
`AsyncIterable`; broadcasting to the browser stays `ws-relay.js`'s job.

## Invariants

- **Absent implementation is not an error.** `loadTransport()` resolves; it never
  rejects for absence. Boot must succeed on a machine with no alarm nodes.
- **No protocol knowledge here.** No portnum literals, no command grammar, no
  wire formats. Those live in the implementation.
- `loadTransport()` is idempotent — repeat calls return the cached instance.
- A capability method is present **iff** `can(cap)` is true. No half-present methods.
- Resolution order: `MT_TRANSPORT_PATH` env → `node_modules/mt-transport` → absent.
  Matches how `bridge.js` and `rotator.js` take endpoints (env-driven, per
  `rotator-targets-no-hardcoded-ip`).
- **Never sends on the primary channel.** Any capability that transmits resolves
  its channel through the existing `resolveCommandChannel()`, which refuses
  channel 0 by construction. `channel` is always set explicitly — it defaults to 0.

## Test notes

- **absent**: with `MT_TRANSPORT_PATH` unset and no `node_modules/mt-transport`,
  `loadTransport()` resolves, `available === false`, every `can()` is false, and
  every capability method returns `{ok:false, state:'unavailable'}`
- **present**: pointed at a stub exporting a subset of capabilities, `can()` is
  true for exactly that subset and false for the rest
- **broken implementation**: a path that exists but throws on import → resolves to
  the null object with `available === false`, logs once, does not throw
- **idempotent**: two `loadTransport()` calls return the same object identity
- **pre-load**: `transport()` before `loadTransport()` throws — a programming
  error, distinct from absence
- **no protocol leakage**: with comments stripped, no portnum literal appears in
  executable code —
  `sed 's://.*::' src/transport-plugin.js | grep -E '\b(256|260|261)\b'`
  returns nothing. The capability *names* `debug260`/`tilt256` do contain the
  number; they are identifiers, not protocol knowledge, and the naive grep over
  the whole file will match them plus the header comment. Strip comments first.

**Verification status 2026-07-19 — all paths covered.**

`tests/test_transport_plugin.mjs` — 5 tests, all passing:
absent, present (exact capability subset), result pass-through, a throwing
capability normalising to `state:'error'`, and broken-on-import degrading to the
null object without throwing.

Fixtures: `tests/fixtures/transport-good.mjs` (partial implementation — exports
three capabilities, one of which throws) and `tests/fixtures/transport-broken.mjs`
(throws at import).

Also checked ad hoc: idempotency, `transport()` identity, pre-load throw, and the
leakage check.

Note this is the repo's first **JS** test — `tests/` is otherwise Python
integration tests against a live service. A JS unit test is used here because the
subject is a JS module contract, and the present/broken paths cannot be reached
from Python. Run it directly: `node tests/test_transport_plugin.mjs`.

## Out of scope

- The protocol itself — `mt-transport/clients/node` owns it (other repo, read-only here)
- HTTP routing — `settings-api.js` and friends keep their routes
- Browser delivery — `ws-relay.js`
- Storage — `db.js`; image bytes go to disk via the implementation's `store.js`
- Image retention policy — unowned, see `docs/DECISIONS-alarm-transport.md` D5
- Modifying mesh-gw to add raw-portnum send — live service, explicitly excluded (D3)

## PULL PURGED — push is the only bulk-transfer path (2026-07-20)

Peter: *"purge it."* `chunkFetch` / `Client.fetch` is **removed entirely** — from the
adapter, from the `CAPABILITIES` allow-list, from the route, and from the tests. It is not
a fallback and must not be reintroduced as one.

**Why it went rather than being kept for compatibility.** Pull's follow-up requests were
the failure: a real transfer here stalled at exactly 16/32 because the device never
received the pull for `first=16` (`stalled at 16/32 after 12 empty windows (no serve, no
busy)`, evidence preserved under `data/payload-evidence/`). Keeping a path that is known
to strand transfers, as a silent fallback, would mean the worst case is chosen precisely
when the good path is unavailable.

**A build without `Client.push` now FAILS LOUDLY** (`no Client.push — pull is no longer
supported`) instead of quietly degrading. There is a test for exactly that.

**The field unit** `!987ab80f` runs `mt-chunk` (pull) and cannot be reflashed — but it is
off-limits to node-dash entirely, so we would never have driven a transfer to it. The
pull path was dead by policy before it was dead by protocol.

Live capability line after the purge:

    capabilities: debug260, chunkPush

Also gone with it: `batch`, and every `MSG_BUSY (0x06)` reference describing pacing as
current — under push the device paces itself and that frame does not exist.
