---
module: mesh-send
source: src/mesh-send.js
source_hash: 1d049676f59b57b6c98cdd2fde3e7231c1c07408cbe68a488f18165cfe76f380
updated: 2026-10-11
---

# Module: mesh-send

## Purpose

Single standard path for transmitting a Meshtastic text message and recording
the successful outbound packet in dashboard history.

## Public interface

```js
sendMeshText({
  gatewayNodeId,
  text,
  channel,
  to = null,
  reply_id = null,
  category = null,
})
```

The function posts to the selected gateway radio. A failed upstream request is
not recorded. A successful response with a packet ID is written with a stable
`t-<id>` message key and then broadcast through authoritative message history.

## Invariants

- One transmit-and-record path.
- Failed transmissions create no history row.
- Device identity uses the dashboard's MAC vocabulary.
- Later reception of the same packet collapses by packet ID.
- **A CHANNEL MUST BE STATED, as one of exactly two words. `sendMeshText`
  throws when it is not.** Superseded by `docs/modules/channels.md`'s
  2026-09-03 rewrite — see below; this doc's older integer-channel language
  was left stale until 2026-10-11.

## A send that does not name its channel is refused

This used to be `channel ?? 0` in the recording, and `const body = { text,
channel }` on the wire. `JSON.stringify` **drops an undefined key**, so a caller
who forgot the channel sent a body with no channel at all, and the gateway
applied its own default of `0`.

`0` is a PRIMARY — the public mesh. So the failure mode was: forget an argument,
broadcast to strangers. Silently, with a `t-<id>` row recording it as a normal
send.

**Superseded, 2026-09-03 (`docs/modules/channels.md`):** `channel` is no longer
an integer at all. Peter: *"you need to know nothing about channels, channel
indexes, PSKs, PKI, all you need to know is public and private."*
`sendMeshText` now requires `channel` to be exactly `'public'` or `'private'`
and throws otherwise — `channels.js`'s `indexFor` resolver this section
originally described was deleted outright. The gateway resolves the word
against the radio addressed.

## `channel_role` (2026-10-11)

`recordOutbound` now also writes `channel_role: channel` — the same word,
under the consistently-typed column `messages.channel_role` adds for both
send directions. See `docs/modules/channels.md`'s "`messages.channel_role`
added" section; idiot entry
`outbound-rows-store-a-channel-word-inbound-store-an-index`.

## `x-mesh-gw-key` (2026-10-11)

`sendMeshText`'s own `fetch()` now attaches `x-mesh-gw-key` (from
`mesh_gw.send_key`), matching the fix already made in `bridge.js` for
mesh-gw's `send_auth` gate (2026-08-23; broadened 2026-09-11). This function
does its own raw `fetch()` rather than routing through `bridge.js`, so it
never inherited that fix until now.
