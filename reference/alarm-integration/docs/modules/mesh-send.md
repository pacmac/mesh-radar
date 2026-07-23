---
module: mesh-send
source: src/mesh-send.js
source_hash: bef0aa2d75fca7745754a1a39e66a55a1d877c6aa3b7c82364a5096da88ffd83
updated: 2026-07-20
---

# Module: mesh-send

## Purpose

The **single place** that transmits an outbound mesh text AND records it. Every
sender routes through `sendMeshText()`, so no send can bypass the message log —
the defect this module fixes (found via `/investigate`, 2026-07-20).

## The bug this closes

Outbound messages were recorded in exactly one place — `messages-api.js` inlined
`insertTxMessage` after its POST. Every other sender POSTed straight to the
mesh-gw and recorded nothing:

- `align-api.js` (ping bursts) and `settings-api.js` (config commands) POSTed
  **directly to the mesh-gw** (`BRIDGE_URL`, port 8001) — **bypassed recording.**

Because a radio never hears its own transmission, a bypassed send appeared in the
feed only when a *second* local radio happened to re-decode the RF (the RX path,
`persist.js` → `insertRxMessage`) — which is lossy. Proven: a 4-ping align burst
recorded only 1–2, and a ping that DEPL provably answered (`1791897740`) was
absent from the feed entirely.

**Not bypasses (verified during implementation):**
- `op-manager.js` fetches to `LOCAL_BASE` (node-dash's own port 8000, op-manager.js:293/301),
  so its `send_message` op hits node-dash's `/messages` route → messages-api → recorded.
  (`send_message` is also not triggered anywhere.) No change needed.
- `transport-adapter.js` — the external mt-transport Client POSTs to node-dash's
  own `/messages` route, so it already records.

## Public interface

```js
export async function sendMeshText({
  gatewayNodeId,   // the radio to transmit from (node_id or MAC path)
  text,            // message body
  channel,         // channel index (never 0; callers already enforce)
  to,              // optional recipient node num; omit/null → broadcast
  reply_id,        // optional; threads a reply
  category,        // 'chat' | 'command' | 'ping' — tags the traffic (see below)
}) : Promise<{ id, to }>   // the gw result; throws on gw error
```

Behaviour:
1. POST to `${BRIDGE_URL}/${gatewayNodeId}/messages` with `{ text, channel, to?,
   reply_id? }`.
2. On a non-OK response, throw (`gateway <status>`), recording nothing — a send
   that failed must not appear as sent.
3. On success with an `id`, record the outbound via `insertTxMessage`
   (`message_key = 't-' + id`, `category`), then `syncAlertedAt(id)` and
   `broadcastMessageHistory()` — exactly the steps messages-api did inline.
4. Return the gw result.

`from_num` / `device` / `short_name` / `long_name` are resolved from
`gatewayNodeId` the same way messages-api did (device is MAC vocabulary, to match
the RX path and the `(packet_id, device)` dedup index).

## Category — the tag that makes the feed filterable

Policy B (Peter, 2026-07-20): record **everything**, but tag command/ping traffic
so the feed can hide it by default while it stays queryable. Values this task sets:

| category | senders |
|---|---|
| `chat` | `messages-api` (human messages) |
| `ping` | `align-api` (alignment ping bursts — the high-volume traffic) |
| `command` | `settings-api`, `op-manager` (addressed device commands) |

> The message-feed **filter UI** (channel / device / type, checkbox or button
> groups with an "all" option) is a **separate task**, to be designed with Peter
> before coding. Typing of *received* messages (pong/status/env/alarm/…) also
> belongs to that task; this task tags **outbound** only, so received rows keep
> `category = NULL` for now.

## No duplicate feed rows

A recorded `t-<id>` row plus a later re-heard `r-<id>` row share a `packet_id`.
`filters.js` groups the feed by `packet_id`, so the two collapse into one
displayed message (its comment documents exactly this case). Recording outbound is
therefore safe against duplication.

## Files changed by this task

- **`src/mesh-send.js`** (new) — this module.
- **`src/db.js`** — add `category TEXT` column to `messages` (ALTER migration,
  same pattern as the other late-added columns); add `@category` to the
  `insertTxMessage` statement's column list.
- **`src/messages-api.js`** — replace the inline POST + `insertTxMessage` block
  with a `sendMeshText({ …, category: 'chat' })` call (preserving the upstream
  status passthrough to the browser).
- **`src/align-api.js`** — `sendPing` calls `sendMeshText({ …, category: 'ping' })`
  instead of the raw `fetch`.
- **`src/settings-api.js`** — the `send` closure calls `sendMeshText({ …,
  category: 'command' })`.
- **`src/op-manager.js`** — **no change.** It fetches node-dash's own routes
  (`LOCAL_BASE`, not the gateway), so `send_message` already records via
  messages-api; and the op is unused. (Investigation had over-flagged it.)

## Invariants

- **One send path.** No module POSTs to `/…/messages` directly except
  `sendMeshText`. A direct POST elsewhere is a regression.
- **Failed sends record nothing.**
- **`device` is MAC vocabulary** (dedup index single-vocabulary).
- **Never channel 0** — callers still enforce; the helper does not relax it.

## Test notes

- a 4-ping align burst produces **4** `t-<id>` rows (one per ping), each
  `category='ping'` — verified by `packet_id` against the DIAG send ids.
- a ping later re-heard by the YAGI adds an `r-<id>` row; the feed query still
  shows **one** message for that `packet_id`.
- a human message via messages-api records `category='chat'` and still returns the
  gw status to the browser unchanged.
- a gateway error throws and inserts nothing.

## Out of scope

- The message-feed **filter UI** and received-message typing — separate task.
- The align reply-timing bug (late replies discarded) — separate, still open.
