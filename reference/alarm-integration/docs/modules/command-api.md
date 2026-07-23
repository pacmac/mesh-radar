---
module: command-api
source: src/command-api.js
source_hash: e103c412785d616dc4958f6f1f0027a064536b3fe51701243661866059f44e6e
updated: 2026-07-20
---

# Module: command-api

## Purpose

The browser-facing route for sending an **addressed command** to a mesh node and
having its response pair back in the command feed. It is the general-purpose
command/response send — the counterpart to the chat route (`messages-api`), split
by purpose (task `command-response-route`, Peter 2026-07-20):

- **Chat** → Primary (channel 0), the existing `POST /:nodeId/messages`.
- **Command/response** → the **Private / command channel**, this route.

It is align's addressed-ping send (`align-api`) generalized to any verb. Does
**not**: pick a channel from the request body, wait for the reply (the feed pairs
it), or correlate anything itself.

## Route

```
POST /nodes/:num/command     body { command }
```

- `command` is the verb + args only (e.g. `"ping"`, `"config interval 60"`) —
  **no addressing.** The server prepends `@<hexSuffix(num)>` (last 4 hex of the
  node num — the alarm grammar), so the browser never builds the address.
- **Channel** = `resolveCommandChannel(getDeviceChannelsByNodeId(gateway))` — the
  channel **named "Private"** on the gateway, by name, refusing index 0. Never a
  body channel, **never Primary by construction**. (Same resolver align + node
  settings + chunk-fetch use.)
- **Gateway** = `resolvePrimaryNodeId()`.
- Sent as a **broadcast on Private with `@suffix` textual addressing** (no `to`) —
  Peter's model: "broadcast message on Private with @xxx as the address." A
  directed packet would fail PKI on the alarm.
- Recorded via `sendMeshText` with **`category:'command'`** (so `type_bucket` →
  `command` and it lands in the command feed).

### Responses

| Condition | Status |
|---|---|
| accepted, sent | `200 {ok, state:'sent', packet_id, channel, to}` |
| bad `num` / empty `command` | `400` |
| no gateway radio | `503` |
| no "Private" channel resolvable | `409` (`ch.error`) |
| gateway rejected the send | mapped from `gateway <status>` (like messages-api) |

## Response pairing — no backend correlation needed

The device replies with a message whose `reply_id` = this command's `packet_id`.
The feed enrichment already computes thread metadata (`reply_id`,
`thread_root_packet_id`, `reply_depth`), so the command and its response thread
together in the feed with **no correlation code here**. The route is fire-and-send;
the response arrives over the normal WS `message_history` path.

## Dependencies

- `mesh-send.js` (`sendMeshText`), `device-config.js` (`resolvePrimaryNodeId`),
  `node-settings.js` (`resolveCommandChannel`), `ws-relay.js`
  (`getDeviceChannelsByNodeId`), `log.js`.

## Exports

```js
export default router;   // POST /nodes/:num/command
```

## Invariants

- **Never a channel number from the browser** — resolved by name, server-side.
- **Never PRIMARY** — `resolveCommandChannel` refuses index 0.
- **Never a directed packet** — broadcast on Private, `@suffix` addressing (PKI).
- **Recorded** — routes through `sendMeshText`, so no command bypasses the log
  (category `command`).

## Test notes

- Bad body (missing `command`, non-integer `num`) → `400`.
- No "Private" channel → `409`; no gateway → `503`.
- A live `ping` resolves the channel to Private's index (2 on OMNI), sends
  `@<suffix> ping`, records category `command`; the pong pairs by `reply_id` in the
  feed. (Live send is user/operator-driven; not auto-fired against another
  session's device.)

## Out of scope

- The chat route — `messages-api.js` (Primary, unchanged).
- The two-feed browser split — later Domain-2 pass.
- Specific command flows (align session, chunk fetch, settings) — their own
  modules; this is the general command send.
