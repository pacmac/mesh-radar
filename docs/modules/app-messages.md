---
module: app-messages
source: public/app-messages.js
source_hash: 25de8091fb0331bfb01e87f06665dbc9780e660cc05e4bebe467a84269c29e55
updated: 2026-07-23
---

# Module: app-messages

## Purpose

Browser messaging mixin. It maps the server-pushed `message_history`, renders it
without classification, and handles user composition and sending.

## Public interface

```js
_mapMessageRows(rows)
_applyMessageRows(rows)
displayMessages()
sendMessage()
```

History arrives over WebSocket. The browser does not fetch, sort, thread,
classify, or filter message types. Sending uses the selected gateway and channel
through the standard messages endpoint; successful history comes back from the
server's authoritative feed.

## Invariants

- No optimistic transmitted row.
- Server-provided message identity and thread fields are retained.
- `displayMessages()` preserves server order.
- User compose state may be local; message truth remains server-owned.
