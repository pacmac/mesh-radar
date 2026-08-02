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
const ROOT = 'index.js';                       // the composition root
const MODULE = 'observatory.js';

const offenders = [];
for (const file of readdirSync(SRC).filter(f => f.endsWith('.js'))) {
  if (file === ROOT || file === MODULE) continue;
  const body = readFileSync(join(SRC, file), 'utf8');
  // Match an import of the module, not the word in prose — the comments in
  // several core files legitimately discuss plugin boundaries.
  if (/from\s+['"]\.\/observatory\.js['"]|import\s+['"]\.\/observatory\.js['"]/.test(body)) {
    offenders.push(file);
  }
}

assert.deepEqual(
  offenders, [],
  `observatory must be imported ONLY by the composition root (${ROOT}). ` +
  `Found in: ${offenders.join(', ')}. Core emits; it does not reach in.`,
);

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

console.log('PASS observatory boundary: one import from the composition root, db.js only inward, seam unused');
