---
module: app-messages
source: public/app-messages.js
source_hash: 134f4db175bbc08514ea385b8114b5c73c27d1ac889d9c74df2d6d738d836fc0
updated: 2026-07-20
---

# Module: app-messages

## Purpose

The browser **messaging mixin** — send, receive-render, and now **per-viewer feed
filtering**. Presentation only (BROWSER_CONTRACT): it renders the server-pushed
`message_history` array and handles raw user input. It classifies nothing, orders
nothing, and owns no message state that the server owns.

Does **not**: fetch history over HTTP (arrives via WS `message_history`), sort or
thread messages (pre-computed by node-dash), or derive a message's type/device/
channel (all three are server-computed fields on each row — see `filters.js` and
`message-type.md`).

## Public interface (methods on the Alpine component)

```js
_applyMessageRows(rows)        // map WS message_history rows → this.messages[]
displayMessages()              // → filtered view of this.messages for the feed x-for
sendMessage()                  // POST /:fromId/messages (no optimistic row)
// … compose/mention/history helpers (unchanged) …

// Per-viewer feed filter (task message-feed-filters, step 3):
msgTypeOptions()               // → the 5 fixed buckets
msgDeviceOptions()             // → distinct device MACs present in the feed
msgChannelOptions()            // → distinct raw channel values present in the feed
msgFilterActive(dim, val)      // → is `val` selected in msgFilter<dim>?
toggleMsgFilter(dim, val)      // toggle `val` in msgFilter<dim>, persist
clearMsgFilter(dim)            // reset msgFilter<dim> to [] (= "All"), persist
```

`dim` is one of the strings `'Type' | 'Device' | 'Channel'`, naming the state key
`msgFilter<dim>` (`msgFilterType` / `msgFilterDevice` / `msgFilterChannel`).

## The `bucket` field

`_applyMessageRows` now copies the server-computed `type_bucket` onto each row as
`bucket: r.type_bucket ?? null`. This is the only classification the type filter
reads; the browser never re-derives it (BROWSER_CONTRACT — the classifier is
`src/message-type.js`, exposed by `filters.js`).

## Per-viewer filter — state and semantics

State lives on the root component (`app.js`), restored from localStorage so it is
**per viewer**, not a global/config filter:

```js
msgFilterType:    persistGet('msgFilterType',    []),   // bucket strings
msgFilterDevice:  persistGet('msgFilterDevice',  []),   // device MAC strings
msgFilterChannel: persistGet('msgFilterChannel', []),   // raw channel numbers
```

- **Empty array = "All"** for that dimension (no restriction).
- **Multi-select within** a dimension: an OR over the selected values.
- **Combined across** dimensions: an AND (a row must pass every active dimension).
- `toggleMsgFilter` reassigns a new array (Alpine reactivity) and `persistSet`s it;
  `clearMsgFilter` sets `[]` and persists. Every mutation persists immediately, so
  the selection **survives reload**.

### `displayMessages()` filter

```js
const t = this.msgFilterType, d = this.msgFilterDevice, c = this.msgFilterChannel;
return this.messages.filter(m =>
  (t.length === 0 || t.includes(m.bucket)) &&
  (c.length === 0 || c.includes(m.channel)) &&
  (d.length === 0 || (Array.isArray(m.src) && m.src.some(x => d.includes(x))))
);
```

Order and thread structure are untouched — the array is filtered, never reordered.

### Option lists (derived from the loaded feed)

- `msgTypeOptions()` → the fixed 5 (`chat/command/alarm/camera/diagnostics`) so the
  Type control is stable regardless of what the current window happens to contain.
- `msgDeviceOptions()` → the distinct MACs across every row's `src`, sorted; each
  button is labelled via `deviceLabel(mac)` (OMNI/YAGI/…).
- `msgChannelOptions()` → the distinct raw `channel` values across the feed, sorted
  numerically. **Raw** on purpose: sends store the channel *index*, receives store
  the channel *hash*, so "Private" can appear as both 1 and 2. Peter tests the raw
  values live, then we refine (task note, 2026-07-20).

A device MAC or channel value only appears as a button if it is present in the
current feed, so the control never offers a filter that would match nothing.

## Invariants

- **Presentation only.** No field on a message row is computed here except the copy
  of the server's `type_bucket`. The filter is user input + a display subset — the
  same class of concern as collapsing a section, explicitly sanctioned in the task
  discussion.
- **Empty = All**, per dimension. A dimension with a non-empty array restricts.
- **Per-viewer, persisted.** The three arrays are localStorage-backed via
  `persistGet/persistSet`; nothing is written to server config.
- **No optimistic TX row** (unchanged): a sent message reaches the feed only via the
  server's authoritative `message_history` broadcast.

## Test notes

- A feed with mixed traffic: selecting Type=command hides chat rows; adding
  Type=chat shows both (OR within dimension).
- Type=command AND Device=YAGI shows only command rows heard by YAGI (AND across).
- "All" button for a dimension is highlighted iff that dimension's array is empty;
  clicking it clears the dimension.
- Set a filter, reload → the same buttons are still active (localStorage survives).
- Empty result with a non-empty feed shows "No messages match the current filters",
  not "No messages yet…".

## Out of scope

- The classifier itself — `src/message-type.js` / `message-type.md` (Domain 1, done).
- Query-time row shape (`type_bucket`, `rx_devices`, `channel`) — `filters.js`.
- The feed markup / toolbar — `tab-messages.md` (the view partial).
