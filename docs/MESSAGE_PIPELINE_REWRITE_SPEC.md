# Message pipeline — rewrite to a single source of truth

Backlog #10. Peter: *"no more fire fighting / hacking / patching"* — sent
messages appear only after a page reload; received messages always arrive live.

Names `docs/STYLE_GUIDE.md` (§8.6). Governing document: `BROWSER_CONTRACT.md`.

**This is a rewrite, not a patch.** Five previous fixes to this symptom failed
because each adjusted the merge between two sources of truth instead of removing
the second one: `6373e75`, `f8738b1`, `d6ca1f2`, `70d164c`, `f715eee`.

## What is actually wrong

`this.messages` has **three writers with three strategies and three identity
schemes**:

| Writer | Strategy | Identity | Carries |
|---|---|---|---|
| `_applyMessageRows` (`message_history`) | **replaces** the array | `pktId + '_' + direction` | TX **and** RX |
| `_insertThreadedMessage` (`app-ws.js:638`) | **mutates** the array | `pktId` | RX only |
| `sendMessage()` optimistic entry | `unshift`, then mutates `m.pktId = res.id` | `_txKey` → `pktIdHint` → server id | TX only |

A gateway radio never hears its own transmission, so **TX can only ever arrive
via the replace path** — precisely the one competing with the mutate path.

Compounding faults:
- Threading is derived **twice** — server (`_enrichMessages`) and browser
  (`_insertThreadedMessage`) — and the two can disagree.
- Multi-radio dedup is done **twice** — server (`GROUP BY packet_id`, merged
  `rx_devices`) and browser (the `dupe` merge at `app-ws.js:628`).
- The whole RX block is wrapped in `try { … } catch (_) {}` (`app-ws.js:611-651`),
  so any error inside it is silently swallowed.
- `BROWSER_CONTRACT` violation: the optimistic entry is the browser holding
  authoritative state and deciding what exists.

The server already does all of this correctly. The browser duplicates it badly.

## The rewrite — one writer, one identity, server-owned

**`message_history` becomes the only thing that ever writes the message list.**
The browser stops constructing messages entirely.

### Ordering constraint (critical, and why this must live in bridge-events)

`attachWsRelay` registers its `bridge.on('event')` at `index.js:235`;
`registerBridgeEvents` registers persist at `index.js:309`. Listeners fire in
registration order, so **ws-relay's handler runs BEFORE the row is persisted**.
Triggering the rebroadcast from ws-relay would push history that does not yet
contain the new message. It must be triggered **after** `handleEvent(ev)`, i.e.
from `bridge-events.js`.

### Changes

**1. `src/filters.js` — stable identity from the server**

`messages.message_key` already exists in the DB (`t-<pktid>` / `r-<pktid>`) and
is already unique-indexed, but `queryMessages` never selected it. Add:

```sql
MIN(m.message_key) AS message_key
```

One identity, assigned by the database, unchanged for the life of the message.

**2. `src/bridge-events.js` — RX rebroadcasts authoritative history**

After `handleEvent(ev)` (so the row exists), when the event is a
TEXT_MESSAGE_APP packet, call `broadcastMessageHistory()`. RX and TX now travel
the identical path.

**3. `public/app-messages.js` — delete the competing writers**

- **Delete `_insertThreadedMessage` entirely** — the server threads.
- **Delete the optimistic `txEntry`** from `sendMessage()` — no local rows.
  `sendMessage` becomes: validate → POST → surface errors. Send feedback stays
  as transient UI (`msgSent` flag / toast), never a row in the list.
- `_applyMessageRows` maps server rows verbatim and exposes `key: r.message_key`.

**4. `public/app-ws.js` — stop building messages in the browser**

In the TEXT_MESSAGE_APP branch: remove message construction, the `dupe` merge
and the `_insertThreadedMessage` call. Keep only the unread badge and sound.
Remove the bare `catch (_) {}` so failures surface instead of vanishing.

**5. `public/partials/tab-messages.html` — key on server identity**

```html
<template x-for="m in displayMessages()" :key="m.key">
```

replacing the composite `'msg_' + (m._txKey || (m.pktId != null ? … ))`.

## Deliberately NOT changed

- `_enrichMessages` / `queryMessages` ordering and threading — already correct
  and now the only implementation.
- The WS transport. My keepalive theory was **wrong**: Peter confirmed received
  messages always arrive live, which proves the socket is healthy. No transport
  change.
- `messages-api.js` — already persists then broadcasts, in the right order.

## Invariants

- Exactly **one** writer to `this.messages`: `_applyMessageRows`.
- Exactly **one** identity per message, server-assigned: `message_key`.
- The browser derives no threading, no dedup, no ordering, no direction.
- A sent message reaches the feed by the same route as a received one.
- No silent `catch`.

## Done when

- Sending from the UI shows the message **without a reload**
- Receiving still appears live, threaded, deduped across radios
- `grep` shows no `_insertThreadedMessage`, no `_txKey`, no `_localTx`
- 1440×900, both themes, zero console errors
- `check_specs.py` green
