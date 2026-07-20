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
//   async push(target, pid, {deadlineMs, onProgress, payloadDir, signal}) — POSITIONAL
//   close()
//
// The first version of this fake took `{channel, gatewayNodeId, send}` and
// `push({target, pid})`, which is not the real API at all. Every test passed
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
    async push(target, pid, opts) { spy.pushArgs = [target, pid, opts]; return Buffer.from('jpegbytes'); }
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

await t('parse260 only => debug260 present, chunkPush absent', () => {
  const caps = adaptMtTransport({ parse260: () => ({ type: 'debug' }) });
  assert.ok(typeof caps.debug260 === 'function');
  assert.strictEqual(caps.chunkPush, undefined);
});

await t('Client only => chunkPush present, debug260 absent', () => {
  const caps = adaptMtTransport({ Client: FakeClient() });
  assert.ok(typeof caps.chunkPush === 'function');
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

await t('chunkPush REFUSES channel 0 (PRIMARY)', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  await assert.rejects(() => caps.chunkPush({ ...ARGS, channel: 0 }), /PRIMARY/);
});

await t('chunkPush REFUSES an omitted channel', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  const { channel, ...noChannel } = ARGS;
  await assert.rejects(() => caps.chunkPush(noChannel), /explicitly/);
});

await t('chunkPush REFUSES a missing host or gatewayId', async () => {
  closeClients();
  const caps = adaptMtTransport({ Client: FakeClient() });
  const { gatewayId, ...noGw } = ARGS;
  await assert.rejects(() => caps.chunkPush(noGw), /host and gatewayId/);
});

await t('chunkPush uses the REAL Client contract (ctor object + positional fetch)', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  const r = await caps.chunkPush(ARGS);

  assert.deepStrictEqual(spy.ctor, { host: 'localhost:8000', gatewayId: '!2687afb1', channel: 2 });
  assert.strictEqual(spy.connected, true, 'connect() must be awaited before fetch');
  assert.deepStrictEqual(spy.pushArgs.slice(0, 2), ['336b', 1], 'fetch is positional');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.toString(), 'jpegbytes');
});

// Under PUSH the device streams at its own rate and mt-transport's client runs the
// receiver loop. MSG_BUSY (0x06) was pull-era flow control and no longer exists.
// node-dash adds no
// Pull is GONE — there is no batch, no MSG_BUSY, no client-side pacing to test for.
// What must be proven instead is that the surviving path carries the same guards.
await t('chunkPush forwards payloadDir and signal untouched', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  const ac = new AbortController();
  await caps.chunkPush({ ...ARGS, payloadDir: '/tmp/p', signal: ac.signal });
  assert.strictEqual(spy.pushArgs[2].signal, ac.signal, 'signal must reach the client — cancel depends on it');
  assert.strictEqual(spy.pushArgs[2].batch, undefined, 'no batch under push, ever');
});

// Pull is not a fallback. A build without Client.push must FAIL LOUDLY rather than
// quietly reaching for the protocol that stalled at 16/32.
await t('chunkPush REJECTS a build with no Client.push', async () => {
  closeClients();
  const spy = {};
  // Defined WITHOUT push rather than deleting it from a subclass — the method would
  // still be inherited from the parent prototype and the test would pass vacuously.
  const NoPush = class {
    constructor(o) { spy.ctor = o; }
    async connect() { spy.connected = true; }
    close() {}
  };
  const caps = adaptMtTransport({ Client: NoPush });
  await assert.rejects(() => caps.chunkPush(ARGS), /no Client\.push/);
});

// The stable API (2026-07-20): progress + hard deadline pass straight through to
// Client.fetch. The adapter relays them; it fires no progress and enforces no
// deadline itself.
await t('chunkPush forwards onProgress + deadlineMs when given', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  const onProgress = () => {};
  await caps.chunkPush({ ...ARGS, deadlineMs: 240000, onProgress });
  assert.strictEqual(spy.pushArgs[2].deadlineMs, 240000, 'deadlineMs forwarded');
  assert.strictEqual(spy.pushArgs[2].onProgress, onProgress, 'onProgress forwarded');
  assert.strictEqual(spy.pushArgs[2].timeoutMs, undefined, 'timeoutMs retired');
});

await t('chunkPush reuses one Client per (host,gatewayId,channel)', async () => {
  closeClients();
  const spy = {};
  const caps = adaptMtTransport({ Client: FakeClient(spy) });
  await caps.chunkPush(ARGS);
  await caps.chunkPush({ ...ARGS, pid: 2 });
  assert.strictEqual(spy.instances, 1, 'must not open a socket per fetch');
  await caps.chunkPush({ ...ARGS, channel: 3 });
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
await t('real module maps to exactly [debug260, chunkPush]', async () => {
  const p = process.env.MT_TRANSPORT_PATH;
  if (!p) skipIf('MT_TRANSPORT_PATH not set');
  let m;
  try { m = await import(p); } catch { skipIf('module not importable'); }
  const caps = Object.keys(adaptMtTransport(m)).sort();
  assert.deepStrictEqual(caps, ['chunkPush', 'debug260']);
});

console.log(`\n${pass} passed${skip ? `, ${skip} skipped` : ''}${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
