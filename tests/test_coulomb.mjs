// Pure tests for the coulomb display model. No network, no database.
//
// The grst refusal is the reason this file exists. NO grst ROW HAS EVER BEEN
// STORED — measured 2026-08-08 across all 1000 stored BNCH rows (n x500,
// cons x500, nothing else). So the one path that prevents a fabricated current
// cannot be exercised against production data, and a synthetic fixture is the
// only honest way to prove it works. Recorded as such in docs/modules/coulomb.md.
//
// Run: node tests/test_coulomb.mjs

import assert from 'node:assert';
import { buildCoulomb, coulombModel } from '../src/coulomb.js';

// The model is reached DIRECTLY, through the pure entry point that exists for
// exactly this reason (docs/modules/coulomb.md — "THIS SPLIT IS LOAD-BEARING").
//
// These tests used to stub global.fetch and call buildCoulomb, reaching the
// model through getObs. On 2026-08-13 getObs became an unconditional 501 — the
// history has no source and must not be faked (src/alarm-host.js:651-660) — and
// all 8 tests failed on a refusal that is CORRECT. A test of the arithmetic had
// been coupled to a transport it never meant to exercise.
//
// Spec: docs/modules/check-harness.md
let FIXTURE = [];

let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fails.push(name); }
}

// pac-host stamps MILLISECONDS. Every fixture below uses ms deliberately, so a
// regression that forgets the conversion fails here rather than on a page.
const H = 3600_000;
const T0 = 1786000000000;
const row = (at, field, value) => ({ id: 1, unit: '!test', at, field, value });

// ── the arithmetic ──────────────────────────────────────────────────────────
await t('rate is (n1-n0)/hours over the widest span', async () => {
  FIXTURE = [row(T0, 'n', 10), row(T0 + 2 * H, 'n', 30)];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.state, 'has_samples');
  assert.strictEqual(m.current.refused, false);
  // (30-10)/2h = 10.0
  assert.strictEqual(m.current.value_text, '10.0 counts/h');
});

await t('milliseconds are converted to seconds exactly once', async () => {
  FIXTURE = [row(T0, 'n', 1), row(T0 + H, 'n', 2)];
  const m = coulombModel('!test', FIXTURE);
  // T0 ms -> seconds. A missed conversion leaves the ms value here.
  assert.strictEqual(m.latest.at, Math.floor((T0 + H) / 1000));
  assert.ok(m.latest.at < 2e10, `looks like milliseconds leaked through: ${m.latest.at}`);
});

// ── the refusal, which real data cannot exercise ────────────────────────────
await t('a span crossing a grst REFUSES rather than returning a number', async () => {
  FIXTURE = [
    row(T0,           'n', 100),
    row(T0 + 1 * H,   'grst', 1),   // gauge came back zeroed here
    row(T0 + 2 * H,   'n', 5),
  ];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.current.refused, true, 'must refuse across a reset');
  assert.strictEqual(m.current.value_text, null, 'must not report a value');
  assert.match(m.current.refused_reason, /reset/i);
  assert.deepStrictEqual(m.breaks, [Math.floor((T0 + H) / 1000)]);
});

await t('without the reset the SAME endpoints do produce a number', async () => {
  // The negative control for the test above: if this also refused, the refusal
  // test would be passing for the wrong reason.
  FIXTURE = [row(T0, 'n', 100), row(T0 + 2 * H, 'n', 5)];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.current.refused, false);
  assert.strictEqual(m.current.value_text, '-47.5 counts/h');
});

// ── the ordering guard ──────────────────────────────────────────────────────
await t('a DESCENDING list throws instead of flipping the sign', async () => {
  FIXTURE = [row(T0 + 2 * H, 'n', 30), row(T0, 'n', 10)];
  // assert.throws, NOT assert.rejects: coulombModel is synchronous, so rejects
  // would be handed a non-promise and pass without the guard ever running.
  assert.throws(() => coulombModel('!test', FIXTURE), /out of order/i);
});

// ── the states ──────────────────────────────────────────────────────────────
await t('an empty series is unknown_gauge, NOT "not fitted"', async () => {
  FIXTURE = [];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.state, 'unknown_gauge');
  assert.strictEqual(m.current, null);
  assert.strictEqual(m.latest, null);
  // The wording must not assert an absence of hardware we have not been told about.
  assert.doesNotMatch(m.empty_reason, /\bnot fitted\b/i);
  assert.match(m.empty_reason, /has not reported/i);
});

await t('one sample refuses a rate and says why', async () => {
  FIXTURE = [row(T0, 'n', 7)];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.state, 'has_samples');
  assert.strictEqual(m.latest.n, 7);
  assert.strictEqual(m.current.refused, true);
  assert.match(m.current.refused_reason, /needs two/i);
});

// ── cons is carried but never promoted ──────────────────────────────────────
await t('cons is served for cross-check and is not the headline', async () => {
  FIXTURE = [row(T0, 'n', 10), row(T0, 'cons', 1), row(T0 + H, 'n', 20), row(T0 + H, 'cons', 2)];
  const m = coulombModel('!test', FIXTURE);
  assert.strictEqual(m.cons_latest, 2);
  assert.strictEqual(m.latest.n, 20, 'the headline reading must be n');
  assert.strictEqual(m.series.length, 2, 'the series must be n only');
});

// ── the fetching entry point refuses, and that is behaviour ─────────────────
await t('buildCoulomb refuses rather than inventing a series', async () => {
  // getObs throws 501 by design: `record` is unbuilt, and accumulating the
  // event stream here would draw a chart that starts at the last restart and
  // looks like a measurement (src/alarm-host.js:651-660). Asserted rather than
  // stubbed around — if this ever stops throwing, the refusal was removed and
  // the fetching path needs tests of its own.
  await assert.rejects(() => buildCoulomb('!test'), /no history store|record.*unbuilt/i);
});

console.log(fails.length ? `\n${fails.length} failure(s)` : `\n${pass} checks, coulomb model clean.`);
process.exit(fails.length ? 1 : 0);
