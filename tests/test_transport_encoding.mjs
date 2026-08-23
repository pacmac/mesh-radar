// relay_observation.transport holds ONE encoding.
//
// mesh-gw changed transport_mechanism from a string enum NAME to its numeric VALUE
// at 2026-08-22 17:06. captureRelayObservation stored the field verbatim, so one
// column ended up holding TRANSPORT_LORA/TRANSPORT_INTERNAL and 0.0/1.0 at once —
// and six queries compare it to a string literal, including snapshot-api.js:109
// which feeds snapshot.distribution on /events.
//
// Found by mesh-gw reading our store, not by us. See
// docs/modules/relay-observation.md.
//
// Asserts BOTH halves, because either alone is a false pass: the stored column,
// and the mapper that keeps it that way.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // A missing driver is a MISTRIAL, not evidence against anybody.
  console.error(`cannot load better-sqlite3: ${e.message}`);
  process.exit(127);
}

const DB = new URL('../data/node-dash.db', import.meta.url).pathname;
let db;
try {
  db = new Database(DB, { readonly: true });
} catch (e) {
  console.error(`cannot open ${DB}: ${e.message}`);
  process.exit(127);
}

let checks = 0;
const fail = [];
const ok = (c, w) => { if (c) checks++; else fail.push(w); };

// ── 1. THE STORED COLUMN ─────────────────────────────────────────────────────
// Every canonical value starts 'TRANSPORT_'. A numeric-looking row is the defect.
const rows = db.prepare(`SELECT transport AS t, COUNT(*) AS n FROM relay_observation GROUP BY transport`).all();
ok(rows.length > 0, 'relay_observation has rows at all');

const bad = rows.filter(r => !String(r.t ?? '').startsWith('TRANSPORT_'));
ok(bad.length === 0,
   `every stored transport is a canonical name — found ${bad.length} other form(s): `
 + bad.map(r => `${JSON.stringify(r.t)} x${r.n}`).join(', '));

// The two that must exist, so a "fix" that deleted rows cannot pass.
const names = new Set(rows.map(r => String(r.t)));
ok(names.has('TRANSPORT_LORA'),     'TRANSPORT_LORA present');
ok(names.has('TRANSPORT_INTERNAL'), 'TRANSPORT_INTERNAL present');

// ── 2. THE MAPPER ────────────────────────────────────────────────────────────
// Guards the ingest path, so the column cannot split again the next time mesh-gw
// changes the wire form.
let normaliseTransport = null;
try {
  ({ normaliseTransport } = await import('../src/relay-observation.js'));
} catch { /* reported below */ }

ok(typeof normaliseTransport === 'function',
   'relay-observation exports normaliseTransport()');

if (typeof normaliseTransport === 'function') {
  // mesh.proto: INTERNAL=0, LORA=1, LORA_ALT1..3=2..4, MQTT=5, MULTICAST_UDP=6,
  // API=7, UNICAST_UDP=8. Verified in the module's own comment.
  const cases = [
    [0,   'TRANSPORT_INTERNAL'], ['0', 'TRANSPORT_INTERNAL'], [0.0, 'TRANSPORT_INTERNAL'],
    ['0.0', 'TRANSPORT_INTERNAL'],
    [1,   'TRANSPORT_LORA'],     ['1', 'TRANSPORT_LORA'],     ['1.0', 'TRANSPORT_LORA'],
    [5,   'TRANSPORT_MQTT'],
    ['TRANSPORT_LORA',     'TRANSPORT_LORA'],      // already canonical, unchanged
    ['TRANSPORT_INTERNAL', 'TRANSPORT_INTERNAL'],
  ];
  for (const [input, want] of cases) {
    const got = normaliseTransport(input);
    ok(got === want, `normaliseTransport(${JSON.stringify(input)}) === ${want}, got ${JSON.stringify(got)}`);
  }

  // ABSENT IS ENUM 0, NEVER "unknown". proto3 omits zero-valued fields, so a
  // missing transport_mechanism means INTERNAL. Getting this wrong would silently
  // reclassify every non-relayed packet.
  ok(normaliseTransport(undefined) === 'TRANSPORT_INTERNAL', 'undefined maps to INTERNAL (proto3 zero-omission)');
  ok(normaliseTransport(null)      === 'TRANSPORT_INTERNAL', 'null maps to INTERNAL');

  // An unknown value is VISIBLE, not passed through. Passing it through is what
  // caused this defect in the first place.
  const unk = normaliseTransport(99);
  ok(typeof unk === 'string' && unk.startsWith('TRANSPORT_') && unk.includes('99'),
     `an unknown enum becomes a visible canonical name, got ${JSON.stringify(unk)}`);
}

for (const f of fail) console.error('FAIL  ' + f);
console.log(`${checks} checks, ${fail.length} failed`
          + ` — ${rows.reduce((a, r) => a + r.n, 0)} rows across ${rows.length} distinct value(s).`);
process.exit(fail.length ? 1 : 0);
