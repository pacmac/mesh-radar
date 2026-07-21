---
module: transport-adapter
source: src/transport-adapter.js
source_hash: 09729964ef60d59dd4072004f0e9d9deb20c7491d01ea94609618c2288f02b77
updated: 2026-07-20
---

# Module: transport-adapter

## Purpose

Maps the `mt-transport` module's public facade onto node-dash's capability names.

Two vocabularies exist and neither should bend to the other: mt-transport exports
`{ Client, chunk, cmd, target, parse260, … }`; node-dash asks for
`{ configSet, debug260, tilt256, chunkFetch, pullQueue }`. This file is the only
place that knows both.

It exists so `transport-plugin.js` can stay protocol-free. That module's spec
states a portnum literal in it is a bug — the mapping had to go *somewhere*, and
adapting a dependency's surface is the consumer's job, not the loader's.

## Responsibilities

- Translate mt-transport's facade into capability functions
- Advertise a capability **only** when the module can actually serve it
- Enforce the never-PRIMARY channel rule at the call site
- Own the Client cache (see State); no HTTP or storage of its own

## Dependencies

- None. No imports. Holds a module-level client cache (see State) but does no I/O
  itself — the cached `Client` owns the socket.

## Public interface

```js
export function adaptMtTransport(m)      // → { [capability]: fn }  (absent key = absent capability)
export function looksLikeMtTransport(m)  // → boolean
```

`looksLikeMtTransport` lets the loader distinguish "wrong module entirely" from
"right module, older version than expected" — the two deserve different log lines.

## What is and is not adapted

| capability | adapted? | why |
|---|---|---|
| `debug260`   | yes — via `parse260` | pure function, no radio, documented stable |
| `chunkFetch` | yes — via `Client.fetch()` | `Client` is the layer mt-transport keeps stable (Q&A Q3) |
| `configSet`  | **no** | node-dash owns it. The text-command path in `node-settings.js` is the implementation, not a workaround — confirmed Q&A Q6 |
| `tilt256`    | **no** | portnum 256 is decoded in `ws-relay.js`; the module does not expose it |
| `pullQueue`  | **no** | not designed on either side; the device half does not exist (Q&A Q1). Name reserved only |

Measured against the real module 2026-07-19: capabilities on = `debug260`,
`chunkFetch`; off = `configSet`, `tilt256`, `pullQueue`. That is the intended set,
not a shortfall.

## State

**A module-level `Map` of cached `Client` instances, keyed
`host|gatewayId|channel`.** Populated lazily on first `chunkFetch`, disposed by
`closeClients()`.

Not constructed at adapt time: a `Client` needs a channel, and the channel is
per-call runtime config resolved from the gateway's own channel list.
Constructing eagerly would either guess one or capture a stale one.

Cached rather than per-call because a `Client` owns a WebSocket — one per fetch
would leak sockets and re-trigger the gateway's multi-MB opening snapshot each
time. Keyed rather than a singleton because the transmitting radio can change at
runtime (mode roles own which device is TX), and fetching through the wrong
gateway returns a wrong answer rather than an error.

The cached entry holds `{client, ready}` where `ready` is the in-flight
`connect()` promise, so concurrent first-fetches await the same connect instead of
racing two of them.

## Events emitted

_N/A_

## Invariants

- **Never PRIMARY.** `assertChannel()` throws on an unset channel and on 0.
  Duplicated deliberately: mt-transport's `Client` guards this too (Q&A Q7), but
  transmitting on the public mesh cannot be undone, so both sides check.
- The *unset* channel is as dangerous as 0, because `channel` defaults to 0
  throughout the Meshtastic API. Absent and zero are both rejected.
- An absent key means an absent capability. Never return a stub that resolves
  successfully without doing anything.
- No `Client` construction at adapt time — only on first `chunkFetch`.
- One `Client` per `(host, gatewayId, channel)`; never one per fetch.
- **No client-side pacing. The device owns the pace.** As of the async firmware
  (`chunk-flow-control`, 2026-07-20) the device drives flow control via a
  `MSG_BUSY` (0x06) frame — "not ready, retry after N ms" — which `Client.fetch`
  obeys internally. mt-transport's explicit design instruction: node-dash must add
  **no** batch/interval heuristics; `chunkFetch` is a thin wrapper. So the adapter
  **imposes no `batch` default** — it passes `batch` through only when the caller
  supplies one, and otherwise lets `Client.fetch` use its own (device-derived)
  default. The old `batch:4` default is gone: it was a workaround for the pre-async
  blocking cadence (16 never completed in a 35 s deaf window), which no longer
  exists. `MSG_BUSY` needs no node-dash change — node-dash decodes no 261 frames.
