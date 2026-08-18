// interval-options: the phone app's curated allowlists, asserted.
//
// The point of this module is that a value which breaks the radio cannot be
// ENTERED, which is how the app achieves what Peter called "works 100% of the
// time". These assertions guard the properties that make that true.
//
// See docs/modules/interval-options.md.

import assert from 'node:assert/strict';
import {
  INTERVAL_CONFIGURATIONS, FIELD_CONFIGURATION,
  optionsFor, decorateSchema, intervalLabel,
} from '../src/interval-options.js';

let checks = 0;
const eq = (a, b, w) => { assert.deepEqual(a, b, w); checks++; };
const ok = (c, w) => { assert.ok(c, w); checks++; };

// ── the ported tables ───────────────────────────────────────────────────────
eq(Object.keys(INTERVAL_CONFIGURATIONS).length, 17,
   'all 17 IntervalConfiguration members ported from FixedUpdateIntervals.kt');
ok(Object.values(INTERVAL_CONFIGURATIONS).every(a => a.length > 0),
   'every configuration resolves to a non-empty list — an empty one would render '
 + 'a select with nothing in it and silently block the field');
ok(Object.values(INTERVAL_CONFIGURATIONS).flat().every(Number.isInteger),
   'every option value is an INTEGER. A string here would be sent as "1800" where '
 + 'the protobuf needs an int — a wrong-typed value shipped while fixing '
 + 'wrong-valued ones');

// THE BUG THE GENERATOR FOUND. The app's ALL is `FixedUpdateIntervals.entries` —
// enum DECLARATION order — and four members were appended after ALWAYS_ON, so it
// ends 2147483647, 80, 90, 8, 40. The hand-port wrote it ASCENDING: same 34
// values, tidied. Asserting the tail is what makes a re-sort go red, and a re-sort
// is exactly what a well-meaning editor does to this list.
eq(INTERVAL_CONFIGURATIONS.ALL.slice(-5), [2147483647, 80, 90, 8, 40],
   'ALL is in declaration order, NOT sorted — see docs/modules/interval-tables.md');
eq(INTERVAL_CONFIGURATIONS.ALL.length, 34, 'all 34 enum members appear in ALL');

// THE NUMBER THAT TIES THIS TO THE FIRMWARE. mesh-gw's /schema hand-transcribes
// "min 1800 (firmware-enforced)" for the telemetry intervals. 1800 is exactly the
// first entry of the app's BROADCAST_SHORT — same constraint, from the source that
// owns it rather than a comment.
eq(INTERVAL_CONFIGURATIONS.BROADCAST_SHORT[0], 1800,
   'BROADCAST_SHORT starts at 1800, matching the firmware-enforced minimum');

// ── labels ──────────────────────────────────────────────────────────────────
eq(intervalLabel(0), 'unset', '0 is UNSET, not "0 seconds"');
eq(intervalLabel(2147483647), 'always on', 'Int.MAX_VALUE is ALWAYS_ON');
eq(intervalLabel(1800), '30 minutes', 'minutes where they divide exactly');
eq(intervalLabel(3600), '1 hour', 'singular hour, not "1 hours"');
eq(intervalLabel(45), '45 seconds', 'seconds otherwise');

// ── the field map ───────────────────────────────────────────────────────────
ok(Object.values(FIELD_CONFIGURATION).every(c => c in INTERVAL_CONFIGURATIONS),
   'every mapped field points at a configuration that exists');
eq(optionsFor('telemetry', 'device_update_interval').length, 13,
   'telemetry intervals get BROADCAST_SHORT (13 options)');

// AN UNMAPPED FIELD IS LEFT ALONE. Inventing an allowlist for a field nobody
// curated would be the mirror of the bug this fixes, and harder to notice.
eq(optionsFor('telemetry', 'environment_screen_enabled'), null,
   'an unmapped field gets no options');
eq(optionsFor('nosuchsection', 'device_update_interval'), null,
   'the map is keyed by section.field — the same field name in another section '
 + 'does not inherit the mapping');

// ── decorateSchema ──────────────────────────────────────────────────────────
const before = {
  fields: [
    { name: 'device_update_interval', type: 'int', unit: 'seconds', min: 1800, hint: 'x' },
    { name: 'environment_screen_enabled', type: 'bool' },
  ],
};
const after = decorateSchema('telemetry', before);
const mapped = after.fields[0];

eq(mapped.type, 'choice', 'a mapped interval becomes a choice, not an int');
eq(mapped.options[0], { value: 1800, label: '30 minutes' }, 'options carry value AND label');
// EVERY numeric-entry advisory goes, not just min/max. Caught in the browser:
// the dropdown still carried "min 1800 (firmware-enforced); 0 = use default
// (3600 s)" over a list starting at 1800 that cannot express 0, and a "seconds"
// unit beside a value reading "30 minutes".
for (const k of ['min', 'max', 'hint', 'unit'])
  ok(!(k in mapped), `${k} is dropped from a choice — it describes numeric entry, `
   + 'which this control no longer is');
eq(after.fields[1], before.fields[1], 'an unmapped field is returned untouched');
eq(before.fields[0].type, 'int', 'the input schema is NOT mutated');

// `choice`, deliberately not `enum`: enum options are bare strings used as both
// value and label, so reusing it would emit "1800" instead of 1800.
ok(mapped.type !== 'enum', 'choice is a distinct type from enum');

console.log(`${checks} checks — 17 configurations, integer options, unmapped fields untouched.`);
process.exit(0);
