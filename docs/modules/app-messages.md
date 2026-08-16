---
module: app-messages
source: public/app-messages.js
source_hash: 41c1b6108bd5e4840e23f2148a2c4437c1b62042bf4847b09264a34a4d95c215
updated: 2026-08-16
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
- **The browser NEVER chooses a channel** (task `send-form-default-channel`,
  2026-08-16). `msgChannel` starts `null` and is filled from the served
  `device_list.default_channel`. Peter: *"browser is a presentation layer only. it
  does not calculate or make decisions."*
- **A channel selection belongs to the radio it was made on.** `msgChannelFor`
  records which. When the radio changes, the selection is re-taken from the served
  default rather than kept.

## Why "does the index exist" is the wrong test

The original guard asked whether the selected index existed on the newly chosen
radio and kept it if so. **Caught live 2026-08-16:** select Private on the YAGI
(index 1), switch to the OMNI, and the form stays on index 1 — which on the OMNI
is `mqtt`, an **unencrypted** channel. The index existed, so the check passed, and
a message intended for the private channel would have gone out in clear.

My first version of this fix repeated the same mistake, and it was caught the same
way — by switching radios in a real browser and reading what the form then held.

An index is not an identity. The same number is a different channel on a different
radio, so the only sound question is *which radio was this chosen for*.

## `Number(null)` is `0`, and `0` is the public mesh

`sendMessage()` refuses when the channel is unresolved rather than coercing.
Coercing would have re-introduced the exact defect: `Number(null) === 0`, and 0 is
a PRIMARY. The backend enforces the same rule in `sendMeshText` — a channel is
stated or the send does not happen.
