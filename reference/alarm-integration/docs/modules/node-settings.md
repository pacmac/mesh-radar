---
module: node-settings
source: src/node-settings.js
source_hash: d7d68cfefc2b5bc0e32325067c49d7ce2149096db2d77e6e958edef1af1e42e7
updated: 2026-07-18
---

# Module: node-settings

## Purpose

Save one setting on one remote node and **confirm it by reply**. Validates
against `config-schema.json` before transmitting, addresses the command per
API.md §3, and correlates the device's JSON reply by `reply_id`.

## THE SSOT RULE

**This module never writes a setting into node-dash state.** A successful reply
means the command was *accepted*; the value the page displays keeps coming from
the device's own `type:config` broadcast, cached in `node_app_state`. If the
device disagrees with what was asked for, **the device wins**.

One source of truth, and it is the radio.

## Responsibilities

- Resolve and validate a setting against `config-schema.json`
- Build the addressed command `@<target> <verb> <arg>`
- Resolve the TX channel safely (see below)
- Register the in-flight command and resolve it from the device's reply
- Report `no_reply` on silence — never success

## Dependencies

- `db.js` — `stmts.getNodeByNum` (target short_name), `getConfig` (channel override)
- `docs/mt-transport/config-schema.json` — read once at load; static per firmware
- No network I/O of its own: the caller injects `send`

## Public interface

```js
settingsSchema()                       // → the parsed schema
validateSetting(path, value)           // → {ok, def, arg} | {ok:false, error}
resolveCommandChannel(gatewayChannels) // → {ok, channel} | {ok:false, error}
handleReply(replyId, text)             // → bool, true if it answered a pending command
saveNodeSetting({num, path, value, gatewayNodeId, gatewayChannels, send})
  // → {ok, state, sent?, reply?, error?}
  // state: applied | rejected | no_reply | invalid
```

## Channel safety — hard invariant

Peter, 2026-07-18: *"you can send on PRIVATE but NEVER on PRIMARY"*.

The channel is resolved from the **sending radio's own channel list, by name**
(`Private`) — never hardcoded, and never inferred from historical traffic, since
firmware generations have changed and old logs do not describe current
behaviour. Config key `command_channel` overrides it.

**A send on index 0, or with no channel named Private, is REFUSED**
(`state: 'invalid'`). Refusing is correct; guessing is not.

## Reply correlation

Replies are TEXT_MESSAGE_APP packets carrying `reply_id` = the command's packet
id (API.md §3). `bridge-events.js` routes them here **after persistence** — the
same placement, and the same ordering reason, as the message-history
rebroadcast.

Pending commands live in a module-level `Map` keyed by packet id with a 30 s
timer. Nothing is persisted: an in-flight command is transient and a restart
legitimately abandons it.

Confirmation is strict: only `ok === true` is `applied`. `{type:'err'}` is
`rejected`, and a typed reply **without** `ok:true` is also `rejected` rather
than optimistically accepted.

## Not supported yet

`det.win` shares `cmd: detect` with the readonly `det.n`, and API.md §3 says the
first argument is ignored. Rather than guess the shape on a live radio it is
listed in `UNSUPPORTED` and rejected explicitly.

## Invariants

- No setting is written to node-dash state on success.
- An out-of-range or readonly value is never transmitted.
- A node with no `short_name` is refused — a bare `@verb` is silently ignored by
  current firmware, so the command would vanish rather than fail.
- Silence is `no_reply`, never success.
- A send on channel 0 is impossible by construction.

## Test notes

- Validation: below min, above max, readonly, unknown path, bool→word mapping
- Channel: Private found; none found; Private at index 0; empty list
- Flow: `ok:true` → applied; `{type:'err'}` → rejected; typed reply without
  `ok:true` → rejected; unrelated reply_id ignored; silence → `no_reply` at 30 s
  with the pending map cleaned up

## Out of scope

- The UI (edit/save toggle) — separate task
- OpManager integration — its runners are documented stubs; this stands alone
  and can be adopted later
