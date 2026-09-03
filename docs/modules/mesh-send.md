---
module: mesh-send
source: src/mesh-send.js
source_hash: 250085818c0dcfa15742e4c67cfc325d1fe4ab9e861d7dc50db8dab05eb9f69c
updated: 2026-09-03
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
- **A CHANNEL MUST BE STATED. `sendMeshText` throws when it is not**
  (task `channel-callers-onto-resolver`, 2026-08-16).

## A send that does not name its channel is refused

This used to be `channel ?? 0` in the recording, and `const body = { text,
channel }` on the wire. `JSON.stringify` **drops an undefined key**, so a caller
who forgot the channel sent a body with no channel at all, and the gateway
applied its own default of `0`.

`0` is a PRIMARY — the public mesh. So the failure mode was: forget an argument,
broadcast to strangers. Silently, with a `t-<id>` row recording it as a normal
send.

`sendMeshText` now requires `channel` to be an integer and throws
`channel required` otherwise. It is the chokepoint every sender funnels through,
so this one guard covers callers that do not exist yet.

**It does not resolve the channel itself.** Deciding *which* channel is
`channels.js`'s job — `indexFor(radio, 'pub'|'pri')`. This module only refuses to
guess. Keeping the two apart is what lets the resolver's data source change
without touching the transmit path.

`0` remains perfectly legal when a caller **means** it: `callout.js` transmits
publicly on purpose. The rule is that it must be said, not that it must be
non-zero.
