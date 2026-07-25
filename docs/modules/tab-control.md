---
module: tab-control
source: public/partials/tab-control.html
source_hash: 6e52a4eae56d359dd43ad6506501e309e1895a7678316e24887053520c079ee3
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

Two-card grid (`lg:grid-cols-2`), matching `tab-messages.html`'s shape:

- **Command** card: unit picker (`.join` of buttons, one per
  `controlDevices()` entry), shortcut verbs (`.join`, disabled until a unit
  is selected), free-text verb input + Send. A warning line appears only
  when `controlTargetNeedsConfirm()` is true for the selected unit.
- **Queue** card: `controlLedger` rendered newest-last (server order,
  unmodified), each entry showing verb+args, a status badge
  (`acked`→success, `pending`→info, `cancelled`→warning, anything else→
  ghost), and `receipt`/`lastError` when present.

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

## Out of scope

- SSE-based live receipts — this page polls the REST ledger on send/refresh
  only (matches `pac-command-api.js`'s scope).
