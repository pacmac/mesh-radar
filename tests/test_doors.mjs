// A door is a relay. 0xFFFFFFFF is not a node and can never be one.
//
// mesh-gw found this by reading our store: "4294967295 is ranked third in
// snapshot.distribution.doors at 39%, name '?'. That is 0xFFFFFFFF, the broadcast
// address — a broadcast counted as a relay."
//
// The knowledge already existed twice in this repo — doors.js filters it in three
// places, and the archived inferences.js relay.usage excluded it with the reason
// recorded — but snapshot-api.js:222 built its own inline query and did not.
// THREE implementations, two live, disagreeing. See docs/modules/reach.md.
//
// Asserts the OUTPUT, not the SQL: a test that greps for a filter passes the day
// somebody writes a fourth query with the filter and a different bug.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error(`cannot load better-sqlite3: ${e.message}`); process.exit(127); }

const DB = new URL('../data/node-dash.db', import.meta.url).pathname;
let db;
try { db = new Database(DB, { readonly: true }); }
catch (e) { console.error(`cannot open ${DB}: ${e.message}`); process.exit(127); }

const BROADCAST = 4294967295;
let checks = 0;
const fail = [];
const ok = (c, w) => { if (c) checks++; else fail.push(w); };

// ── the module must exist and expose ONE door-usage query ───────────────────
let doorUsage = null;
try { ({ doorUsage } = await import('../src/reach.js')); } catch { /* reported */ }
ok(typeof doorUsage === 'function', 'src/reach.js exports doorUsage()');

if (typeof doorUsage === 'function') {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const doors = doorUsage({ since });

  ok(Array.isArray(doors), 'doorUsage returns an array');
  ok(doors.every(d => Number.isInteger(d.num)), 'every door has an integer num');
  ok(doors.every(d => Number.isInteger(d.uses) && d.uses > 0), 'every door has a positive use count');

  // THE DEFECT.
  const bcast = doors.filter(d => d.num === BROADCAST);
  ok(bcast.length === 0,
     `no door is the broadcast address — found ${bcast.length}: ${JSON.stringify(bcast)}`);

  // Ordered, so "top door" means something to a caller.
  const ordered = doors.every((d, i) => i === 0 || doors[i - 1].uses >= d.uses);
  ok(ordered, 'doors are returned most-used first');

  // STABLE over a fixed window: a ranking that changes between two calls with the
  // same `since` cannot be reasoned about, and the archived catalogue's whole
  // point was values that can be recomputed.
  const again = doorUsage({ since });
  ok(JSON.stringify(again) === JSON.stringify(doors),
     'two calls over the same window return the same ranking');

  // AND IT MUST NOT BE EMPTY BY ACCIDENT. A filter that removed everything would
  // satisfy the broadcast check and be useless — the control that stops this
  // passing for the wrong reason.
  const anyOk = db.prepare(`
    SELECT COUNT(*) n FROM traceroute_history
     WHERE status='ok' AND json_array_length(route) BETWEEN 1 AND 99 AND ts >= ?`).get(since).n;
  if (anyOk > 0) {
    ok(doors.length > 0, `the window has ${anyOk} completed traceroutes, so doors must not be empty`);
  } else {
    console.log('note: no completed traceroutes in the window — emptiness check skipped');
  }
}

// ── and the raw table still contains what we are filtering, so the test is real
const present = db.prepare(`
  SELECT COUNT(*) n FROM traceroute_history
   WHERE status='ok' AND json_extract(route,'$[0]') = ?`).get(BROADCAST).n;
console.log(`note: ${present} completed traceroutes have the broadcast address as route[0]`
          + (present === 0 ? ' — the filter is untested by live data today' : ''));

for (const f of fail) console.error('FAIL  ' + f);
console.log(`${checks} checks, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
