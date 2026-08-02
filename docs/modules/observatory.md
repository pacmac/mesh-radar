---
module: observatory
source: src/observatory.js
source_hash: c59458a46f7fa597d4ee194711dbaa206a7a52331cf5158fcbbc7a46630a474c
updated: 2026-08-02
---

# Module: observatory

## Purpose

Observations in, derived facts out. A **generic engine** — it does not know what
a node, a bearing, a packet or a mesh is, and must never learn. All domain
knowledge lives in the inferences node-dash registers with it.

Design and rationale: `docs/MESH_REACH_SPEC.md` §7f. This spec covers what was
built; the section covers why.

**Name is provisional** (§7f, open decision 1).

## Scope of this task (`observatory-engine-core`)

Four things, deliberately:

1. `obs_observation` — the observations table
2. `obs_v_traceroute` — one view, proving an existing table reads in the
   observation shape without being copied
3. the inference registry — registration and ordering only
4. `tests/test_observatory_boundary.mjs` — the boundary as a test

**Not built, on purpose:** the facts store, any inference, any runner, any UI.
The facts store arrives with the first inference that needs it; a runner written
before its first consumer would be designed against an imagined caller.

## The boundary

**Three files may import it, and the list is explicit** — `src/index.js` (the
composition root), `src/inferences.js` (the catalogue of domain calculations) and
`src/observatory-ws.js` (the engine's own WS wiring). The latter two are plugins,
not core. Nothing else in `src/` may. Core emits, the engine
consumes — core never queries mid-flow and never branches on its presence.

*The first version of this test said "only `index.js`", which was the rule stated
slightly wrong: it would have rejected the catalogue. Corrected in task
`observatory-inference-catalogue-boundary` **before** any inference existed, so
the widening was a decision rather than a concession to code already written.*

**Enforced by test, not by intention.** This repo has stated the rule twice and
broken it twice: `PLUGIN_BOUNDARY_SPEC.md` exists because 164 lines of alarm
logic landed in core `node-status.js`, and task `ws-relay-plugin-boundary` exists
because pac-host reached the browser through core `ws-relay.js`. Both were caught
by a person reading code, months late. `check_specs` cannot catch this class of
defect.

The test asserts three things: no core file imports the module; the module
imports nothing from `src/` but `db.js`; and `_resetInferences` (a test seam) has
no production caller.

**The import is static and side-effecting**, matching the alarm plugin block
directly above it in `index.js`. That is load-bearing, not stylistic — a
registration made later, inside `listen()`, silently never fires. Measured when
it was late: connect replays still worked and **zero** live broadcasts arrived in
110 s.

## Schema

Tables are prefixed `obs_` so ownership is legible in a shared database. Peter,
2026-08-02: *"we share the node-dash database, we add tables to it. no point in
more than 1 db and a LOT of the data is already in those tables."*

```
obs_observation
  id      INTEGER PK
  ts      INTEGER NOT NULL   -- epoch SECONDS (house convention, format.js)
  kind    TEXT NOT NULL      -- open vocabulary; the engine never branches on it
  entity  TEXT NOT NULL      -- the subject, opaque here
  source  TEXT               -- which producer wrote it
  data    TEXT               -- JSON payload, shape owned by the producer
```

### The envelope is fixed, the payload is not

§7f says observations get fixed columns. **That cannot be literally true**: an
engine forbidden from knowing what a reception is cannot declare a reception's
columns. So the envelope is fixed and typed, and `data` carries the
producer-owned shape as JSON.

This is **not** the anti-pattern §7f warns about. That warning was about
attribute *rows* — one row per field, millions of rows holding the string
`"rssi"`. This is one row per observation. A hot payload field is later promoted
to a generated column indexed over the JSON, which is §7f's "nursery" path: no
data migration, no rewrite.

### Migrations use `PRAGMA table_xinfo`, never `table_info`

`table_info` **omits generated columns**. Since the nursery path creates them, a
`table_info` guard would fail to see a column it had already added and re-`ALTER`
on every boot — the crash loop that took node-dash and DEV1 down once. The rest
of `db.js` still uses `table_info`; that is safe there only because none of those
tables has a generated column yet.

No migrations exist yet. `_columns()` is present so the first one is correct.

## Adapters: existing tables read in place

`obs_v_traceroute` is a **view**, not a copy and not a trigger.
`traceroute_history` stays where it is; the view presents it in the observation
shape with nothing duplicated and nothing to keep in sync.

**This is why §7f's retroactive property is true on day one** rather than after a
migration: an inference written next month reads 21,793 attempts that already
exist. A trigger would have copied, and two rows holding one fact is the SSOT
problem this project keeps paying for.

The view is **domain knowledge and the one deliberate exception in the file** —
it exists to prove the adapter idea against real data. When a second adapter
arrives, both move to a domain-owned module and the engine keeps only machinery.

## Public interface

```js
observe({ ts, kind, entity, source, data })   // append-only; no update, no delete
events                                        // EventEmitter — 'observation' after each write
recentObservations(kind, limit = 200)         // last N of a kind, newest first, capped at 1000
registerInference({ key, deps, mode, run })   // mode: 'incremental' | 'batch'
inferenceOrder()                              // dependency order; throws on cycle or missing dep
inferences()                                  // read-only list
_columns(table)                               // table_xinfo column names
_resetInferences()                            // TEST SEAM — no production caller
```

`run` returns `{value, confidence, evidence_count}` or **`null`**. Null is a real
answer meaning "not enough evidence yet" — never a zero, never a throw.
Provenance is stamped by the runner (when one exists), never by the author, so an
inference cannot launder itself as a fact.

`inferenceOrder()` **throws** on a cycle or an unknown dependency rather than
resolving to something plausible. A silently mis-ordered inference produces a
value that looks correct and was computed from stale inputs — the worst failure
available here.

## Invariants

- The engine never learns what a node, packet, bearing or mesh is.
- Observations are append-only. No `UPDATE`, no `DELETE`.
- `ts` is epoch **seconds**. Callers holding milliseconds divide once, at their
  own boundary — see `docs/modules/pac-host.md` → "Units on this boundary".
- `kind` is an open vocabulary. The engine stores it and never branches on it.
- Migrations use `table_xinfo`.
- Exactly three `src/` files import this module, named in the boundary test.

## Test notes

- `node tests/test_observatory_boundary.mjs` — passes with the three-file allowlist; **proved
  reached** by planting `import { observe } from './observatory.js'` into
  `src/node-label.js` and confirming it fails with *"Found in: node-label.js"*,
  then restoring.
- Live, 2026-08-02: schema builds; `obs_v_traceroute` returns **21,793 rows**
  with nothing copied; a `json_extract` on `$.status` selects `ok` rows and the
  payload's `route` parses back to an array.
- Registry exercised: `a -> b -> c` ordering; duplicate key, bad mode, cycle
  (`x -> y -> x`) and missing dependency all refused with named errors.
- `tests/test_channel_write.mjs` and `tests/test_op_manager.mjs` still pass.
- **NOT verified: that the running service boots with the new import.** pm2 shows
  23 h uptime, 0 restarts, watch **disabled** — the live process has not loaded
  `index.js`. The tables were created by a direct import in a test process. A
  restart is required to prove boot, and is the operator's call.

## Out of scope

- Facts store, inferences, runner, UI — see Scope above.
- Anything that transmits. `MESH_REACH_SPEC` §9 (who owns the transmitter) is
  unanswered and does not block this module, which only reads and records.
