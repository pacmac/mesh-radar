---
module: mesh-send
source: src/mesh-send.js
source_hash: 8bc7cdfe565c46665ffa5348e9257aaaaa85f2c02b0197b0503f7809875f3c5c
updated: 2026-07-23
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
