---
module: tab-control
source: public/partials/tab-control.html
source_hash: 464b9f4f98519b1ee873ec200d0cd15d886a68ba2e1bc261c170fca16c6fa0f9
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

**Yagi Align is no longer a skeleton — rebuilt live, task `yagi-align-rebuild`,
2026-07-25**, after mt-transport shipped the align backend and Peter
confirmed the go-ahead ("so have you built the aligne frontend as I dont see
it?"). It is a rebuild of the archived `reference/alarm-integration/` feature
against the NEW pac-host-owned backend (`GET/POST /v1/mesh/align/*`), not a
revival of the old one — the old backend (`src/align-api.js`) depended on
this repo owning the mesh connection directly, which it no longer does. See
its own Layout section below and `docs/modules/app-align.md`.

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

## Layout — Yagi Align sub-tab (task `yagi-align-rebuild`, 2026-07-25)

Single column, ported from the archive's `align.html` structure into
STYLE_GUIDE-compliant markup (Alpine bindings replacing raw DOM element
lookups, `text-2xl font-mono font-bold tabular-nums` Display-value role
replacing the archive's oversized `text-6xl` — that page was a full-screen
mobile field tool, this is an embedded dashboard card):

- **Controls row**: target `<select>` (options from `alignTargets()` —
  node-dash's own `favourites`, same source the archived `/align/targets`
  route used server-side via `listFavourites()`; no new backend route
  needed), RUNNING/READY badge, N-burst `<select>` (1-5, `x-model.number`),
  reply-wait `<input type=number>` (5-120s, `@change="alignSetReplyWindow()"`).
  All three controls disable while `alignBursting()||alignSending`.
- **Warning line**: `x-show="alignModel?.warning"` — e.g. `"No replies — try
  again."` when a burst lands nothing. No reading is invented for a silent burst.
- **Current reading card**: border flips to `border-success` when
  `current.isBest`. Quality (Display value), label, tone class (`cls`) all
  read directly off `alignModel.current` — no local computation. Trend line
  (`trendDir`/`trendDelta`), best-line (`gapToBest`/`bestN`/`bestAgo`),
  YAGI/OMNI secondary quality (`yagi_q`/`omni_q`, rendered `—` when `null`,
  **never `0`** — a radio hearing nothing is a gap, not a zero, mt-transport's
  explicit instruction), raw rssi/snr.
- **Reading bars**: one per `alignModel.readings[]` entry, height =
  `barPct%` (the one place this file computes a CSS value from data, per
  STYLE_GUIDE §7's inline-style exception for genuinely runtime-computed
  values) — `bg-success` when `isBest`, `bg-primary` when `isCurrent`, else
  neutral. ★ marks the best.
- **Actions**: PING (disabled while bursting/sending/no target; shows a
  spinner + `"GATHERING got/of"` while a burst is active) and End (disabled
  unless `alignRunning()`).

## Invariants

- Never renders as, or alongside, the chat message feed (`tab-messages.html`)
  — command traffic is not chat, even though it rides on Meshtastic text
  messages underneath (Peter, 2026-07-25 — see task
  `custom-app-extension-point` notes).
- Renders exactly what `controlMixin` computes; no verb list, unit filter, or
  confirmation logic lives in this file.
- Yagi Align renders exactly what `alignMixin` computes — no quality/trend/
  best/bar math anywhere in this file, same discipline as the Command
  sub-tab, per `docs/modules/app-align.md`.

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

Yagi Align verified live 2026-07-25 against a real, already-running align
session: target picker adopted the live target without a click, RUNNING
badge correct, a real PING against BNCH showed the bursting UI (disabled
controls, "GATHERING 0/4" spinner) and recovered correctly to the
"No replies — try again." warning state (BNCH's wake window is narrow —
expected per mt-transport, not a bug). Both themes screenshotted and read.
A real landed reading and its bar/quality rendering were not observed — no
on-air reading has landed for either test unit yet (mt-transport's own
caveat); re-verify once one does.

**Real bug found and fixed during this task**: the N-burst `<select>`
displayed `1` instead of its actual state value (`4`) on initial load — an
`x-model` vs nested `x-for`-generated `<option>` timing race, confirmed via
direct DOM inspection (`.value`), not a screenshot guess. Fixed with an
`x-init` post-mount resync; see `docs/modules/app-align.md` for the full
diagnosis.

## Out of scope

- Any fetch of any kind — see Layout. This page has never made a network GET
  and must not gain one; all data is `pacHostStatus`/`pacHostQueues`, pushed.
