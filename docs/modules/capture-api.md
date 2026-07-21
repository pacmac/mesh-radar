---
module: capture-api
source: src/capture-api.js
source_hash: 7d118686bfbb4d622e7c4026c248d035e41a7ab1665b72c062b62e36312d0a75
updated: 2026-07-21
---

# Module: capture-api

## Purpose

The dashboard's **capture trigger**: `POST /nodes/:num/capture` sends `cam grab` to a PAC
alarm, correlates the device's reply, and returns the fresh **pid** the device just
published — so the browser can then fetch that pid via the existing push path.

It is deliberately **thin** (mt-transport's steer): `cam grab` is an INTERIM, pre-PIR
primitive. When the PIR pipeline lands it gets a product verb set and this route rewires to
that — so the route does exactly grab→correlate→return-pid and nothing more. **It does not
push.** The image is fetched by the unchanged chunk-fetch path (`chunk-api.js`), which after
a grab sees the new pid via `pushAvailable`.

Domain 1 (backend). The browser "Take photo" button is a separate Domain-2 task.

## The verb (mt-transport, fw 260721-2, wire-verified)

```
send   @<4-hex-suffix> cam grab        (Private channel, resolved by name — same path as
                                        the command/settings/chunk verbs)
```

The reply threads by **`reply_id` = the packet id of the sent command** (verified: cmd
id 1457933836 → reply `reply_id:1457933836`). This is the SAME correlation the settings
verbs use — and DIFFERENT from push frames, which carry no reply_id and are matched by
sender (`notePushReply`). That asymmetry is real: grab replies come from the firmware's
`sendReply(reply, rx.id)` path; push frames from the push engine's own emit path.

### Three outcomes, all correlated by reply_id

| reply | meaning | action |
|---|---|---|
| `{"type":"grab","pid":N,"len":B,"n":C,"crc":"HEX8","cam":"asleep"}` | captured | return `{pid,len,n,crc}` |
| `{"type":"err","msg":"cam grab","st":S,"len":0,...}` | capture failed (no frame) | return `state:'capture_failed'`; **do not** offer a pid |
| (nothing within 10 s) | device silent / asleep | return `state:'no_reply'` |

`cam grab` is currently **intermittent on the bench** (mt-transport's I2C-vs-UART issue,
their side). Both `err` and `no_reply` are therefore treated as **normal, retryable**
outcomes — not errors to escalate. The `cam` field is purely informational (the camera
self-sleeps inside grab, on both paths); nothing is done with it.

## Why not reuse `node-settings.handleReply`

`handleReply` gates on `ok:true`: a `grab` success has no `ok` field, so it would resolve as
`state:'rejected'`. So capture uses its **own** reply-aware correlation (`_pendingGrab` +
`handleGrabReply`), keyed on the same `reply_id`, but classifying by `type` (`grab` vs
`err`) rather than `ok`.

## Public interface

```
POST /nodes/:num/capture        (no body)
```

| condition | status | body |
|---|---|---|
| captured | `200` | `{ok:true, state:'captured', pid, len, n, crc}` |
| device reported capture failure | `502` | `{ok:false, state:'capture_failed', error, st}` |
| no reply in 10 s | `504` | `{ok:false, state:'no_reply', error}` |
| bad `num` | `400` | `{error}` |
| no gateway radio | `503` | `{error}` |
| no Private channel resolvable | `409` | `{error}` |

```js
export default router;                          // POST /nodes/:num/capture
export function handleGrabReply(replyId, text); // dispatched from bridge-events
```

## Files changed

- **New:** `src/capture-api.js` — the route, `_pendingGrab` Map, `handleGrabReply`.
- **`src/bridge-events.js`** — one added dispatch: `handleGrabReply(pkt.decoded.reply_id, text)`
  in the reply block, alongside `handleReply` and `handleAlignPong`. Its own try/catch so a
  malformed grab reply cannot break settings or align correlation.
- **`src/index.js`** — import and mount `captureRouter` (like `chunkRouter`/`commandRouter`).

**NOT changed:** `chunk-api.js` (the push path is reused untouched — capture returns a pid,
the existing fetch pushes it); `node-settings.js` (its `handleReply`/`_pending` are for
settings and must not classify grab); `command-api.js` (fire-and-forget send, no await);
`public/*` (browser button is the separate task).

## Addressing + channel

Reused wholesale from the command path: `hexSuffix(num)` → `@<4-hex>`, and
`resolveCommandChannel(getDeviceChannelsByNodeId(gateway))` → the Private channel index,
refusing 0/PRIMARY. Never a body channel, never Primary.

## Invariants

- **Never PRIMARY** — same `resolveCommandChannel` guard as every other command.
- **Silence is not success** — a 10 s timeout returns `no_reply`, never a fabricated pid.
- **`err` never yields a pid** — a failed capture must not push a stale image as if fresh.
- **Does not push** — returns the pid; the browser fetches via the existing chunk-fetch path.
- **One dispatch, its own try/catch** — cannot break the adjacent reply consumers.

## Test notes

- Static: route mounted; `handleGrabReply` dispatched in bridge-events.
- Functional: DEFERRED where it needs a live grab reply (transmits + bench camera is
  intermittent). What can be shown without air: a bad `num` → 400; the reply classifier
  resolves `{"type":"grab",...}` → captured, `{"type":"err","msg":"cam grab"}` →
  capture_failed, unknown reply_id → ignored (returns false).
- Regression: settings `handleReply` still resolves its own replies (independent `_pending`
  map, unaffected).

## Out of scope

- The browser "Take photo" button (Domain 2, separate task).
- Fixing `cam grab` intermittency (mt-transport's firmware, tracked under their PIR work).
- Any change to the push/fetch path.
