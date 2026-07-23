// capture-api: the grab-reply classifier. Pure, no radio. See docs/modules/capture-api.md.
import assert from 'node:assert';
import { classifyGrabReply, handleGrabReply, pendingGrabCount } from '../src/capture-api.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ', name); pass++; }
                          catch (e) { console.log('  FAIL', name, '\n       ', e.message); fail++; } };

t('grab success -> captured, carries pid (no ok field needed)', () => {
  const r = classifyGrabReply('{"type":"grab","pid":55366,"len":2250,"n":10,"crc":"65FBD5D9","cam":"asleep"}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'captured');
  assert.strictEqual(r.reply.pid, 55366);
});

t('cam grab err -> capture_failed, NO pid, carries st', () => {
  const r = classifyGrabReply('{"type":"err","msg":"cam grab","st":2,"len":0,"max":32768}');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'capture_failed');
  assert.strictEqual(r.reply.st, 2);
  assert.ok(r.reply.pid == null, 'a failed capture must not yield a pid');
});

t('grab with no pid -> NOT captured (never invent a pid)', () => {
  const r = classifyGrabReply('{"type":"grab","cam":"asleep"}');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'capture_failed');
});

t('unrecognised reply on our id -> capture_failed, not success', () => {
  const r = classifyGrabReply('{"type":"pong"}');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'capture_failed');
});

t('garbage / non-JSON -> capture_failed, does not throw', () => {
  const r = classifyGrabReply('not json at all');
  assert.strictEqual(r.state, 'capture_failed');
});

t('handleGrabReply ignores an unknown reply_id (nothing pending)', () => {
  assert.strictEqual(handleGrabReply(12345, '{"type":"grab","pid":1}'), false);
  assert.strictEqual(pendingGrabCount(), 0);
});

t('handleGrabReply ignores a null reply_id', () => {
  assert.strictEqual(handleGrabReply(null, '{"type":"grab","pid":1}'), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