- **Progress + deadline pass straight through.** `chunkFetch` forwards
  `onProgress({received,count,batch,elapsedMs})` and `deadlineMs` to `Client.fetch`
  untouched when given. The adapter neither fires progress nor enforces the
  deadline itself — the client owns both; the adapter only relays. `deadlineMs`
  replaces the old `timeoutMs` opt.
- **`payloadDir` passes to the `Client` constructor.** When `chunkFetch` is given a
  `payloadDir`, `getClient` forwards it to `new Client({host, gatewayId, channel,
  payloadDir})` so node-dash owns where images are stored, instead of the
  `Client`'s cwd-relative `./payloads` default. Constant per deployment, so it is
  not part of the client cache key.

## Test notes

- `adaptMtTransport({})` → `{}` (nothing exported ⇒ nothing advertised)
- module exporting only `parse260` → `debug260` present, `chunkFetch` absent
- module exporting `Client` → `chunkFetch` present
- `chunkFetch` with `channel: 0` rejects; with channel omitted rejects; with
  channel 2 proceeds
- `looksLikeMtTransport` true for either `Client` or `parse260`, false for `{}`
- integration, measured 2026-07-19: real module ⇒ exactly
  `['debug260','chunkFetch']`

**Verified 2026-07-19 — `tests/test_transport_adapter.mjs`.**
10 passed with the module absent (the integration case skips cleanly, so the suite
stays green on a box with only stock Meshtastic); 11 passed with
`MT_TRANSPORT_PATH` set against the real module.

`chunkFetch` uses mt-transport's REAL `Client` contract, verified against
`index.js:21-66,128` and re-checked by constructing a real `Client` (construction
only — no `connect()`, no socket, no transmit):
`new Client({host, gatewayId, channel})`, `await connect()`, then
**positional** `fetch(target, pid, {deadlineMs, batch, onProgress})` (the stable
signature mt-transport committed 2026-07-20; `onProgress`/`deadlineMs` added,
`timeoutMs` retired). The real ctor refuses channel 0 and an unset channel; both
confirmed.

Test note update (2026-07-20): the former "defaults batch to 4" test becomes
"imposes no batch default" — `chunkFetch` with no `batch` must forward opts with
`batch` **absent**, letting the client's device-derived default apply. The
explicit-override test stays. New: `onProgress`/`deadlineMs` are forwarded when
given.

An earlier version of this adapter assumed `{channel, gatewayNodeId, send}` and
`fetch({target, pid})` — wrong on every count — and every test passed because the
fake mirrored the wrong assumption. A fake that does not mirror the real contract
tests only itself. The fixture now mirrors it.

Clients are cached per `(host, gatewayId, channel)`: a `Client` owns a WebSocket,
so one per fetch would leak sockets and re-trigger the gateway's multi-MB opening
snapshot each time. Keyed rather than singleton because the transmitting radio can
change at runtime, and fetching through the wrong gateway is a silent wrong
answer. `closeClients()` disposes them.

The two channel-refusal tests are the ones that matter most: `channel: 0` and an
omitted channel both reject. Omission is tested separately and deliberately —
`channel` defaults to 0 across the Meshtastic API, so "forgot to pass one" and
"asked for PRIMARY" are the same failure.

## Out of scope

- Loading/resolution — `transport-plugin.js`
- The protocol — mt-transport (other repo, read-only here)
- Channel *resolution* — `node-settings.js:resolveCommandChannel()` owns picking
  the index; this module only refuses bad ones

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

## `pushAvailable` (2026-07-21)

`pushAvailable({target, channel, host, gatewayId})` → `{pid, state, chunks, crc, proto, fw,
badStarts, ready}` via one `push stat`. Safe BEFORE a transfer: the no-polling rule concerns
control traffic landing mid-stream (`upst=2`), which is exactly when nobody presses Start.
It reports what the device holds and never substitutes.
