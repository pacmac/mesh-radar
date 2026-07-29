---
module: alarm-sections
source: src/alarm-sections.js
source_hash: 71d27e8ae20f162159a78a0d92e7863f549dbe0a58d37d92d4f7a3f8afd33170
updated: 2026-07-29
---

# Module: alarm-sections

## Purpose

**ALARM PLUGIN — not core.** Contributes the `reachability` section to `node_status`
for pac-host units. Delete this file and its one import in `index.js` and node-dash
is unchanged.

Peter, 2026-07-29: *"node-dash exists with or without the alarm. alarm is addative,
it changes nothing about node communications, stats, messages … the alarm is a
plugin … alarm related code is supposed to be self contained and not mixed in with
core."*

This module exists because commit `1f8842b` put all of it INSIDE
`src/node-status.js` — a core module that builds `node_status` for **any** node in
the mesh — giving core a hard `pac-host` import and 164 lines of alarm logic. That
breached `reference/alarm-integration/INVENTORY.md`: *"code must not be copied back
into shared dashboard modules."* Task `alarm-plugin-boundary-restore` moved it out.

## Responsibilities

- Read pac-host's unit for a node num (`unitForNum`) and build a `value_grid`
  section from it: delivery, next window, beat, window, wake reliability, awake,
  TX radio, and per-radio reception rows
- Return `null` when pac-host holds no unit for that num
- Self-register with core via `registerNodeSection`

## Dependencies

- `node-status.js` — `field`, `compact`, `registerNodeSection` (host services only)
- `pac-host.js` — `unitForNum` (the plugin's own boundary module)
- `format.js`, `node-label.js`, `db.js` — shared formatting/identity helpers

## Public interface

None. The module self-registers on import and exports nothing. `index.js` does
`import('./alarm-sections.js')` at startup and never references it again.

## The contract, one way only

```
core  →  registerNodeSection(fn)   — knows nothing about what fn is for
here  →  returns a section, or null
```

A `null` contributes nothing, which makes **"no plugin installed"** and **"this
plugin has nothing to say about this node"** the same code path. That is why core
needs no `if (alarmPresent)` anywhere.

`ctx.perRadio` is passed IN by core, never re-queried here. It comes from
`stmts.latestDirectPerRadio` and is the same array the header's Signal tile is
built from — re-querying would turn the header↔section agreement established in
`cc2e55f` back into a coincidence.

## State

_N/A — pure function of pac-host's last poll plus the context core passes in._

## Events emitted

_N/A_

## Invariants

- **Core must never import, name or branch on this module.** The only permitted
  reference is `index.js`'s single import — the composition root is the one place
  allowed to know a plugin exists.
- Every field states its kind and its age, or states that it has neither. `Beat`,
  `Window`, `Awake` and `TX radio` render **undated** because pac-host records no
  `<field>At` for them; they must not borrow another field's instant or be stamped
  with `now()`.
- `acks: null` renders "not yet asked", never a blank and never a failure —
  Peter must be able to tell *not yet asked* from *asked and got nothing*.
- `wakesExpected: null` omits the field entirely; `0` renders a bare count. Neither
  path divides.
- Delivery keeps five numbers, never one boolean.
- pac-host instants are epoch **milliseconds**; `msToSec` does the divide once, at
  this boundary.

Full rationale for each: `docs/REACHABILITY_SPEC.md`.

## Test notes

- Contents were **moved verbatim** from `node-status.js` and diffed to prove it:
  163 lines removed, 163 moved, zero differences. The payload had to be identical
  and changing nothing was the only way to be sure.
- Plugin-absent test, 2026-07-29: with `index.js`'s import commented out and
  node-dash restarted, GARG returned
  `[device_vitals, signal, environment, air_quality, detections]` — reachability
  gone, nothing else altered — and two core nodes were section-identical to their
  pre-change baseline. No load errors. Wiring restored; section returned.
- This is a **stricter** test than stopping pac-host, and it does not touch the
  live alarm gateway.

## Out of scope

- Anything about non-alarm nodes. This module is called for every node and must
  return `null` for all but pac-host units.
- The header's Signal / Least hops / Verified hops tiles — **pure core**
  (`signal_history`, `messages`, `traceroute_history`), no alarm dependency.
- `src/ws-relay.js`'s pac-host couplings — seven of them, six pre-dating this
  work. A larger boundary problem, recorded in the `bugs` ledger.
