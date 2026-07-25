---
module: app-align
source: public/app-align.js
source_hash: 995dd860deaf2caa7144f29463dcc200e43430f25f81c1b23b31beda43360678
updated: 2026-07-25
---

# Module: app-align

## Purpose

Yagi Align mixin — antenna-alignment sub-tab of Control (`controlTab==='align'`
in `tab-control.html`). Presentation only (`docs/BROWSER_CONTRACT.md`): renders
the pushed align view-model (`alignModel`, from `pac_host_align` — see
`app-ws.js`) and computes nothing. Every derived value (`quality`, `label`,
`cls`, `trendDir`, `trendDelta`, `best`, `gapToBest`, `bestAgo`, `barPct`) is
pac-host's job now (API.md "Antenna alignment").

**Rebuilt, not merely restored, from the archived
`reference/alarm-integration/public/app-align.js`** (task `yagi-align-rebuild`,
2026-07-25, following Peter's go-ahead — "so have you built the aligne
frontend as I dont see it?"). The archive was a **standalone, framework-free**
`/align` page, deliberately avoiding Alpine so a phone at the mast stayed
operational if a CDN was unreachable. That constraint does not apply here:
Alpine is vendored locally in this dashboard (`public/vendor/alpinejs-3.15.12.min.js`),
never CDN-loaded, so this is a normal Alpine mixin like every other Control
sub-tab. The standalone `/align` route is retired, not preserved alongside —
confirmed explicitly with Peter mid-task ("this should be part of node dash
and not a standalone server / port" → "in the new submenu we added").

## Responsibilities

- Hold the three browser-originated raw inputs (same invariant the archive
  stated): `alignTarget` (adopted from favourites/model, user-overridable),
  `alignNBurst` (1-5, default 4), `alignReplyWinInput` (5-120s, default 30,
  synced from the model's `replyWindowSec` once pushed).
- POST those values to `/align/ping`, `/align/stop`, `/align/config`
  (`src/pac-align-api.js`) — the browser's only sanctioned writes for this
  feature.
- Provide trivial, non-deriving read accessors (`alignTargets()`,
  `alignBursting()`, `alignRunning()`, `alignTargetLabel()`) — direct field
  reads or simple boolean coercions, never math/formatting/quality logic.

## Dependencies

- `app-helpers.js` — `fetchJSON`.
- Root state (`app.js`): `alignModel`, `alignTarget`, `alignNBurst`,
  `alignReplyWinInput`, `alignSending`, `favourites` (owned by
  `app-nodes.js`'s domain, read here as the target list).
- `app-ws.js` — `pac_host_align` handler assigns `alignModel` and adopts
  `alignTarget`/`alignReplyWinInput` from the pushed model.
- `uiMixin.showToast` — action-failure feedback only, never used to display
  align state itself.

## Public interface

```js
export const alignMixin = {
  alignTargets(),                // → favourites array ({num,label}) — same source the archived /align/targets route used internally (listFavourites()); no new backend route needed, this dashboard already pushes it
  alignTargetLabel(),            // → selected target's label, or ''
  alignBursting(),               // → !!alignModel?.burst?.active
  alignRunning(),                 // → !!alignModel?.running
  alignPing(),                    // → POST /align/ping {target, n}; no-ops while bursting/sending/no target
  alignEnd(),                     // → POST /align/stop
  alignSetReplyWindow(),          // → POST /align/config {replyWindowSec}; fires on the input's @change
}
```

## State (declared in `app.js`)

`alignModel` (server-pushed, null until first `pac_host_align`), `alignTarget`
(node num, null initially — adopted from the live model's `target` or the
first favourite, never overriding an existing user pick, same guard shape as
`controlTarget` in `pac_host_status`'s handler), `alignNBurst` (default 4),
`alignReplyWinInput` (default 30, adopted from the model once pushed),
`alignSending` (disables PING while the POST is in flight).

## Invariants

- **Renders the model; decides nothing** — same as the archive's stated
  invariant, carried forward. No local quality/trend/best/bar computation
  exists anywhere in this file.
- `alignNBurst`/`alignReplyWinInput` are the only browser-originated values
  — raw input, sent as-is, never validated beyond what the `<input>`'s own
  `min`/`max`/`step` attributes enforce; pac-host is the real validator
  (5-120s range, API.md).
- **`yagi_q`/`omni_q` render as `—` when `null`, never `0`** —
  `tab-control.html`'s template checks `==null` explicitly per reading. A
  radio that heard nothing is a gap, not a zero (mt-transport, xsession
  `[align-backend]`: "same class of trap as `sent` vs `done`" — the ledger's
  own equivalent trap, fixed the same day in task `ledger-field-rename`).
- **PASV interlock is NOT in this file.** It lives in `pac-host.js`'s
  `_pollAlign()` (server-side, watching the pushed model's `running`
  transition) — mt-transport explicitly flagged this as node-dash's
  responsibility alone ("we do NOT drive the rotator... If the Yagi moves
  during a burst, the readings are silently wrong"). Documented here only so
  a reader of this file knows where to look; see `docs/modules/pac-host.md`.
- No GET anywhere in this file — `alignModel` is a pure read of pushed
  state, same shape as `pacHostQueues` in `app-control.js`.

## Test notes

Verified live 2026-07-25 against the real pac-host service and a real
already-running align session: target picker correctly showed BNCH/B12PAC
CAR/etc. from `favourites`, adopted the live session's actual target
(`336b 2-260725-20`, num `2364420971`) without a user click, RUNNING badge
correct. Sent a real `/align/ping` (via the PING button) — burst-active UI
(controls disabled, "GATHERING 0/4" spinner) rendered correctly, and after
the burst window elapsed the "No replies — try again." warning rendered
correctly (BNCH's wake window is narrow against the burst duration —
expected per mt-transport, not a bug) with controls correctly re-enabled.
Both themes screenshotted and read. A real landed reading, `/align/stop`,
and `yagi_q`/`omni_q`/bar rendering were **not** observed against real data
in this task — no on-air reading has landed for either test unit yet
(mt-transport's own caveat) — reading-display markup is unexercised beyond
code review. Re-verify once a real reading lands.

**Real bug found and fixed during this task, unrelated to the align model
itself:** the N-burst `<select>` (`x-model.number="alignNBurst"`, options
from a `<template x-for>`) displayed `1` instead of the actual state value
(`4`) on initial page load, confirmed via `getBoundingClientRect`/`.value`
DOM inspection, not a screenshot guess. Root cause: `x-model`'s initial
value-sync ran before the nested `x-for` had finished inserting `<option>`
elements, so the assignment silently failed to match. The target select
(same pattern) didn't show this because its correct value was set later via
a WS-driven reactive update, after the DOM had already settled — not because
the pattern itself was safe. Fixed with `x-init="$nextTick(() => { $el.value
= String(alignNBurst) })"` forcing a post-mount resync.

## Out of scope

- Any computation of signal, quality, best, trend, or bar scaling — all
  pac-host's, per Purpose.
- The standalone `/align` route and its `align.html`/`align.css` — retired,
  archived in `reference/alarm-integration/`, not resurrected.
- Rotator control of any kind, including the PASV interlock (see Invariants
  — that's `pac-host.js`).
