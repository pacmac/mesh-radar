---
module: inferences
source: src/inferences.js
source_hash: b843676ead9cdc7eb3dd939ea32e00f1b82d6a78650c695d9b5917785d95f341
updated: 2026-08-02
---

# Module: inferences

## Purpose

**The catalogue — every value node-dash works out rather than is told.** Read it
top to bottom and you have seen everything the system infers.

Peter, 2026-08-02: *"the hooks should be a seperate file, so it's easy to see our
calculated functions in 1 place, the file will grow as we think of new things to
get / extract. so each will be a small func that does one thing."*

**Empty today, deliberately** — see Scope.

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

## Scope of this task (`observatory-inference-catalogue-boundary`)

Created **empty**, with the boundary test corrected first.

The test previously asserted that *only* `index.js` may import the engine — the
rule stated slightly wrong. A catalogue must call `registerInference`, so it
would have been rejected, and the boundary would have been loosened under
pressure from code that already existed. **Widening a boundary test to admit code
that is already written is how boundaries die.** Widened here first, with nothing
waiting on it, so it is a decision rather than a consequence.

## Public interface

None. The module registers on import and exports nothing.

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

- Any actual inference. The first is expected to be the antenna-bearing estimate
  (task `record-antenna-bearing-on-reception`). Note its capture half is **not**
  an inference — recording where the antenna pointed is an *observation*. Only
  the estimate derived from many such observations belongs here.
- The runner. It arrives with the first inference that needs it.
