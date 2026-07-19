---
module: transport-adapter
source: src/transport-adapter.js
source_hash: fe4520a789f3cb07a535a6b11f122b262886a66133a75095ea9cb348fbf46711
updated: 2026-07-19
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
**positional** `fetch(target, pid, {timeoutMs, batch})`. The real ctor refuses
channel 0 and an unset channel; both confirmed.

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
