---
module: app-control
source: public/app-control.js
source_hash: 4799cd8373f3a1fd7c831a160ba578cef7a0dd586083e3c8f465604ab2fb055d
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
  switchControlTab(name),             // → sets controlTab + persists (task control-section-ia); Summary/Command/Config/Stats/Yagi Align/Chat sub-tabs, same shape as switchCfgTab. No data load — skeleton tabs have nothing to fetch.
  controlDevices(),                  // → [{id,num,label,present}] — pacHostStatus.units mapped directly (GET /mesh/devices is already ours-only, task control-devices-endpoint), never a hardcoded id list
  controlShortcuts(),                // → CONTROL_SHORTCUTS
  controlTargetLabel(),               // → selected unit's display label, or ''
  controlTargetNeedsConfirm(),        // → true iff the selected unit's node id is in the confirm-gate set
  sendControl(verb),                  // → POST /nodes/:num/pac-command {verb}; window.confirm() gate for confirm-targets. No manual refresh after — the pushed queue updates on its own within one poll cycle.
  controlLedger(),                    // → pacHostQueues[controlTarget] || [], newest-first — PURE READ of pushed state, zero fetch, zero re-derivation of time (entry.since is already server-formatted)
  controlPending(),                   // → controlLedger() filtered to status === 'pending' (in flight, not yet resolved)
  controlExecuted(),                  // → controlLedger() filtered to status !== 'pending' (reached a terminal outcome: acked, cancelled, or failed)
  controlReceiptFields(receipt),      // → [{label,text}] — generic key:value pairing of a receipt object (STYLE_GUIDE §5), field ids shown as-is, no guessed meaning
}
```

## State (declared in `app.js`, this mixin's methods read/write it)

`controlTarget` (selected unit num, null initially), `controlVerb`
(free-text input), `controlSending` (bool, disables Send while in flight).
`pacHostQueues` (server-pushed, keyed by unit num) lives at the root — see
`app-ws.js` — not owned by this mixin, only read by `controlLedger()`.

## Invariants

- `controlDevices()` reads `pacHostStatus.units` directly — never a hardcoded
  node-id list. Source is `GET /v1/mesh/devices` (task
  `control-devices-endpoint`, 2026-07-25), which pac-host already scopes to
  our alarm devices only — no local filter needed. Supersedes the earlier
  approach (`GET /v1/mesh/nodes`, pac-host's *entire* mesh-gw-observed
  roster — it once included node-dash's own gateway radio and an unrelated
  node, TA2m — narrowed here via a `user.role === 200` filter). `present`
  (`u.present !== false`, defaults true if the field is ever absent) is
  threaded through so the UI can distinguish a known-but-asleep unit from a
  live one — per mt-transport (xsession `[devices-live]`): a device must not
  disappear from the picker because it slept, so `controlDevices()` never
  filters on `present`, only surfaces it for `tab-control.html` to dim.
- The confirm-gate (`CONFIRM_TARGETS`, currently `{'!987ab80f'}` / GARG) is
  keyed on **node id**, never short name — short names are mutable
  (xsession standing rule) and node ids are not. This is a one-unit safety
  gate Peter explicitly authorized 2026-07-25, not a general precedent for
  special-casing nodes elsewhere.
- No optimistic ledger row on send — `sendControl` does nothing further after
  a successful POST; the new entry appears when `pac-host.js`'s next queue
  poll picks it up and pushes `pac_host_queues` (≤5s). The queue is server
  state end to end; this file never constructs or guesses a row.
- `entry.since` (the relative "Ns/Nm/Nh/Nd ago" display string) is pushed by
  `pac-host.js` — computed server-side from `fmtAgo()` each 5s poll cycle,
  never client-computed. Task `control-since-and-pending-split`, 2026-07-25:
  Peter replaced the earlier `YYMMDD-HHMMSS` absolute stamp ("that is more
  easily readable to a human") — BROWSER_CONTRACT requires relative-time
  values be server-formatted and pushed, not recomputed by a browser timer,
  so this reuses the existing `node_status_age`/`fmtAgo()` precedent rather
  than adding a new per-connection timer (queue data already refreshes every
  5s, which is enough granularity for this display).
- Newest-first ordering (`controlLedger()`) is a display-only sort over
  already-pushed data — pac-host's own ledger array is oldest-first (verified
  live 2026-07-25), which read as "random" to Peter until sorted here.
- Pending/Executed split (`controlPending()`/`controlExecuted()`) replaces
  the single "Queue" list, 2026-07-25 — Peter: "queue is the wrong label...
  that is executed. so we need pending and executed." Split is on
  `entry.status === 'pending'` vs not, verified against the real live ledger
  (observed values: pending, acked, cancelled, failed).
- **`CONTROL_SHORTCUTS` IS a hardcoded guess, disclosed not hidden — and
  confirmed the right call for now.** Copied from the archived design's own
  placeholder ("v1 shortcut verbs — Peter to redraw"), which was never
  finalised there either. It does not restrict what can be sent — the
  free-text path passes any verb through unvalidated — it only limits which
  4 get a quick button. Raised on xsession 2026-07-25: no verb-enumeration
  API exists (device `help`/`cmds` is known stale — omits the cam/chunk/
  push/camu surface, tracked as mt-transport's `command-help-sync`); their
  explicit answer was **"keep your 4 shortcuts for now."** A future
  `GET /v1/mesh/verbs` is possible but not started — node-dash's stated
  preference (also on xsession) is UI-sensible verbs only (no transfer
  internals like `chunk`/`push`) and a flat no-arg list, no per-verb args
  schema, since free text already covers arg-taking verbs.

## Test notes

Verified live 2026-07-25: `controlDevices()` correctly returned exactly
BNCH/GARG (originally despite the `/mesh/nodes` roster containing 4 nodes,
role-filtered; re-verified after the `/mesh/devices` swap the same day, now
returning exactly 2 with no filter needed); `sendControl('ping')` on BNCH
round-tripped with no dialog; `sendControl('ping')` on GARG raised
`window.confirm` with the expected message, and dismissing it (not
accepting) left GARG's ledger unchanged — confirmed via the backend route
directly. `present:false` dimming (`tab-control.html`) verified by code
inspection only — both real units were `present:true` throughout testing,
never observed rendered in the dimmed state.

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
