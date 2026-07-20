---
module: tab-control
source: public/partials/tab-control.html
source_hash: 6202f1dc7279f78ae6054bff2131395913c4ccb12eee02da42ebeab787a28cb6
updated: 2026-07-20
---

# Module: tab-control

## Purpose

The **Control page** markup (`x-show="tab==='control'"`) — the command/response
console. Presentation only; all logic is in `app-control.js` (`app-control.md`).

New page (task `command-response-route`, Peter 2026-07-20): command/response gets
its own page, distinct from the chat-only messages page.

## Layout

Two cards, following the existing card/`join`/button-group idiom:

1. **Send panel** (shrink-0):
   - **Device** row — a wrapping button set from `controlDevices()` (favourites
     first); the selected one is `btn-primary`, sets `controlTarget`.
   - **Command** row — a `join` of shortcut buttons from `controlShortcuts()`
     (`ping status config reboot`), each disabled until a device is selected;
     click → `sendControl(verb)`.
   - **Free-text** row — an input bound to `controlCommand` + a Send button;
     Enter or Send → `sendControl()`.
   - A hint line: `→ <device> on the Private channel` when a target is set.
2. **Command feed** (flex-1, scroll) — `x-for` over `controlFeed()`:
   - each row badged `↑ cmd` (tx) / `↓ resp` (rx), reply-depth-indented so a
     response sits under its command; body in mono.
   - empty-state "No commands yet…".

## Invariants

- Renders server data only; the channel is never shown as a choice (it's always
  Private, server-resolved). No filter buttons — this page IS the command view.
- Reuses `nodeLongName`, `showToast`, `fetchJSON` via the component; adds no new
  Alpine logic of its own.

## Test notes

- Playwright, both themes: device buttons render, a shortcut is disabled until a
  device is picked, the feed lists command-bucket rows with responses indented.

## Out of scope

- Logic — `app-control.js`. The nav entry — `drawer-sidebar.html`. Routing —
  `app-nav.js` path maps.
