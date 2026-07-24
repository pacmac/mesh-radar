---
module: tab-messages
source: public/partials/tab-messages.html
source_hash: e0128252e23427a0f59d1e53cc7f2aacb752e89fddca3f103d9334b5b9c057b7
updated: 2026-07-24
---

# Module: tab-messages

## Purpose

Messages page: compose card (device/recipient/channel selection, @mention
autocomplete, quick emoji) and filtered message feed card. Presentation only.

## Current feed controls and row treatment (2026-07-24)

The feed header contains one compact joined control with four mutually
exclusive viewer filters: `ALL`, `BCAST`, `DIR`, and `CHAT`. The selected id is
stored in `msgFilter`; `displayMessages()` owns the corresponding ordered
subset.

Rows use server-derived delivery facts consistently:

- direct messages: warning-tinted left rule;
- non-primary broadcast/private-channel traffic: success-tinted left rule;
- primary broadcast chat: neutral row;
- TX/RX remains visible in the avatar arrow, independent of traffic class.

The toolbar changes only the current viewer's presentation. Message history,
threading, identity and order remain server-owned and arrive over WebSocket.

## Mobile containment (2026-07-23)

The 12 quick-reply buttons use a six-column grid on phones and a twelve-column
grid from `sm`, preventing the final “73” action from extending past 390px.

## Scope

**STYLE_GUIDE.md compliance refactor (task `messages-refactor`).** Zero logic
changes.

Files in scope (style task): `public/partials/tab-messages.html`.
Files in scope (message-flow-audit): `public/partials/tab-messages.html`,
`public/app-ws.js` (packet dedupe — see docs/modules/app-ws.md),
`public/app.js` (msgHistory seed removed),
`public/app-messages.js` (msgHistory localStorage write removed).
NOT changed: `src/messages-api.js`, `src/ws-relay.js` (backend verified
correct against the gw V2 contract).

## Changes

| Location | Before | After |
|---|---|---|
| Form row labels From/To/Ch (l.10, 23, 41) | `text-xs text-base-content/60` | `text-sm text-base-content/60` |
| From/To segmented joins (l.13, 25–26) | `btn-xs` | `btn-sm` (compose form controls, not dense rows) |
| Direct-recipient select (l.28) | `select-xs` | `select-sm` (matches channel select) |
| Reply indicator strip (l.50) | `text-xs` | `text-sm` (interactive element) |
| Direction dot (l.110) | `w-3.5 h-3.5 … text-[9px]` | `w-4 h-4 … text-xs` (banned px size; dot grows 2px) |

Kept as-is (sanctioned):
- `:style` reply-depth indent — runtime-computed from data (§7)
- Mention autocomplete `menu-xs` + `text-xs` — dense list
- Ack status / device badges `text-xs`/`badge-xs` — feed metadata captions
- Message body `text-base` — user content, not UI chrome; deliberate emphasis
- "→ node" hint `text-xs` — caption

## Message-flow fixes (task `message-flow-audit`)

**Live RX dedupe (fixes frozen feed):** with multiple radios the same mesh
packet arrives as one `packet` event per radio. The handler now dedupes by
`pktId`: the first arrival appends; later arrivals merge their source device
into `src` and fill missing rssi/snr — never a second entry. Duplicate feed
entries previously produced duplicate `x-for` keys, crashing Alpine's keyed
renderer and freezing the feed until reload.

**Feed keys:** `:key` composes `_txKey || pktId + '_' + direction` so a key
collision is structurally impossible.

**V2 status vocabulary:** the ACK indicator maps the gw V2 `message_status`
states (API_SSE §message_status): `sent`/`queued` → ✓ (dim), `relayed` → ↻
(warning), `delivered` → ✓✓ (success, with ack node), `failed`/`no_ack`/
`queue_failed` → ✕ (error), `no_ack_needed` → ✓ (broadcast terminal — no
receipt possible). "awaiting ACK…" shows for DMs in non-terminal states.
Legacy V1 names (acked/confirmed/sending/retrying) removed.

**localStorage msgHistory seed removed** (BROWSER_ARCH messages[] writer
consolidation): `messages[]` is written only by `message_history` (replace),
the live `packet` append, and the optimistic TX entry (sanctioned deviation:
reconciled via the `pkt_id` hint sent to the gw, so status events match).

