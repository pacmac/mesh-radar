---
module: tab-control
source: public/partials/tab-control.html
source_hash: a072ad975692b97b0be089e1eec96337dd634a2bbe3f3a9b440269828f63fab3
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

## Sub-tabs (task `control-section-ia`, 2026-07-25)

Peter: "I think it's time you added the menu / submenu, even if they are
skeleton pages." Six sub-tabs, `controlTab`-gated, `.tabs` bar mirroring
`tab-cfg.html`'s pattern exactly (same shape as `cfgTab`, driven by
`switchControlTab()` in `app-control.js`, routed through `setNav('control',
name)` in `app-nav.js`, mirrored in `drawer-sidebar.html`'s Control
`<details>` submenu): **Summary, Command, Config, Stats, Yagi Align, Chat**.
Only **Command** has real content today — the other five are skeleton cards
(Section-label title + Caption-role "Coming soon.", STYLE_GUIDE §5), no
functionality, per Peter's explicit "even if they are skeleton pages."
`controlTab` persists (default `'command'`, the only sub-tab with content).

Do not confuse "Yagi Align" here with the archived
`reference/alarm-integration/` align feature — that depended on the
auto-reply/custom-firmware path and was correctly removed; this is an empty
placeholder tab, not a revival.

## Layout — Command sub-tab

Left/right grid (`lg:grid-cols-2`): **Command** card on the left; a
vertically-stacked **Pending** + **Executed** pair on the right (task
`control-since-and-pending-split`, 2026-07-25 — Peter: "the command /
response should show any queued commands in probably a seperate panel / card
above it. and queue is the wrong label for the existing one, that is
executed."). Replaces the earlier single side-by-side "Queue" card.

- **Command** card: unit picker (`.join` of buttons, one per
  `controlDevices()` entry), shortcut verbs (`.join`, disabled until a unit
  is selected), free-text verb input + Send. **No confirmation gate before
  sending, to any unit — removed 2026-07-25 (task `garg-confirm-removal`),
  Peter's explicit request** ("please remove the popup confirmation when
  sending to GARG"), reversing his own earlier directive. A unit button dims
  (`opacity-60` + a title tooltip) when `!d.present` (task
  `control-devices-endpoint`, 2026-07-25) — known-but-asleep, still fully
  clickable, since queuing a command for a sleeping unit is valid (delivered
  next wake window).
- **Pending** card (top, `max-height:40%`, own scroll): `controlPending()` —
  entries with `state === 'queued'` or `'trying'`, i.e. still in flight.
  Compact rendering (verb+args, `entry.since`, a `badge-info` badge showing
  the raw state text, an error line gated on `state==='failed'||'expired'`
  — never on mere presence of `entry.error`, since a queued entry can carry
  a stale error from a previous retry, mt-transport's explicit correction)
  — no result yet, since a pending entry has none.
- **Executed** card (below, fills remaining height): `controlExecuted()` —
  every entry that has reached a terminal outcome (`done`/`sent`/`failed`/
  `expired`/`cancelled`). No refresh control of any kind — both cards are a
  pure read of pushed state (task `control-queue-push-not-get`, 2026-07-25;
  an earlier version had a manual refresh button, removed along with the GET
  it triggered). Rendered **newest-first** (`controlLedger()` sorts by
  `createdAt` descending — pac-host's own ledger array is oldest-first,
  which read as "random" to Peter, 2026-07-25). Each entry is a
  `bg-base-200 rounded-xl p-3` sub-section (STYLE_GUIDE §5) showing verb+args
  (data role) plus the server-pushed relative timestamp (`entry.since`, e.g.
  "5m ago" — task `control-since-and-pending-split`, replaces the earlier
  client-formatted `YYMMDD-HHMMSS` stamp per BROWSER_CONTRACT: relative time
  must be server-formatted and pushed, not computed by the browser), a state
  badge (`done`→success, `sent`→info — deliberately NOT success, since a
  dispatched-but-unconfirmable text/command is a different claim than a
  device-confirmed one, mt-transport's explicit design note — `cancelled`→
  warning, `failed`/`expired`→error, anything else→ghost), the result as a
  key-value grid (`controlResultFields()` — reuses `tab-node.html`'s
  `value_grid` pattern exactly, task `control-receipt-readable`), and the
  error message when `state==='failed'||'expired'` and `entry.error` is set.

  **Field names (task `ledger-field-rename`, 2026-07-25):** mt-transport
  shipped a full ledger rewrite the same day (commit `975449e`, xsession
  `[request-ledger]`) with no old-shape fallback — `status`→`state`,
  `enqueuedAt`→`createdAt`, `receipt`→`result`, `lastError` string→`error`
  `{code,message}` object. The ledger also now holds text messages
  (`kind:'text'`) alongside commands — `controlLedger()` filters to
  `kind==='command'` so this page's own Invariant (below) stays true rather
  than silently breaking. Peter caught the resulting breakage independently
  ("now it only shows 1 line, the command") before this fix landed.

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
