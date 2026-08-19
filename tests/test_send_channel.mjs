// A send names its channel as a WORD, or it is refused.
//
// THE ORIGINAL DEFECT. `sendMeshText` built its request as
// `const body = { text, channel }`. JSON.stringify DROPS an undefined key, so a
// caller who omitted `channel` sent a body with no channel at all, and the
// gateway applied its own default of 0. Zero is a PRIMARY — the public mesh.
// Forget an argument, broadcast to strangers, have it recorded as a normal send.
//
// THE SECOND DEFECT, 2026-08-19. The fix for the first accepted an INDEX, and an
// index means different things on different radios: private is 2 on the OMNI and
// 1 on the YAGI, and index 1 on the OMNI is `mqtt`, unencrypted. Peter: "you need
// to know nothing about channels, channel indexes, PSKs, PKI, all you need to
// know is public and private." docs/modules/channels.md.
//
// So an integer is now refused as firmly as an absent field. The gateway would
// still honour one, which is exactly why accepting it here is dangerous: it would
// be right on whichever radio you happened to test with.
//
// This asserts every refusal WITHOUT TRANSMITTING — each rejected case throws
// before the fetch, which is what makes it safe in the `fast` group with no radio
// and no network.
import assert from 'node:assert/strict';

const { sendMeshText } = await import('../src/mesh-send.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

// If any of these reached the network the test would hang or throw a fetch error
// rather than the guard's message — so the assertion is on the MESSAGE, not just
// that something threw.
async function refuses(args, what) {
  let err = null;
  try { await sendMeshText({ gatewayNodeId: 'E9:B0:3F:17:27:91', text: 'x', ...args }); }
  catch (e) { err = e; }
  ok(err !== null, `${what}: must throw`);
  ok(/channel must be 'public' or 'private'/.test(err?.message ?? ''),
     `${what}: must be the channel guard, got: ${err?.message}`);
}

await refuses({},                     'channel omitted entirely');
await refuses({ channel: undefined }, 'channel undefined');
await refuses({ channel: null },      'channel null');

// THE INDEX CASES — the whole point of this revision. Each of these was legal
// before 2026-08-19 and each is a per-radio number that cannot be right on both.
await refuses({ channel: 0 },   'index 0 — was legal, is PRIMARY, and is now a word');
await refuses({ channel: 1 },   'index 1 — Private on the YAGI, mqtt on the OMNI');
await refuses({ channel: 2 },   'index 2 — Private on the OMNI only');
await refuses({ channel: '0' }, 'index as a string');

// Near-misses, so a typo cannot slip through as a valid word.
await refuses({ channel: 'Public' },  'capitalised — the contract is lower case');
await refuses({ channel: 'PRIVATE' }, 'upper case');
await refuses({ channel: 'priv' },    'abbreviated');
await refuses({ channel: '' },        'empty string');
await refuses({ channel: 'pri' },     'the OLD internal role name must not work');
await refuses({ channel: 'pub' },     'likewise pub');

// AND THE TWO THAT MUST PASS THE GUARD. They are expected to fail LATER, at the
// network — this test runs with no gateway — so the assertion is that whatever
// comes back is NOT the channel guard. Asserting a specific network error would
// bind the test to the failure mode of an absent server.
for (const word of ['public', 'private']) {
  let err = null;
  try { await sendMeshText({ gatewayNodeId: 'E9:B0:3F:17:27:91', text: 'x', channel: word }); }
  catch (e) { err = e; }
  ok(!/channel must be/.test(err?.message ?? ''),
     `'${word}' must pass the channel guard, got: ${err?.message}`);
}

console.log(`${checks} checks — a channel is 'public' or 'private'; every index and near-miss refused.`);
process.exit(0);
