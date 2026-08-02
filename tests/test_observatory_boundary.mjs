// The observatory boundary, as a test rather than a promise.
//
// docs/MESH_REACH_SPEC.md §7f: the engine must be referenced from exactly ONE
// place in src/ — the composition root. Core emits, the engine consumes; core
// never imports an inference, never queries the engine mid-flow, never branches
// on its presence.
//
// THIS TEST EXISTS BECAUSE THE RULE HAS BEEN STATED AND BROKEN HERE BEFORE.
// docs/PLUGIN_BOUNDARY_SPEC.md was written after 164 lines of alarm logic landed
// in core node-status.js; task `ws-relay-plugin-boundary` was opened after
// pac-host reached the browser through core ws-relay.js. Both were caught by a
// person reading code, months late. check_specs cannot catch this class of
// defect — only a test can.
//
// Run: node tests/test_observatory_boundary.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const MODULE = 'observatory.js';

// EXACTLY TWO FILES MAY IMPORT THE ENGINE, and the list is explicit so that
// adding a third is a visible decision rather than a silent drift.
//
//   index.js       the composition root — the one place allowed to know a
//                  plugin exists, same rule the alarm imports obey
//   inferences.js  the catalogue of domain calculations. It is NOT core; it is
//                  a plugin that registers with the engine, exactly as
//                  alarm-sections.js registers a node_status section.
//
// The rule this encodes is "CORE must not reach into the engine". An earlier
// version of this test said "only index.js", which was the rule stated slightly
// wrong — it would have rejected the catalogue and forced the boundary to be
// loosened under pressure from code that already existed. Widened here first,
// with nothing waiting on it (task `observatory-inference-catalogue-boundary`).
//   observatory-ws.js  the engine's own WS wiring — a plugin, exactly as
//                      alarm-ws.js is the alarm's. ws-relay.js (core) still does
//                      not name the observatory; this file does, and core does
//                      not name this file.
const ALLOWED = new Set(['index.js', 'inferences.js', 'observatory-ws.js']);

const offenders = [];
for (const file of readdirSync(SRC).filter(f => f.endsWith('.js'))) {
  if (ALLOWED.has(file) || file === MODULE) continue;
  const body = readFileSync(join(SRC, file), 'utf8');
  // Match an import of the module, not the word in prose — the comments in
  // several core files legitimately discuss plugin boundaries.
  if (/from\s+['"]\.\/observatory\.js['"]|import\s+['"]\.\/observatory\.js['"]/.test(body)) {
    offenders.push(file);
  }
}

assert.deepEqual(
  offenders, [],
  `observatory may be imported only by ${[...ALLOWED].join(' and ')}. ` +
  `Found in: ${offenders.join(', ')}. Core emits; it does not reach in.`,
);

// The catalogue must stay PURE — no database, no clock, no randomness. An
// inference that reaches for the database cannot be recomputed over history and
// cannot be tested without one, which destroys the retroactive property the
// registry exists for (MESH_REACH_SPEC §7f). Enforced here because it is the
// rule most likely to be broken for convenience, and because breaking it fails
// nothing else.
const catalogue = readFileSync(join(SRC, 'inferences.js'), 'utf8');
const catalogueImports = [...catalogue.matchAll(/from\s+['"]\.\/([\w-]+\.js)['"]/g)].map(m => m[1]);
assert.deepEqual(
  catalogueImports.filter(i => i === 'db.js'), [],
  'inferences.js must not import db.js. An inference is a pure function of the ' +
  'evidence it is handed; the runner fetches evidence, the inference does not.',
);
for (const banned of [/\bDate\.now\(/, /\bnew Date\(/, /\bMath\.random\(/]) {
  assert.equal(
    banned.test(catalogue.replace(/^\s*\/\/.*$/gm, '')), false,
    `inferences.js must be pure — found ${banned} outside a comment. ` +
    'A clock or a random source makes an inference unrepeatable over stored history.',
  );
}

// The engine must not reach back the other way either. It may read db.js — it is
// handed the shared database by design (§7f, "the database is shared") — but it
// must not import anything that knows what a node or a packet is.
const engine = readFileSync(join(SRC, MODULE), 'utf8');
const imports = [...engine.matchAll(/from\s+['"]\.\/([\w-]+\.js)['"]/g)].map(m => m[1]);
assert.deepEqual(
  imports, ['db.js'],
  `observatory may import db.js and nothing else from src/. Found: ${imports.join(', ')}. ` +
  `A domain import here is the boundary leaking inward.`,
);

// _resetInferences is a test seam. If production code starts calling it, the
// registry has become mutable at runtime and inference ordering stops being
// deterministic.
const seamUsers = readdirSync(SRC).filter(f => f.endsWith('.js') && f !== MODULE)
  .filter(f => /_resetInferences/.test(readFileSync(join(SRC, f), 'utf8')));
assert.deepEqual(seamUsers, [], `_resetInferences is a test seam; called in: ${seamUsers.join(', ')}`);

console.log(
  'PASS observatory boundary: importers limited to ' + [...ALLOWED].join(' + ') +
  ', db.js only inward, seam unused, catalogue pure',
);
