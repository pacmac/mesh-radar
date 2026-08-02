---
module: inferences
source: src/inferences.js
source_hash: 40b65d47ec055a663e4a2a3bc4c0c41e047a83fd40e6ebbb996954ce04575bf9
updated: 2026-08-02
---

# Module: inferences

## Purpose

**The catalogue — every value node-dash works out rather than is told.** Read it
top to bottom and you have seen everything the system infers.

Peter, 2026-08-02: *"the hooks should be a seperate file, so it's easy to see our
calculated functions in 1 place, the file will grow as we think of new things to
get / extract. so each will be a small func that does one thing."*

**Four inferences today**, all batch, all recomputed on boot and every 15 minutes:

| key | produces |
|---|---|
| `relay.usage` | the doors — traffic carried and targets behind each relay |
| `reach.target` | per target: km, bearing, attempts, hits, verified |
| `reach.ladder` | one global fact: every moment the frontier moved |
| `link.observed` | every witnessed node-to-node hop, both ends placed |

All four read `obs_v_traceroute` — a view over `traceroute_history`, so they run
over five weeks of history that already existed and spend no airtime.

## The split from the engine

This file is **domain code**. It knows what a bearing is, what a node is, what a
relay is. `observatory.js` knows none of that and must never learn
(`docs/modules/observatory.md`, `MESH_REACH_SPEC` §7f).

That split is what keeps the engine testable without a radio and reusable beyond
this project. It is enforced by `tests/test_observatory_boundary.mjs`, which
permits exactly **two** importers of the engine: `index.js` (the composition
root) and this catalogue.

The catalogue is not core. It is a plugin that registers with the engine, in the
same way `alarm-sections.js` registers a `node_status` section.

## The rules every inference obeys

1. **Pure.** A function of the evidence it is handed and nothing else. No
   database, no clock, no randomness, no network.
2. **Small, and one thing.** If it does two things it is two inferences.
3. **`null` is a real answer.** "Not enough evidence yet" is returned, never
   thrown, never faked as a zero.
4. **No provenance by hand.** The runner stamps what produced a value, when, and
   from how much evidence. An inference that writes its own provenance can
   launder itself as a fact.
5. **Graduation.** When a function outgrows a page it moves to its own file and
   is imported and registered here. This file stays the index.

### Why purity is enforced rather than requested

It is the rule most likely to be broken for convenience, and breaking it fails
nothing else — the code would work. But an inference that reaches for the
database cannot be recomputed over history and cannot be tested without a
database, which destroys the retroactive property the registry exists for: *write
the estimator in October, run it over July's data*.

So the test asserts it directly:

- `inferences.js` must not import `db.js`
- no `Date.now(`, `new Date(`, or `Math.random(` outside comments

If an inference needs more evidence, it **declares** it and the runner fetches
it.

## Evidence is declared, not fetched

The design problem this layer exists to solve. An inference cannot query without
destroying its purity — and with it the ability to recompute over history. The
engine cannot query on its behalf without learning what a route is.

So an inference **declares** its evidence as SQL, the engine executes it
understanding nothing (exactly as a driver does), and `run(rows)` stays a pure
function of what came back. The SQL is domain knowledge and lives here, with the
inference that owns it.

`json_each` earns its keep: it expands the route array inside a JSON payload
inside a view over a table nobody migrated, turning stored traceroutes into a
graph in SQL with no parsing in JavaScript.

## Scope of the founding task (`observatory-inference-catalogue-boundary`)

Created **empty**, with the boundary test corrected first.

The test previously asserted that *only* `index.js` may import the engine — the
rule stated slightly wrong. A catalogue must call `registerInference`, so it
would have been rejected, and the boundary would have been loosened under
pressure from code that already existed. **Widening a boundary test to admit code
that is already written is how boundaries die.** Widened here first, with nothing
waiting on it, so it is a decision rather than a consequence.

## Public interface

None. The module registers on import and exports nothing.

## `reach.mission` — what to try next, and why

The memory §2 says the prober does not have: *"the machine is not selecting; it
is iterating."*

