// Unit tests for src/transport-plugin.js — the optional alarm-transport seam.
//
// Run: node tests/test_transport_plugin.mjs      (exits non-zero on failure)
//
// The other tests here are Python integration tests against a live service.
// This one is a JS unit test because the subject is a JS module contract, and
// the two paths that matter most — a real implementation present, and a broken
// one — cannot be exercised from Python.

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = '../src/transport-plugin.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// Each case needs a pristine module-level singleton AND a fresh env, so the
// loader re-resolves. _resetForTests() clears the cache; the import itself is
// cached by Node, which is fine — the singleton is what we care about.
async function fresh(envPath) {
  const m = await import(MOD);
  m._resetForTests();
  if (envPath) process.env.MT_TRANSPORT_PATH = envPath;
  else delete process.env.MT_TRANSPORT_PATH;
  return m;
}

console.log('transport-plugin');

await t('absent: resolves, unavailable, every capability off', async () => {
  const m = await fresh(null);
  const tr = await m.loadTransport();
  assert.strictEqual(tr.available, false);
  assert.ok(m.CAPABILITIES.every(c => !tr.can(c)));
});

await t('present: can() true for exactly the exported subset', async () => {
  const m = await fresh(path.join(HERE, 'fixtures/transport-good.mjs'));
  const tr = await m.loadTransport();
  assert.strictEqual(tr.available, true, 'should have loaded the fixture');
  assert.strictEqual(tr.can('configSet'), true);
  assert.strictEqual(tr.can('debug260'), true);
  assert.strictEqual(tr.can('tilt256'), true);
  // Must name a capability that COULD be advertised. Asserting on a removed name
  // ('chunkFetch') passes vacuously — it can never be advertised again, so the test
  // would keep passing even if the allow-list stopped being enforced.
  assert.strictEqual(tr.can('chunkPush'), false, 'not exported => not advertised');
  assert.strictEqual(tr.can('pullQueue'), false);
});

await t('present: a capability call passes through its result', async () => {
  const m = await fresh(path.join(HERE, 'fixtures/transport-good.mjs'));
  const tr = await m.loadTransport();
  const r = await tr.configSet(42, 'alarm.threshold', 9);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'applied');
  assert.deepStrictEqual(r.value, { num: 42, path: 'alarm.threshold', value: 9 });
});

await t('present: a throwing capability normalises, does not propagate', async () => {
  const m = await fresh(path.join(HERE, 'fixtures/transport-good.mjs'));
  const tr = await m.loadTransport();
  const r = await tr.tilt256();          // fixture throws
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'error');
  assert.match(r.error, /sensor offline/);
});

await t('broken: degrades to null object, does not throw', async () => {
  const m = await fresh(path.join(HERE, 'fixtures/transport-broken.mjs'));
  const tr = await m.loadTransport();    // must not reject
  assert.strictEqual(tr.available, false);
  assert.ok(m.CAPABILITIES.every(c => !tr.can(c)));
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
