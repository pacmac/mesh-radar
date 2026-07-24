---
module: app-messages
source: public/app-messages.js
source_hash: c1bbe560f59df71d23dd1b04bd78541955832cbe79068b0bba9bef1fc80d357b
updated: 2026-07-24
---

# Module: app-messages

## Purpose

Browser messaging mixin. It maps the server-pushed `message_history`, applies
the viewer-selected feed filter without reordering rows, and handles user
composition and sending.

## Public interface

```js
_mapMessageRows(rows)
_applyMessageRows(rows)
loadMessages()
msgFromChannels()
displayMessages()
sendMessage()
```

History arrives over WebSocket; `loadMessages()` is deliberately a no-op. The
browser does not fetch, sort or thread history. `_mapMessageRows` retains the
server-supplied identity/thread fields and maps the server facts needed by the
four viewer filters:

| `msgFilter` | Visible rows |
|---|---|
| `all` | all rows |
| `bcast` | broadcast rows |
| `dir` | direct rows |
| `chat` | primary-channel broadcast rows |

`displayMessages()` filters the existing ordered array only. It does not mutate
message truth or persist a server setting. Sending uses the selected gateway
and configured channel through POST; successful history returns through the
authoritative WebSocket feed.

## Invariants

- No optimistic transmitted row.
- Server-provided message identity and thread fields are retained.
- `displayMessages()` preserves relative server order within every filtered view.
- Filter selection is viewer-local presentation state.
- User compose state may be local; message truth remains server-owned.
