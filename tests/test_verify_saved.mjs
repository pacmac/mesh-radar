// verifySaved: "saved & verified" has to be earned.
//
// Three Save buttons reported "saved & verified" while nothing compared anything
// — including on saves that had just failed, and on read-backs taken while the
// device was RECONNECTING and returning the OLD value.
//
// The three states exist because two would still be a lie. `mismatch` is the only
// one that means something went wrong; `unconfirmed` is the EXPECTED path, since
// the radio reboots after most saves.
//
// See docs/modules/app-config.md → "Saved & verified now means something".

import assert from 'node:assert/strict';
import { verifySaved } from '../public/app-forms.js';

let checks = 0;
const is = (got, want, why) => { assert.deepEqual(got, want, why); checks++; };
const state = (sent, back, want, why) => is(verifySaved(sent, back).state, want, why);

// ── the happy path ──────────────────────────────────────────────────────────
state({ blue: 199, red: 23 }, { blue: 199, red: 23 }, 'verified',
      'every sent field matches');

// A FIELD WE DID NOT SEND IS NOT OUR BUSINESS. mesh-gw returns whatever the
// section holds; comparing fields we never wrote would fail every partial save.
state({ blue: 199 }, { blue: 199, red: 23, green: 38 }, 'verified',
      'extra fields in the read-back are ignored');

// ── mismatch — the state that must never be silent ──────────────────────────
state({ blue: 199 }, { blue: 146 }, 'mismatch', 'a differing value is a mismatch');

const m = verifySaved({ blue: 199, red: 23 }, { blue: 146, red: 23 });
is(m.diffs, [{ field: 'blue', sent: 199, radio: 146 }],
   'the diff names the field, what was sent and what the radio holds — an error '
 + 'that does not say WHICH field sends the operator back to the form to guess');

// ── unconfirmed — expected, not a failure ───────────────────────────────────
state({ blue: 199 }, null, 'unconfirmed', 'no read-back at all is unconfirmed');
state({ blue: 199 }, undefined, 'unconfirmed', 'undefined read-back is unconfirmed');

// ABSENCE IS NOT DISAGREEMENT. A field sitting at its default is omitted from the
// GET entirely, and the gw may simply not have re-read yet. Calling this a
// mismatch would cry wolf on the commonest benign case, and an alarm that fires
// on the normal path is one nobody reads.
state({ blue: 199, red: 23 }, { red: 23 }, 'unconfirmed',
      'a sent field absent from the read-back is unconfirmed, NOT a mismatch');

// A real difference outranks a missing field — otherwise a mismatch could hide
// behind an absence in the same section.
state({ blue: 199, red: 23 }, { blue: 146 }, 'mismatch',
      'a genuine difference wins over a missing field');

// ── the traps that produced false results when measured ─────────────────────
// Measured: not stripping these reported 8 spurious mismatches across 21 sections.
state({ blue: 199 }, { blue: 199, __reboot: true, __notes: ['x'] }, 'verified',
      '__reboot and __notes are presentation metadata, not settings');
state({ __reboot: true, blue: 199 }, { blue: 199 }, 'verified',
      '__-prefixed keys are skipped on the SENT side too');

// A select's DOM value is a string; the schema's is a number. 199 and "199" are
// the same setting, and treating them as different would fail every dropdown save.
state({ blue: 199 }, { blue: '199' }, 'verified', 'number vs string compares loosely');
state({ blue: '199' }, { blue: 199 }, 'verified', 'and in the other direction');
state({ enabled: true }, { enabled: false }, 'mismatch', 'booleans are still strict');

// Loose numerics must not swallow a real difference.
state({ blue: 199 }, { blue: '146' }, 'mismatch', '"146" is not 199');

// ── structured values ───────────────────────────────────────────────────────
state({ ignore: [1, 2, 3] }, { ignore: [1, 2, 3] }, 'verified', 'arrays compare by value');
state({ ignore: [1, 2, 3] }, { ignore: [1, 2] },    'mismatch', 'a shorter array is a mismatch');
state({ map: { a: 1 } },     { map: { a: 1 } },     'verified', 'nested objects compare structurally');
state({ map: { a: 1 } },     { map: { a: 2 } },     'mismatch', 'nested difference is caught');

// ── degenerate input ────────────────────────────────────────────────────────
state({}, {}, 'verified', 'sending nothing is trivially verified');

console.log(`${checks} checks — verified / unconfirmed / mismatch, and mismatch names the field.`);
process.exit(0);