**§9 was mis-framed and this inference is the correction.** Peter, 2026-08-02:
*"why is everything blocked by something else meaning that this will never be
completed?"* — §9 had been treated as a block on the whole Missions panel. It is
not. node-dash **already dispatches traceroutes itself** (`traceroute.js:128`,
`passive-tracer.js:122` — 21,793 over five weeks, from both radios). No new
authority is needed to govern sending that is already happening ungoverned. Only
the **broadcast callout** is contested, and that is one instrument of three.

This inference spends no airtime. It ranks; it does not send.

### Evidence starts from `nodes`, not from the traceroute view

That LEFT JOIN is the whole point. It is the difference between *"which target we
have tried deserves another go"* and *"what have we never looked at"*. Measured
2026-08-02: **213 positioned nodes have never been attempted once**, 39 of them
beyond the 189.1 km record — while **423 attempts went to a single node with no
position that has never answered**. The pool the prober never saw is where the
information is.

### Classes

| class | meaning | quota |
|---|---|---|
| `unknown-record` | never attempted, and beyond the record | 8 |
| `record` | attempted, no reply, and beyond the record | 5 |
| `reconfirm` | verified past 100 km, untried for ≥ 7 days | 4 |
| `unknown` | never attempted | 3 |

**A portfolio, not a sort.** Ranked purely by score the shortlist came back as
twenty rows of *"never attempted, and would beat the 189 km record"* — the
highest information gain, and useless as a mission list. One class swamping the
panel hides the record attempts already in flight and the frontier corridors
going stale, which are different kinds of work that want doing in parallel. So
each class gets a quota and keeps its own internal ranking. The quotas are a
judgement about balance, stated in the code rather than buried in a score.

Within `record`, rank decays with attempts (`-6` each, capped at `-120`). §4 says
silence proves nothing; it does not say silence is free, and the twentieth silent
attempt is worth less than the second.

### Every mission carries its reason as a string

Written by the inference, not assembled by the page (`BROWSER_CONTRACT`). A
ranked list with no stated reason is a magic number wearing a table.

### Exclusions are published, not silent

`COOLDOWN` 24 h — Peter's *"not so much as to become a nuisance"* with a number
attached. This is the **only** rate rule the selector owns; a real budget belongs
to whatever dispatches, which is not this.

`CEILING_KM` 250 — beyond this a self-reported position is a claim, not evidence.
250 rather than §12's 200 because a mission may legitimately aim *past* the
frontier — that is the point — but a node claiming 1,681 km is a bad coordinate,
not a target.

A `global` summary fact reports candidates, shown, and the cooling / suspect /
exhausted counts. First live run: **19 of 227 candidates, 7 cooling, 125 suspect,
22 exhausted.** A shortlist that quietly drops most of the pool reads as "these
are the only options".

### Our own radios are excluded via `from_num`, not `nodes.device`

The first attempt used `n.device IS NULL`, which is a different thing entirely:
`device` is the MAC of the radio that **heard** the node, so it is set on 903
nodes and the filter cut the pool from 601 to 3 — with a `0 km` record to match.
`from_num` is the addressee of a traceroute reply and is only ever one of ours
(measured: TA2o, TA2y, GARG, nothing else).

## Invariants

- Every inference in node-dash is registered here or imported here. One place.
- No `db.js` import, no clock, no randomness.
- The engine never imports this file. The dependency runs one way.

## Test notes

`node tests/test_observatory_boundary.mjs` — each guard proved reached by
planting a violation and confirming the failure, then restoring:

| planted | failure |
|---|---|
| `import` in `src/node-label.js` | *"may be imported only by index.js and inferences.js. Found in: node-label.js"* |
| `import db from './db.js'` here | *"must not import db.js… the runner fetches evidence, the inference does not"* |
| `Date.now()` here | *"must be pure — found `/\bDate\.now\(/` outside a comment"* |

## Out of scope

- **The antenna-bearing estimator.** Its capture half is not an inference —
  recording where the antenna pointed is an *observation* — and the estimate
  itself is **blocked on data, not on code**: measured 2026-08-02, 305 recorded
  bearings span **two distinct azimuths, 119° and 120°**, because the rotator has
  not moved. An estimator over that would place every unplaced node at 119°, a
  confident wrong answer. It needs the antenna to sweep first.
- Anything that transmits. `MESH_REACH_SPEC` §9 is unanswered, and none of the
  four inferences here sends anything.
