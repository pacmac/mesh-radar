---
module: tab-control
source: public/partials/tab-control.html
source_hash: 8404c2cd60c019db98ef7abe219cfca09d541e0c478d011b7be2a146b93edbd3
updated: 2026-07-25
---

# Module: tab-control

## Purpose

Control page: pac-host unit picker, command shortcuts + free-text verb,
queue/receipt panel. Presentation only — renders `controlMixin`
(`app-control.js`) state and decides nothing about verbs, units, or receipt
meaning (BROWSER_CONTRACT).

## Scope

Task `pac-host-command-surface`. New page, no prior version. Companion files:
`public/app-control.js` (own spec), `public/index.html` (one `x-if` line),
`public/partials/drawer-sidebar.html` (nav item, `x-show`-gated on
`pacHostStatus?.available`), `public/app-nav.js` (`control` path map).

## Layout

Left/right grid (`lg:grid-cols-2`): **Command** card on the left; a
vertically-stacked **Pending** + **Executed** pair on the right (task
`control-since-and-pending-split`, 2026-07-25 — Peter: "the command /
response should show any queued commands in probably a seperate panel / card
above it. and queue is the wrong label for the existing one, that is
executed."). Replaces the earlier single side-by-side "Queue" card.

- **Command** card: unit picker (`.join` of buttons, one per
  `controlDevices()` entry), shortcut verbs (`.join`, disabled until a unit
  is selected), free-text verb input + Send. A warning line appears only
  when `controlTargetNeedsConfirm()` is true for the selected unit.
- **Pending** card (top, `max-height:40%`, own scroll): `controlPending()` —
  entries with `status === 'pending'`, i.e. still in flight. Compact
  rendering (verb+args, `entry.since`, a `badge-info` "pending" badge,
  `lastError` if present) — no receipt yet, since a pending entry has none.
- **Executed** card (below, fills remaining height): `controlExecuted()` —
  every entry that has reached a terminal outcome (`acked`/`cancelled`/
  `failed`). No refresh control of any kind — both cards are a pure read of
  pushed state (task `control-queue-push-not-get`, 2026-07-25; an earlier
  version had a manual refresh button, removed along with the GET it
  triggered). Rendered **newest-first** (`controlLedger()` sorts by
  `enqueuedAt` descending — pac-host's own ledger array is oldest-first,
  which read as "random" to Peter, 2026-07-25). Each entry is a
  `bg-base-200 rounded-xl p-3` sub-section (STYLE_GUIDE §5) showing verb+args
  (data role) plus the server-pushed relative timestamp (`entry.since`, e.g.
  "5m ago" — task `control-since-and-pending-split`, replaces the earlier
  client-formatted `YYMMDD-HHMMSS` stamp per BROWSER_CONTRACT: relative time
  must be server-formatted and pushed, not computed by the browser), a status
  badge (`acked`→success, `cancelled`→warning, `failed`→error, anything
  else→ghost), the receipt as a key-value grid (`controlReceiptFields()` —
  reuses `tab-node.html`'s `value_grid` pattern exactly, task
  `control-receipt-readable`), and `lastError` when present.

## Invariants

- Never renders as, or alongside, the chat message feed (`tab-messages.html`)
  — command traffic is not chat, even though it rides on Meshtastic text
  messages underneath (Peter, 2026-07-25 — see task
  `custom-app-extension-point` notes).
- Renders exactly what `controlMixin` computes; no verb list, unit filter, or
  confirmation logic lives in this file.

## Test notes

Verified live 2026-07-25 against the real pac-host service and the real
bench unit: unit picker showed exactly BNCH/GARG, shortcut send round-tripped
a real queued command visible in the ledger, both themes, 0 console errors.
GARG's confirmation dialog fired with the correct message and was dismissed
(not accepted) — confirmed no command reached GARG's ledger.

Pending/Executed split + since + sort re-verified live 2026-07-25: sent two
real commands to BNCH (`ping`, `status`) via the actual `/nodes/:num/pac-command`
route; the second was screenshotted mid-flight showing `status:'pending'` in
the Pending card with a live `since` value ("6s ago", "21s ago", "51s ago"
across three reloads) before it resolved to `acked` and moved to Executed.
Executed card confirmed newest-first ("1m ago" → "38m ago" → "59m ago" → "1h
ago", strictly descending). Both themes screenshotted and read.

## Out of scope

- Any fetch of any kind — see Layout. This page has never made a network GET
  and must not gain one; all data is `pacHostStatus`/`pacHostQueues`, pushed.
