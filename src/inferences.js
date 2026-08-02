// The catalogue — every value this system works out rather than is told.
//
// Peter, 2026-08-02: "the hooks should be a seperate file, so it's easy to see
// our calculated functions in 1 place, the file will grow as we think of new
// things to get / extract. so each will be a small func that does one thing."
//
// Read this file top to bottom and you have seen everything node-dash infers.
// That is the whole point of it being one file, and it is worth protecting: an
// inference that lives anywhere else is invisible.
//
// THIS FILE IS DOMAIN CODE. It knows what a bearing is, what a node is, what a
// relay is. The engine (observatory.js) knows none of that and must never learn
// — the split is what keeps the engine testable and reusable, and it is enforced
// by tests/test_observatory_boundary.mjs, which permits exactly two importers of
// the engine: the composition root, and this catalogue.
//
// ─── THE RULES EVERY INFERENCE OBEYS ────────────────────────────────────────
//
// 1. PURE. A function of the evidence it is handed and nothing else. No database
//    access inside, no clock, no randomness, no network.
//
//    This is not a style preference and it is the rule most likely to be broken
//    for convenience. An inference that reaches for the database itself cannot
//    be recomputed over history, cannot be tested without a database, and
//    silently destroys the retroactive property that is the entire reason the
//    registry exists (MESH_REACH_SPEC §7f). If an inference needs more evidence,
//    it DECLARES it and the runner fetches it.
//
// 2. SMALL, AND ONE THING. If it does two things it is two inferences.
//
// 3. `null` IS A REAL ANSWER. "Not enough evidence yet" is returned, never
//    thrown and never faked as a zero — a plausible wrong value is worse than an
//    absent one.
//
// 4. NO PROVENANCE BY HAND. The runner stamps what produced a value, when, from
//    how much evidence. An inference that writes its own provenance can launder
//    itself as a fact.
//
// 5. GRADUATION. When a function outgrows a page — peak-RSSI bearing estimation
//    with windowing and outlier rejection will — it moves to its own file and is
//    imported and registered here. This file stays the index either way.
//
// ─── THE CATALOGUE ──────────────────────────────────────────────────────────
//
// EMPTY, DELIBERATELY. Created by task
// `observatory-inference-catalogue-boundary` so the boundary is correct BEFORE
// there is an inference pressing on it. Widening a boundary test to admit code
// that already exists is how boundaries die; widening it first, with nothing
// waiting, makes it a decision instead of a consequence.
//
// The first entry is expected to be the antenna-bearing work (task
// `record-antenna-bearing-on-reception`, MESH_REACH_SPEC §7c/§7e). Note that its
// capture half is NOT an inference — recording where the antenna pointed is an
// observation. Only the estimate derived from many such observations belongs
// here.
import { registerInference } from './observatory.js';

// Referenced so the import is not "unused" to a reader or a linter, and so the
// first contributor has the function in front of them rather than having to go
// and find it.
void registerInference;

// registerInference({
//   key:  'bearing.peak_rssi',
//   deps: [],
//   mode: 'batch',
//   run: (evidence) => { ... return { value, confidence, evidence_count } | null },
// });
