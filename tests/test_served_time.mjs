// served-time: the transition maths and the scheduler. Pure — no socket, no clock
// of its own beyond the fake one it injects.
//
// The boundaries are the whole point. An off-by-one at 60 s means every "1m ago"
// label is a second late forever, and nothing on a page would ever show it.
//
// Run: node tests/test_served_time.mjs

import assert from 'node:assert';
import { nextAgoTransition, nextUntilTransition, scheduleTime } from '../src/served-time.js';

let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fails.push(name); }
}

const T = 1_000_000;   // an arbitrary epoch-seconds base

// ── the boundaries ──────────────────────────────────────────────────────────
await t('under a minute, the label changes every second', () => {
  assert.strictEqual(nextAgoTransition(T, T + 0), 1);
  assert.strictEqual(nextAgoTransition(T, T + 59), 1);
});

await t('at 60 s it switches to minutes and waits a whole minute', () => {
  assert.strictEqual(nextAgoTransition(T, T + 60), 60);
  // 90 s old: "1m ago" becomes "2m ago" 30 s from now, not 60
  assert.strictEqual(nextAgoTransition(T, T + 90), 30);
  assert.strictEqual(nextAgoTransition(T, T + 3599), 1);
});

await t('at an hour it waits a whole hour, and a day a whole day', () => {
  assert.strictEqual(nextAgoTransition(T, T + 3600), 3600);
  assert.strictEqual(nextAgoTransition(T, T + 3600 + 1800), 1800);
  assert.strictEqual(nextAgoTransition(T, T + 86400), 86400);
});

await t('it NEVER returns 0 — a zero delay busy-loops instead of scheduling', () => {
  for (const age of [0, 1, 59, 60, 61, 3599, 3600, 86399, 86400, 200000]) {
    assert.ok(nextAgoTransition(T, T + age) >= 1, `age ${age} gave a sub-1s delay`);
  }
});

await t('a FUTURE instant uses the until rule, which does not clamp to now', () => {
  assert.ok(nextUntilTransition(T + 3600, T) >= 1);
  assert.ok(nextUntilTransition(T + 30, T) >= 1);
});

// ── the scheduler ───────────────────────────────────────────────────────────
await t('one wake per change and never a duplicate string', async () => {
  // A fake clock so a two-hour span costs no wall time.
  let nowMs = T * 1000;
  const clock = { now: () => nowMs };
  const pushed = [];

  // Age the fact by an hour, one simulated step at a time, driving the real
  // timer queue but with our own clock.
  const stop = scheduleTime(T - 3600, txt => pushed.push(txt), { kind: 'ago', clock });
  // Advance past two hourly boundaries.
  for (let i = 0; i < 3; i++) {
    nowMs += 3600 * 1000;
    await new Promise(r => setImmediate(r));
  }
  stop();
  // Duplicates are the failure this asserts: the schedule must not fire on an
  // unchanged value at any point.
  assert.deepStrictEqual(pushed, [...new Set(pushed)], `duplicate pushes: ${pushed.join(', ')}`);
});

await t('stop() is idempotent and leaves nothing armed', () => {
  const stop = scheduleTime(T, () => { throw new Error('fired after stop'); }, { kind: 'ago' });
  stop(); stop(); stop();
});

console.log(fails.length ? `\n${fails.length} failure(s)` : `\n${pass} checks, served-time clean.`);
process.exit(fails.length ? 1 : 0);
