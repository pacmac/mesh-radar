// node_filters.node_source hardcoded the literal strings 'yagi'/'omni' as its
// only two filterable buckets, and scanActive forced the literal 'yagi' — a
// deployment with a different radio count, or none mounted on a rotator at
// all, could not be filtered correctly. Peter, 2026-10-11: "nobody ever said
// there would be 1,2,3 or any number of radios or that any of them would be
// directional with a rotator." idiot entry
// node-source-filter-hardcodes-omni-yagi. Spec: docs/modules/node-filter.md.
import assert from 'node:assert/strict';

const { getConfig, setConfig, deleteConfig } = await import('../src/db.js');
const { passesFilter, registerMacToNumResolver } = await import('../src/node-filter.js');
const { registerMacToNodeIdResolver } = await import('../src/device-config.js');

registerMacToNumResolver(() => null); // no own-gateway nodes to exclude in this test
registerMacToNodeIdResolver(() => null);

const RADIO_A = 'AA:BB:CC:DD:EE:01'; // the rotator, in the scanActive cases
const RADIO_B = 'AA:BB:CC:DD:EE:02'; // a second, non-rotator radio
const SOURCE_KEY = 'node_filters.node_source';

const savedSource = getConfig(SOURCE_KEY, undefined);

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

function node(devices) {
  return { num: 12345, _devices: devices, hops_away: 0 };
}

try {
  // ── no rotator configured at all — the deployment Peter described, a bare
  // single radio with nothing mounted on anything ─────────────────────────
  setConfig('device_cfg.' + RADIO_A, {});
  setConfig('device_cfg.' + RADIO_B, {});
  setConfig(SOURCE_KEY, 'all');
  ok(passesFilter(node([RADIO_A]), {}), "'all' passes a node heard on any device, no rotator needed anywhere");

  // ── filter by an ARBITRARY device MAC — not a hardcoded role name ────────
  setConfig(SOURCE_KEY, RADIO_B);
  ok(!passesFilter(node([RADIO_A]), {}), 'a node heard only on RADIO_A is rejected when filtering for RADIO_B');
  ok(passesFilter(node([RADIO_B]), {}), 'a node heard on RADIO_B passes when filtering for RADIO_B');
  ok(passesFilter(node([RADIO_A, RADIO_B]), {}), 'a node heard on both passes when filtering for RADIO_B');

  // ── a LEGACY 'yagi'/'omni' value left over from before this change must not
  // silently match nothing — db.js's migration (tested separately) resets it,
  // but the filter itself must also not special-case these strings any more:
  // 'yagi' is just an arbitrary (non-matching) MAC-shaped filter now ───────
  setConfig(SOURCE_KEY, 'yagi');
  ok(!passesFilter(node([RADIO_A]), {}), "'yagi' is no longer a magic token — it matches no real device MAC");

  // ── scanActive forces the LIVE rotator MAC, never a literal string ──────
  setConfig('device_cfg.' + RADIO_A, { is_rotator: true });
  setConfig(SOURCE_KEY, 'all'); // the user's own choice must be overridden during a scan
  ok(!passesFilter({ ...node([RADIO_B]), _scanAz: 1 }, { scanActive: true }),
     'scanActive rejects a node heard only on the non-rotator radio');
  ok(passesFilter({ ...node([RADIO_A]), _scanAz: 1 }, { scanActive: true }),
     'scanActive accepts a node heard on the live rotator radio');

  // ── no rotator configured: scanActive must impose NO device filtering
  // (nothing to force it to), not silently match nothing ───────────────────
  setConfig('device_cfg.' + RADIO_A, {}); // un-rotator it
  ok(passesFilter({ ...node([RADIO_B]), _scanAz: 1 }, { scanActive: true }),
     'with no rotator configured, scanActive does not filter by device at all');

  console.log(`test_node_filter_device_agnostic: ${checks} checks passed`);
} finally {
  deleteConfig('device_cfg.' + RADIO_A);
  deleteConfig('device_cfg.' + RADIO_B);
  if (savedSource === undefined) deleteConfig(SOURCE_KEY);
  else setConfig(SOURCE_KEY, savedSource);
}