## Invariants

- Send flow remains untouched by the viewer filter.
- The feed iterates `displayMessages()` and keeps the stable server `m.key`.
- Filter buttons never fetch page data and never mutate message rows.
- No raw colors; the only remaining `text-[...]` arbitrary sizes are removed

## Test notes

Playwright, both themes (guide §8): compose controls legible, filter join
selects each view, feed renders from WS history, and there are 0 console errors.

## TX row treatment + 200-row window (task `feed-tx-cap-style`, 2026-07-17)

Sent messages were visually near-identical to received ones (only the small
avatar ↑ badge and ACK tick differed) — easy to scan past in a busy feed.
The feed row div now adds `bg-success/5 border-l-2 border-l-success` when
`m.direction === 'tx'` (success = the established TX color, matching the
avatar badge). Non-partial edit in the same task (module unspecced):
`app-messages.js` sendMessage trim cap 50 → 200, matching the backend's
`message_history` depth (task `message-tx-broadcast`) so optimistic sends
don't shrink the window the next replay refills.

## Named channel select (task `send-channel-names`, 2026-07-17)

The Ch select offered static indexes 0–7 regardless of configuration —
sending on an unconfigured channel silently fails, and bare numbers mean
nothing. It now iterates `msgFromChannels()` (the sending radio's
`dev.channels` from the device_list, backend task `device-channels-on-list`),
rendering `ch.name` UPPERCASED for display (values stay numeric indexes), with "Primary" for an unnamed index 0 and
"Channel N" for other unnamed entries; unconfigured slots don't appear.
An `x-effect` resets `msgChannel` to 0 when the From radio changes to one
that lacks the selected index. Fallback before the first channels fetch:
`[{index:0}]` (Primary only). Helper `msgFromChannels()` lives in
`app-messages.js` (display convenience, no decisions).

## Per-viewer feed filter (task `message-feed-filters`, step 3, 2026-07-20)

A filter toolbar sits between the "Message Feed" `<h2>` and the feed scroll
container — three rows (Type / Device / Channel), each a `.join` button group in
the established `join-item btn btn-xs` style (denser than the compose `btn-sm`
controls). **Not dropdowns** (Peter). Each row:

- A leading **All** button — `btn-primary` when that dimension's filter array is
  empty, else `btn-outline`; `@click="clearMsgFilter('<Dim>')"`.
- One button per option (`x-for`), `btn-primary` when
  `msgFilterActive('<Dim>', v)` else `btn-outline`; `@click="toggleMsgFilter(...)"`.
- Multi-select within a row; the three rows AND across dimensions.

Options come from `app-messages.js`: `msgTypeOptions()` (fixed 5 buckets, labelled
`capitalize`), `msgDeviceOptions()` (distinct feed MACs, labelled via
`deviceLabel`), `msgChannelOptions()` (distinct **raw** channel numbers — sends
store index, receives store hash, so Peter tests raw then we refine). The Device
and Channel rows are `x-show`-guarded on their option count so an empty dimension
draws nothing.

The feed `x-for` is unchanged (`m in displayMessages()`), but `displayMessages()`
now returns the filtered subset (see `app-messages.md`). The empty-state line
switches on `displayMessages().length===0` and reads "No messages match the
current filters" when `messages.length` is non-zero, else "No messages yet…".

Filter selection is a **per-viewer** localStorage pref (`app.js` state
`msgFilterType/Device/Channel` via `persistGet`) — not server config. Contract-clean:
the *classification* of each message is server-computed; the user's show/hide is raw
input + presentation. Files: `public/partials/tab-messages.html` (toolbar +
empty-state), `public/app-messages.js` (bucket field, filter methods,
`displayMessages` filtering), `public/app.js` (3 persisted state fields — unspecced
aggregate root).

## Filter toolbar removed (task messages-chat-only, 2026-07-20; superseded)

The type/device/channel button groups are gone; the feed is chat-only server-side.
Empty state is a single case again ("No messages yet…").

The three-dimensional toolbar described above remains removed. The current
2026-07-24 toolbar is the smaller four-view `ALL/BCAST/DIR/CHAT` control defined
under “Current feed controls and row treatment”.
