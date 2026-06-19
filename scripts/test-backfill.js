#!/usr/bin/env node
/**
 * Verify backfillFromCache works correctly for:
 *   Case A — node in nodeinfo with valid lat/lon → name + position backfilled
 *   Case B — node in nodeinfo with NULL lat/lon  → name backfilled, position stays null
 *   Case C — node not in nodeinfo               → nothing backfilled, node passes through unchanged
 */

import { getMqttNode } from '../src/db.js';
import { nodeList } from '../src/node-list.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function fakeEvent(num) {
  return {
    type: 'node_update',
    device: '!da5af428',
    data: { num, snr: -5, rssi: -110, device_metrics: { battery_level: 80 } },
  };
}

// ---------------------------------------------------------------------------
// Case A: node with valid lat/lon
// ---------------------------------------------------------------------------
console.log('\nCase A — valid lat/lon');


const NUM_A = 1702416949; // R2 / G6OMT/P, lat=50.64, lon=-3.38
const cachedA = getMqttNode(NUM_A);
assert('nodeinfo row exists', !!cachedA, JSON.stringify(cachedA));
assert('has short_name', !!cachedA?.short_name);
assert('lat is valid', cachedA?.lat != null && Math.abs(cachedA.lat) <= 90, String(cachedA?.lat));
assert('lon is valid', cachedA?.lon != null && Math.abs(cachedA.lon) <= 180, String(cachedA?.lon));

nodeList._cache.clear();
nodeList.handleNodeUpdate(fakeEvent(NUM_A));
const entryA = nodeList._cache.get(NUM_A);

assert('node entered cache', !!entryA);
assert('short_name backfilled', entryA?.user?.short_name === cachedA.short_name, entryA?.user?.short_name);
assert('long_name backfilled', entryA?.user?.long_name === cachedA.long_name, entryA?.user?.long_name);
assert('latitude_i synthesised', entryA?.position?.latitude_i === Math.round(cachedA.lat * 1e7), String(entryA?.position?.latitude_i));
assert('longitude_i synthesised', entryA?.position?.longitude_i === Math.round(cachedA.lon * 1e7), String(entryA?.position?.longitude_i));
assert('altitude carried', entryA?.position?.altitude === cachedA.alt, String(entryA?.position?.altitude));
assert('_from_cache flag set', entryA?._from_cache === true);

// ---------------------------------------------------------------------------
// Case B: node with NULL lat/lon (was -1000, now cleaned to NULL)
// ---------------------------------------------------------------------------
console.log('\nCase B — NULL lat/lon (no position)');

const NUM_B = 1121930827; // Isca / Isca~Yagi, lat=NULL after cleanup
const cachedB = getMqttNode(NUM_B);
assert('nodeinfo row exists', !!cachedB);
assert('has short_name', !!cachedB?.short_name);
assert('lat is NULL', cachedB?.lat == null, String(cachedB?.lat));

nodeList._cache.clear();
nodeList.handleNodeUpdate(fakeEvent(NUM_B));
const entryB = nodeList._cache.get(NUM_B);

assert('node entered cache', !!entryB);
assert('short_name backfilled', entryB?.user?.short_name === cachedB.short_name, entryB?.user?.short_name);
assert('position is null/undefined (no bogus coords)', entryB?.position == null, JSON.stringify(entryB?.position));
assert('_from_cache flag set', entryB?._from_cache === true);

// ---------------------------------------------------------------------------
// Case C: node not in nodeinfo at all
// ---------------------------------------------------------------------------
console.log('\nCase C — node not in nodeinfo');

const NUM_C = 9999999999; // guaranteed not to exist
const cachedC = getMqttNode(NUM_C);
assert('getMqttNode returns null', cachedC === null);

nodeList._cache.clear();
nodeList.handleNodeUpdate(fakeEvent(NUM_C));
const entryC = nodeList._cache.get(NUM_C);

assert('node entered cache', !!entryC);
assert('no user synthesised', entryC?.user == null, JSON.stringify(entryC?.user));
assert('no position synthesised', entryC?.position == null, JSON.stringify(entryC?.position));
assert('_from_cache not set', !entryC?._from_cache);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
