---
module: app-control
source: public/app-control.js
source_hash: 7466791063a8b157de3f51c0016550db933c3d7a0d0551fb0256b9b71635be50
updated: 2026-07-25
---

# Module: app-control

## Purpose

Control page mixin: pac-host unit picker, shortcut/free-text command send,
receipt polling. Presentation only — computes display lists from
`pacHostStatus` (server-pushed, see `app-ws.js`) and posts to
`/nodes/:num/pac-command` (see `docs/modules/pac-command-api.md`). Decides
nothing about verb meaning; the only local logic is which unit needs an
extra confirmation click before sending.

## Public interface

```js
export const CONTROL_SHORTCUTS       // ['ping','status','config','reboot'] — v1 shortcut verbs
export const controlMixin = {
  controlDevices(),                  // → [{id,num,label}] — pacHostStatus.units filtered to user.role===200 (PAC_ALARM firmware's own self-declared role, task client-role-pac-alarm), never a hardcoded id list
  controlShortcuts(),                // → CONTROL_SHORTCUTS
  controlTargetLabel(),               // → selected unit's display label, or ''
  controlTargetNeedsConfirm(),        // → true iff the selected unit's node id is in the confirm-gate set
  sendControl(verb),                  // → POST /nodes/:num/pac-command {verb}; window.confirm() gate for confirm-targets; refreshes the ledger on success
  refreshControlLedger(),             // → GET /nodes/:num/pac-command, assigns controlLedger
  controlReceiptFields(receipt),      // → [{label,text}] — generic key:value pairing of a receipt object (STYLE_GUIDE §5), field ids shown as-is, no guessed meaning
}
```

## State (declared in `app.js`, this mixin's methods read/write it)

`controlTarget` (selected unit num, null initially), `controlVerb`
(free-text input), `controlSending` (bool, disables Send while in flight),
`controlLedger` (array, current unit's queue entries).

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
- No optimistic ledger row on send — `sendControl` calls
  `refreshControlLedger()` after a successful POST rather than guessing the
  new entry's shape; the queue is server state, this file renders what it's
  given.

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
