---
module: app-control
source: public/app-control.js
source_hash: d5cb4b304927848d10934795eef5ae84b47cd255ac868095daa4b48a4f1160d6
updated: 2026-07-21
---

# Module: app-control

## Purpose

The browser mixin for the **Control page** — the command/response console. Quick
device select + command shortcuts + a command-only feed. Presentation only
(BROWSER_CONTRACT): it renders server-provided nodes and the server-classified feed,
and posts commands to the backend command route. It classifies nothing and decides
no channel.

Chat and Control are two filtered views of the one WS message feed: Control shows
`bucket === 'command'`, the messages page shows chat. The split is presentation
over the server's `type_bucket` — the same sanctioned filtering as the feed filter.

## Public interface (methods on the Alpine component)

```js
controlDevices()        // → [{num,label}] — favourites first, then PAC_ALARM nodes only
controlShortcuts()      // → the common command verbs (buttons)
controlFeed()           // → this.messages filtered to bucket==='command'
controlTargetLabel()    // → label of the selected device
sendControl(command?)   // POST /nodes/:num/command { command }; command defaults to controlCommand
```

State (on `app.js`): `controlTarget` (selected node num | null), `controlCommand`
(free-text verb), `controlSending` (bool).

## Behaviour

- **Device picker** — `controlDevices()` merges `favourites` (server nav list) ahead
  of `allMsgNodes()` filtered to `client_role === 'PAC_ALARM'`, deduped. Control only
  ever addresses our alarm units — the rest of the mesh is never an offerable command
  target (same pattern `push-viewer.md` uses for its target picker). One-click sets
  `controlTarget`.
- **Shortcuts** — `CONTROL_SHORTCUTS` (v1: `ping status config reboot`); a button
  fires that verb at the selected device immediately. Plus a free-text box for any
  other verb.
- **Send** — `sendControl(cmd)` POSTs `{command}` to `/nodes/:num/command` (the
  backend addresses it `@<suffix>`, resolves Private, never Primary). No optimistic
  row: the command and its response arrive over the WS `message_history` like any
  message. A missing target toasts "Select a device first".
- **Command feed** — `controlFeed()` shows only command-bucket rows; the response
  (pong/JSON, also `command` bucket) threads under its command by `reply_id`
  (existing feed threading), so each command pairs with its reply.

## Invariants

- **No channel decision** — the browser never sends a channel; the backend resolves
  Private by name. The Control page can't put traffic on Primary.
- **No classification** — `bucket` is server-computed (`type_bucket`); the page only
  filters on it.
- **One feed, two views** — Control and chat read the same `this.messages`; neither
  mutates it.
- **PAC_ALARM only** — the `allMsgNodes()` half of the device list is filtered to
  `client_role === 'PAC_ALARM'` (server-stamped, `src/client-role.js` /
  `src/node-list.js:462`); the rest of the mesh is never an offerable command target.
  `favourites` is NOT filtered — `queryFavourites` (`src/db.js:470`) returns
  `{num, node_id, label}` with no `client_role`, so a non-alarm favourite would still
  leak through. Both current favourites happen to be PAC_ALARM units, so this is
  harmless today; giving favourites the same guarantee needs a backend field and is
  out of scope for this Domain-2 task — flagged, not fixed here.

## Test notes

- Selecting a device then a shortcut POSTs `/nodes/<num>/command {command:'ping'}`.
- `controlFeed()` contains only `bucket==='command'` rows; a chat row never appears.
- Send with no target → toast, no POST.
- `controlDevices()` never lists a node whose `client_role` isn't `PAC_ALARM`, except
  via `favourites` (see Invariants).

## Out of scope

- The backend send/channel resolution — `command-api.js`.
- The chat page — `app-messages.js` / `tab-messages.html`.
- The page markup — `tab-control.md`.

## controlFeed reads the server feed (task messages-chat-only, 2026-07-20)

`controlFeed()` returns `this.commandMessages` — the server-pushed
`command_history` — instead of filtering `this.messages` for command-bucket rows.
That removed the last browser classification decision on this page, and makes the
control stream consumable by other clients (mt-transport/DEV1) rather than existing
only as a filter inside one browser tab.

## Device list filtered to PAC_ALARM (task control-page-alarm-filter, 2026-07-21)

`controlDevices()` offered every messageable node in the mesh — Control had no
`client_role` filter at all, unlike `push-viewer.md`'s target picker. Fixed by
filtering the `allMsgNodes()` half to `n.client_role === 'PAC_ALARM'`; `favourites`
is left unfiltered (see Invariants) since it carries no `client_role` field to
filter on.
