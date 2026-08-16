// A send that does not name its channel is REFUSED.
//
// THE DEFECT THIS ENCODES. `sendMeshText` built its request as
// `const body = { text, channel }`. JSON.stringify DROPS an undefined key, so a
// caller who omitted `channel` sent a body with no channel at all, and the
// gateway applied its own default of 0. Zero is a PRIMARY — the public mesh.
//
// So the failure mode was: forget an argument, broadcast to strangers, and have
// it recorded as an ordinary send. Task `channel-callers-onto-resolver`.
//
// This test asserts the refusal WITHOUT TRANSMITTING. Every rejected case must
// throw before the fetch, which is exactly what makes it safe to run in the
// `fast` group with no radio and no network.
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
  ok(/channel required/.test(err?.message ?? ''),
     `${what}: must be the channel guard, got: ${err?.message}`);
}

await refuses({},                    'channel omitted entirely');
await refuses({ channel: undefined },'channel undefined');
await refuses({ channel: null },     'channel null');
await refuses({ channel: '1' },      'channel as a STRING — "1" is not a slot');
await refuses({ channel: 1.5 },      'channel non-integer');
await refuses({ channel: NaN },      'channel NaN');

// The guard names the way out, so a caller hitting it is told what to do rather
// than left to guess a number.
let msg = '';
try { await sendMeshText({ gatewayNodeId: 'E9:B0:3F:17:27:91', text: 'x' }); }
catch (e) { msg = e.message; }
ok(/indexFor/.test(msg), 'the error points at channels.indexFor rather than suggesting a number');

// 0 IS LEGAL WHEN MEANT. The rule is that a channel must be STATED, not that it
// must be non-zero — callout transmits publicly on purpose. So channel 0 must
// pass the guard and fail later, at the network, not here.
let zeroErr = null;
try {
  await sendMeshText({ gatewayNodeId: 'DE:AD:BE:EF:00:00', text: 'x', channel: 0 });
} catch (e) { zeroErr = e; }
ok(zeroErr === null || !/channel required/.test(zeroErr.message),
   'channel 0 passes the guard — stating 0 is legal, omitting it is not');

console.log(`${checks} checks — an unstated channel is refused before it can reach the mesh.`);
