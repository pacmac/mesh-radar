---
module: messages-api
source: src/messages-api.js
source_hash: 8c523b0c298493c18ec00cbe474cf806ffda75438f7d9fef96c1867d7ae1c2aa
updated: 2026-06-30
---

# Module: messages-api

## Purpose

Express Router for `POST /:nodeId/messages`. Extracted from `index.js`. Proxies
outbound text messages to mesh-gw and then persists the sent message in SQLite
so reply threading survives page reload.

## Responsibilities

- Proxy `POST /:nodeId/messages` to bridge REST (`BRIDGE_URL`)
- Resolve BLE MAC nodeIds to live `!hexid` before forwarding
- On successful bridge response: persist the TX message via `stmts.insertTxMessage`
- Call `syncAlertedAt` after insert to prevent spurious outbound-message alerts
- Log persistence errors without failing the response (message was already sent)

## Dependencies

- `db.js` — `stmts.insertTxMessage`, `syncAlertedAt`
- `node-list.js` — `nodeList._cache` (to look up short/long name for TX record)
- `ws-relay.js` — `getLiveNodeIdByMac` (resolve MAC → live `!hexid`)
- `bridge.js` or env — `BRIDGE_URL` for proxy target

## Public interface

```js
export default router  // Express Router — registered on app by index.js
```

## State

_N/A_

## Events emitted

_N/A_

## Invariants

- If `nodeId` does not start with `!`, it is treated as a BLE MAC and resolved via `getLiveNodeIdByMac`. Falls back to the raw value if not found.
- The bridge request is made with the ORIGINAL `nodeId` (not the resolved one) to preserve the gw routing.
- Persist is attempted only if bridge response is OK and `result.id` is present.
- Persist failure is logged but does not change the HTTP response — the client already received the bridge result.
- `message_key` is always `'t-' + result.id` for TX messages.
- `replay: 0` and `hops: 0` are set for all TX records.
- `is_dm: 1` when `to_num !== 0xffffffff`; `is_dm: 0` for broadcast.

## Test notes

- **Success**: bridge 200 → response forwarded → `stmts.insertTxMessage` called with correct fields.
- **Bridge error**: bridge 4xx/5xx → response forwarded → no persist call.
- **Bridge unreachable**: 502 returned; no persist.
- **Persist throws**: response already sent; error logged; no crash.
- **MAC nodeId**: `getLiveNodeIdByMac` resolves to `!hexid`; `fromNum` computed from resolved id.

## Out of scope

- Message retrieval — `GET /messages` stays in `index.js` (thin, uses `queryMessages` directly).
- Reply threading logic — `ws-relay.js` enrichment owns that.
- Alert evaluation on received messages — `alerts.js` owns that.
