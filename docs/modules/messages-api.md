---
module: messages-api
source: src/messages-api.js
source_hash: 60e67bc31ccf6a6abf469e00f2d15f245f8a4db2c5031943d970ffc9ca595529
updated: 2026-08-16
---

# Module: messages-api

## Purpose

Express Router for `POST /:nodeId/messages` — the browser's **human chat** send.
It delegates the transmit-and-record to the shared `sendMeshText()` (see
`mesh-send.md`), tagging the traffic `category: 'chat'`.

Extracted from `index.js`. Previously it inlined the POST-to-gateway and
`insertTxMessage` recording; that logic now lives in `mesh-send.js` so **every**
sender records through one path, not just this one.

## Responsibilities

- Accept `POST /:nodeId/messages` and call `sendMeshText({ gatewayNodeId: nodeId,
  text, channel, to, reply_id, category: 'chat' })`
- Return the gateway result JSON (`{ id, to }`) on success
- Map a gateway error (`sendMeshText` throws `gateway <status>`) back to that HTTP
  status; other failures → 502

## Dependencies

- `mesh-send.js` — `sendMeshText` (does the POST, the `insertTxMessage` record,
  `syncAlertedAt`, and `broadcastMessageHistory`)

## Public interface

```js
export default router  // Express Router — app.use(messagesRouter) in index.js
                       // (no prefix; route is POST /:nodeId/messages)
```

## Invariants

- **The record path is `mesh-send`, not inline.** This router no longer touches
  `insertTxMessage`, `BRIDGE_URL`, or `nodeList` — a direct POST or inline persist
  here would reintroduce the bypass this refactor removed.
- A failed gateway send returns its status and records nothing (enforced by
  `sendMeshText`).
- **A request without a channel is refused with 400** (task
  `channel-callers-onto-resolver`, 2026-08-16). This was `req.body.channel ?? 0`,
  so a caller that omitted the field broadcast to the **public mesh**. The browser
  form always supplies it, which is exactly what made the default dangerous: it
  could only ever fire for a caller that had forgotten, and the consequence of
  forgetting was a public transmission. There is no safe default for "which
  channel"; the honest answer to an unstated one is to refuse.
- Device vocabulary, `message_key = 't-<id>'`, broadcast-after-send, and the
  MAC-vs-node_id resolution are all `mesh-send`'s responsibility now — see that spec.

## Test notes

- **Success**: gateway 200 → `sendMeshText` records a `t-<id>` row `category='chat'`
  and the route returns `{ id, to }`.
- **Gateway error**: `sendMeshText` throws `gateway 4xx/5xx` → route responds with
  that status; nothing recorded.

## Out of scope

- Message retrieval — `GET /messages` stays in `index.js`.
- Reply threading / enrichment — `ws-relay.js`.
- Alert evaluation on received messages — `alerts.js`.
- The transmit + record mechanics — `mesh-send.js`.
