---
module: app-control
source: public/app-control.js
source_hash: 787cd5f725048a9ef4ed5b99202740c54fe1770ec97e7e4a92192d8feaba151e
updated: 2026-07-25
---

# Module: app-control

## Purpose

Control page mixin: pac-host unit picker, shortcut/free-text command send,
receipt display. Presentation only — reads `pacHostStatus`/`pacHostQueues`
(both server-pushed, see `app-ws.js`) and POSTs to `/nodes/:num/pac-command`
(see `docs/modules/pac-command-api.md`) — the only network call this file
ever makes. Decides nothing about verb meaning; the only local logic is
which unit needs an extra confirmation click before sending.

**No fetch for page data, anywhere in this file — a real bug, fixed
2026-07-25 (task `control-queue-push-not-get`).** An earlier version had
`refreshControlLedger()` calling a GET on unit-click and post-send; Peter
caught it ("nothing is displayed... until I send a command... NO GET in the
UI for data streams") and it's gone. `controlLedger()` is now a pure read of
`pacHostQueues`, which `pac-host.js` polls and pushes on its own.

## Public interface

```js
export const CONTROL_SHORTCUTS       // ['ping','status','config','reboot'] — v1 shortcut verbs
export const controlMixin = {
  controlDevices(),                  // → [{id,num,label}] — pacHostStatus.units filtered to user.role===200 (PAC_ALARM firmware's own self-declared role, task client-role-pac-alarm), never a hardcoded id list
  controlShortcuts(),                // → CONTROL_SHORTCUTS
  controlTargetLabel(),               // → selected unit's display label, or ''
  controlTargetNeedsConfirm(),        // → true iff the selected unit's node id is in the confirm-gate set
  sendControl(verb),                  // → POST /nodes/:num/pac-command {verb}; window.confirm() gate for confirm-targets. No manual refresh after — the pushed queue updates on its own within one poll cycle.
  controlLedger(),                    // → pacHostQueues[controlTarget] || [] — PURE READ of pushed state, zero fetch
  controlReceiptFields(receipt),      // → [{label,text}] — generic key:value pairing of a receipt object (STYLE_GUIDE §5), field ids shown as-is, no guessed meaning
  controlEntryTime(entry),            // → 'YYMMDD-HHMMSS' local time from entry.enqueuedAt (Peter's requested compact format, 2026-07-25), '' if absent
}
```

## State (declared in `app.js`, this mixin's methods read/write it)

`controlTarget` (selected unit num, null initially), `controlVerb`
(free-text input), `controlSending` (bool, disables Send while in flight).
`pacHostQueues` (server-pushed, keyed by unit num) lives at the root — see
`app-ws.js` — not owned by this mixin, only read by `controlLedger()`.

## Invariants

- `controlDevices()` is the **only** filter for "which units are
  commandable" — never a hardcoded node-id list. `GET /v1/mesh/nodes` (what
  `pacHostStatus.units` is sourced from) returns pac-host's *entire*
  mesh-gw-observed roster, not just its own units — verified live 2026-07-25
  (it included node-dash's own gateway radio and an unrelated node, TA2m).
  The `user.role === 200` filter is what narrows it correctly.
- The confirm-gate (`CONFIRM_TARGETS`, currently `{'!987ab80f'}` / GARG) is
  keyed on **node id**, never short name — short names are mutable
  (xsession standing rule) and node ids are not. This is a one-unit safety
  gate Peter explicitly authorized 2026-07-25, not a general precedent for
  special-casing nodes elsewhere.
- No optimistic ledger row on send — `sendControl` does nothing further after
  a successful POST; the new entry appears when `pac-host.js`'s next queue
  poll picks it up and pushes `pac_host_queues` (≤5s). The queue is server
  state end to end; this file never constructs or guesses a row.
- **`CONTROL_SHORTCUTS` IS a hardcoded guess, disclosed not hidden.** Copied
  from the archived design's own placeholder ("v1 shortcut verbs — Peter to
  redraw"), which was never finalised there either. It does not restrict
  what can be sent — the free-text path passes any verb through unvalidated
  — it only limits which 4 get a quick button. No known API exposes an
  enumerable verb list (checked API.md, 2026-07-25); open question with
  Peter on how to handle this (drop the shortcuts / keep as an admitted
  guess / ask mt-transport if verbs are enumerable) as of 2026-07-25,
  unresolved.

## Test notes

Verified live 2026-07-25: `controlDevices()` correctly returned exactly
BNCH/GARG despite the roster containing 4 nodes; `sendControl('ping')` on
BNCH round-tripped with no dialog; `sendControl('ping')` on GARG raised
`window.confirm` with the expected message, and dismissing it (not
accepting) left GARG's ledger unchanged — confirmed via the backend route
directly.

## Receipt rendering (task `control-receipt-readable`, 2026-07-25)

`controlReceiptFields()` is generic key:value pairing — it does not know
what `vbat`, `upt`, `agcr` etc. mean, and shows the raw field id as the
label rather than inventing a translation. Raised on xsession
([receipt-schema]) whether pac-host can publish a label/unit schema per
verb, same shape as `[config-schema-api]`'s `fields` array; if/when that
lands, only this function changes (id → label lookup), no template change.

## Out of scope

- Verb validation / autocomplete — pac-host owns verb semantics, this file
  never inspects them beyond "non-empty string".
- Guessing receipt field meaning — see above.
