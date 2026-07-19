// Unit tests for src/transport-adapter.js — the mt-transport facade mapping.
//
// Run: node tests/test_transport_adapter.mjs
//
// These use hand-built module namespaces rather than the real mt-transport,
// deliberately: this suite must pass on a machine where that repo is absent.
// The real-module integration is asserted separately at the bottom, and SKIPS
// (not fails) when the module is not installed.

import assert from 'node:assert';
import { adaptMtTransport, looksLikeMtTransport, closeClients } from '../src/transport-adapter.js';

// A fake that mirrors the REAL Client contract, verified against
// mt-transport/clients/node/index.js:21-66,128:
//   constructor({host, gatewayId, channel, ...})   — channel 0/unset throws
//   async connect()
//   async fetch(target, pid, {timeoutMs, batch})   — POSITIONAL
//   close()
//
// The first version of this fake took `{channel, gatewayNodeId, send}` and
// `fetch({target, pid})`, which is not the real API at all. Every test passed
// and the adapter would have thrown on its first real call. A fake that does not
// mirror the contract tests nothing — it tests the fake.
function FakeClient(spy = {}) {
  return class {
    constructor(o) {
      if (o.channel === 0) throw new Error('channel 0 (PRIMARY) is forbidden');
      if (o.channel === undefined || o.channel === null) throw new Error('channel must be given explicitly');
      spy.ctor = o;
      spy.instances = (spy.instances ?? 0) + 1;
    }
    async connect() { spy.connected = true; }
    async fetch(target, pid, opts) { spy.fetchArgs = [target, pid, opts]; return Buffer.from('jpegbytes'); }
    close() { spy.closed = true; }
  };
}

let pass = 0, fail = 0, skip = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) {
    if (e?.__skip) { console.log(`  skip ${name} — ${e.message}`); skip++; return; }
    console.log(`  FAIL ${name}\n       ${e.message}`); fail++;
  }
}
const skipIf = (msg) => { const e = new Error(msg); e.__skip = true; throw e; };

console.log('transport-adapter');

await t('empty module advertises nothing', () => {
  assert.deepStrictEqual(adaptMtTransport({}), {});
});

await t('parse260 only => debug260 present, chunkFetch absent', () => {
  const caps = adaptMtTransport({ parse260: () => ({ type: 'debug' }) });
  assert.ok(typeof caps.debug260 === 'function');
  assert.strictEqual(caps.chunkFetch, undefined);
});

await t('Client only => chunkFetch present, debug260 absent', () => {
  const caps = adaptMtTransport({ Client: FakeClient() });
  assert.ok(typeof caps.chunkFetch === 'function');
  assert.strictEqual(caps.debug260, undefined);
});

await t('debug260 wraps the parse result in the house shape', () => {
  const caps = adaptMtTransport({ parse260: () => ({ type: 'debug', boot: 3 }) });
  const r = caps.debug260(Buffer.from('{}'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'applied');
  assert.deepStrictEqual(r.value, { type: 'debug', boot: 3 });
});

// The rule Peter stated with no exceptions. Both the omitted and the explicit-zero
// case must fail, because `channel` defaults to 0 across the Meshtastic API —
// the unset value is the dangerous one.
const ARGS = { target: '336b', pid: 1, channel: 2, host: 'localhost:8000', gatewayId: '!2687afb1' };

await t('chunkFetch REFUSES channel 0 (PRIMARY)', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  await assert.rejects(() => caps.chunkFetch({ ...ARGS, channel: 0 }), /PRIMARY/);
});

await t('chunkFetch REFUSES an omitted channel', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  const { channel, ...noChannel } = ARGS;
  await assert.rejects(() => caps.chunkFetch(noChannel), /explicitly/);
});

await t('chunkFetch REFUSES a missing host or gatewayId', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  const { gatewayId, ...noGw } = ARGS;
  await assert.rejects(() => caps.chunkFetch(noGw), /host and gatewayId/);
});

await t('chunkFetch uses the REAL Client contract (ctor object + positional fetch)', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  const r = await caps.chunkFetch(ARGS);

  assert.deepStrictEqual(spy.ctor, { host: 'localhost:8000', gatewayId: '!2687afb1', channel: 2 });
  assert.strictEqual(spy.connected, true, 'connect() must be awaited before fetch');
  assert.deepStrictEqual(spy.fetchArgs.slice(0, 2), ['336b', 1], 'fetch is positional');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.toString(), 'jpegbytes');
});

// mt-transport measured batch 16 as never completing on real hardware (35 s deaf
// window, device restarts from the first gap). Inheriting their default would
// mean every node-dash fetch hangs. This test exists so that default cannot
// silently come back.
await t('chunkFetch defaults batch to 4, NOT the module default of 16', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  await caps.chunkFetch(ARGS);                    // no batch supplied
  assert.strictEqual(spy.fetchArgs[2].batch, 4);
});

await t('chunkFetch honours an explicit batch override', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  await caps.chunkFetch({ ...ARGS, batch: 8 });
  assert.strictEqual(spy.fetchArgs[2].batch, 8);
});

await t('chunkFetch reuses one Client per (host,gatewayId,channel)', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  await caps.chunkFetch(ARGS);
  await caps.chunkFetch({ ...ARGS, pid: 2 });
  assert.strictEqual(spy.instances, 1, 'must not open a socket per fetch');
  await caps.chunkFetch({ ...ARGS, channel: 3 });
  assert.strictEqual(spy.instances, 2, 'a different channel is a different client');
  closeClients();
  assert.strictEqual(spy.closed, true, 'closeClients() must close them');
});

await t('looksLikeMtTransport recognises either marker', () => {
  assert.strictEqual(looksLikeMtTransport({ Client: class {} }), true);
  assert.strictEqual(looksLikeMtTransport({ parse260: () => {} }), true);
  assert.strictEqual(looksLikeMtTransport({}), false);
  assert.strictEqual(looksLikeMtTransport(null), false);
});

// Integration — skips cleanly when mt-transport is not installed, so this suite
// stays green on a machine that only has stock Meshtastic.
await t('real module maps to exactly [debug260, chunkFetch]', async () => {
  const p = process.env.MT_TRANSPORT_PATH;
  if (!p) skipIf('MT_TRANSPORT_PATH not set');
  let m;
  try { m = await import(p); } catch { skipIf('module not importable'); }
  const caps = Object.keys(adaptMtTransport(m)).sort();
  assert.deepStrictEqual(caps, ['chunkFetch', 'debug260']);
});

console.log(`\n${pass} passed${skip ? `, ${skip} skipped` : ''}${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
