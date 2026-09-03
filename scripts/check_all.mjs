// Run every check this repo owns, name the ones it did not run, and exit
// non-zero if any failed.
//
// Spec: docs/modules/check-all.md
//
// Ledger B96: eleven checks existed and NOTHING invoked any of them. Three broke
// on 2026-08-13 and stayed broken for hours with no red signal — found by a
// handover running them by hand, which is not a mechanism.
//
//   npm run check        fast + service  (the gate)
//   npm run check:all    everything runnable, browser included
//   npm run check:list   the inventory, running nothing

import { spawn } from 'node:child_process';

// Runtimes measured 2026-08-13, service up, warm 700 MB store. Timeouts are
// ~6-12x the measurement, with a 30 s FLOOR: under a second, process startup
// dominates and a tighter bound tests the machine rather than the code.
const CHECKS = [
  { name: 'check_specs',            group: 'fast',    cmd: 'python',  args: ['scripts/check_specs.py'],           needs: '—',                   measured: '82 ms',    timeoutMs: 30_000 },
  // observatory_boundary REMOVED 2026-08-18 — the boundary it guarded no longer
  // exists to be crossed. The whole subsystem is in
  // archive/observatory-and-discovery-2026-08-18.tar.gz, and the test went with
  // it. It asserted that only index.js/inferences.js/observatory-ws.js could
  // import the engine; with no engine there is nothing to import.
  //
  // channel_write and radio_admin REMOVED 2026-09-03, task
  // devices-management-removed-meshgw-owns-it — their subjects,
  // channelWriteBody() (public/app-config.js) and src/radio-admin.js, were both
  // deleted. mesh-gw's own dashboard owns radio config editing now; a test for a
  // function that no longer exists crashed instead of testing anything
  // (docs/modules/check-all.md, task devices-removal-residue-cleanup).
  //
  // interval_tables regenerates src/interval-tables.js from the vendored Kotlin
  // and diffs. Red if anyone hand-edits the generated file, or re-vendors a newer
  // source without regenerating. It canNOT see upstream moving while our vendored
  // copy sits still — see vendor/meshtastic-android/PROVENANCE.md.
  { name: 'interval_tables',        group: 'fast',    cmd: 'node',    args: ['scripts/gen_interval_tables.mjs', '--check'], needs: '—',        measured: '45 ms',    timeoutMs: 30_000 },
  { name: 'interval_options',       group: 'fast',    cmd: 'node',    args: ['tests/test_interval_options.mjs'],  needs: '—',                   measured: '40 ms',    timeoutMs: 30_000 },
  // verify_saved REMOVED 2026-08-18, one commit after it was added. It tested
  // verifySaved(), which compared a section against a read-back taken immediately
  // after the save — a check that cannot work, because the read-back races the
  // radio's reboot and because turning a boolean off makes it vanish from the GET
  // entirely. It fired on the normal path. The test passed throughout; it was
  // asserting the behaviour of a mechanism that should not exist.
  // docs/modules/app-config.md.
  { name: 'served_time',            group: 'fast',    cmd: 'node',    args: ['tests/test_served_time.mjs'],       needs: '—',                   measured: '120 ms',   timeoutMs: 30_000 },
  // `channels` REMOVED 2026-08-19 with src/channels.js. It tested a resolver this
  // repo no longer has: the gateway resolves 'public'/'private' per radio, which
  // it must, because private is index 2 on the OMNI and 1 on the YAGI.
  // Replaced by no_channel_resolver, which asserts the ABSENCE.
  { name: 'no_channel_resolver',    group: 'fast',    cmd: 'node',    args: ['tests/test_no_channel_resolver.mjs'], needs: '—',                 measured: '45 ms',    timeoutMs: 30_000 },
  { name: 'send_channel',           group: 'fast',    cmd: 'node',    args: ['tests/test_send_channel.mjs'],      needs: '—',                   measured: '120 ms',   timeoutMs: 30_000 },
  { name: 'resolve',                group: 'fast',    cmd: 'node',    args: ['tests/test_resolve.mjs'],           needs: '—',                   measured: '180 ms',   timeoutMs: 30_000 },
  { name: 'aim',                    group: 'fast',    cmd: 'node',    args: ['tests/test_aim.mjs'],               needs: '—',                   measured: '210 ms',   timeoutMs: 30_000 },
  { name: 'traceroute_flow',        group: 'fast',    cmd: 'node',    args: ['tests/test_traceroute_flow.mjs'],   needs: '—',                   measured: '2.6 s',    timeoutMs: 60_000 },

  // Live because the parent lookup is a SQL join over real rows — a fixture would
  // assert the shape of its own mock. Exits 127 when the service is down, which
  // the register reads as a mistrial rather than a conviction.
  // Reads the live store, so it belongs with the service checks even though it
  // needs no HTTP. Exits 127 if the db or driver is missing — a mistrial, not a
  // conviction.
  { name: 'transport_encoding',     group: 'service', cmd: 'node',    args: ['tests/test_transport_encoding.mjs'], needs: 'the store',          measured: '120 ms',   timeoutMs: 30_000 },
  // Door identity had THREE implementations, two live and disagreeing about
  // whether 0xFFFFFFFF is a relay, and /events published the broadcast as the
  // fourth-busiest door in the mesh. mesh-gw found it by reading our store.
  // Asserts the OUTPUT of reach.doorUsage(), not the SQL — a test that greps for
  // a filter passes the day somebody writes a fourth query. Reads the live store,
  // so it sits with the service group; exits 127 if the db or driver is missing,
  // which the register reads as a mistrial rather than a conviction.
  { name: 'doors',                  group: 'service', cmd: 'node',    args: ['tests/test_doors.mjs'],             needs: 'the store',           measured: '150 ms',   timeoutMs: 30_000 },
  // reply_snippet REMOVED 2026-09-03, task handover-check-audit-fixes — it
  // tested the Messages page's reply-quote rendering via GET /messages, both
  // deleted with the page (messages-frontend-and-browser-route-removed).
  { name: 'check_snapshot',         group: 'service', cmd: 'node',    args: ['scripts/check_snapshot.mjs'],       needs: 'node-dash up',        measured: '3.9 s',    timeoutMs: 30_000 },
  { name: 'check_contract',         group: 'service', cmd: 'node',    args: ['scripts/check_contract.mjs'],       needs: 'node-dash up',        measured: '5.1 s',    timeoutMs: 60_000 },
  { name: 'no_cache',               group: 'service', cmd: 'node',    args: ['scripts/check_no_cache.mjs'],       needs: 'node-dash up',        measured: '200 ms',   timeoutMs: 30_000 },
  // Fails today for B92 (the ~13.2 MB WS connect replay disconnects any client
  // on default frame limits — five of its six failures are that one cause) and
  // B93 (typed traceroute event unhandled in index.js). The ledger ids are
  // printed beside the failure so the reader knows the cause is recorded. It
  // still counts as a failure: annotating why is not excusing it.
  { name: 'node_api',               group: 'service', cmd: 'python3', args: ['tests/test_node.py'],               needs: 'node-dash up',        measured: '~35 s',    timeoutMs: 180_000, known: 'B92, B93' },

  // BOTH of these sat red with no `known:` marker, and because `npm run check` is
  // fast+service only, nothing ever ran them. That is how ten stale assertions in
  // playwright_audit went unnoticed from 2026-08-17 to 2026-08-18. An unexplained
  // permanent failure is indistinguishable from an ignored one, so the remaining
  // red is named here.
  { name: 'page_snapshot',          group: 'slow',    cmd: 'python3', args: ['tests/test_page_snapshot.py'],      needs: 'node-dash + browser', measured: 'minutes',  timeoutMs: 600_000, known: 'layout cut=1 at 1280x800, both themes — ledger: slow-browser-checks-fail-with-nothing-recording-it' },
  // known: 'iphone/messages YAGI control clipped out of viewport' RETIRED
  // 2026-09-03 — the /messages RouteCase it fired on is gone
  // (messages-frontend-and-browser-route-removed), so that exact failure name
  // can never occur again. Re-checked live in the Observe pass of task
  // devices-removal-residue-cleanup; updated below if anything real surfaced.
  { name: 'playwright_audit',       group: 'slow',    cmd: 'python3', args: ['tests/test_playwright.py'],         needs: 'node-dash + browser', measured: 'minutes',  timeoutMs: 600_000 },
];

// NEVER run by this runner. Not a group — an exclusion, printed on every run
// including a green one, because a check omitted silently is a check that gets
// forgotten and then rewritten.
const EXCLUDED = [
  { name: 'ops', path: 'tests/test_ops.py', reason:
      'WRITES REAL RADIO CONFIG — radio_config_section:* and owner_info PUTs, unconditional, '
    + 'no guard and no dry-run. On 2026-08-13 every write returned 503 Device not connected, '
    + 'so nothing was written: it was saved by the device being down, not by the test. '
    + 'Run it by hand and on purpose. Ledger B94.' },
  { name: 'reference/alarm-integration', path: 'reference/alarm-integration/tests/*.mjs', reason:
      'Archive, not check. Its own INVENTORY.md: "Nothing in this directory is loaded, served, '
    + 'tested, or imported by node-dash." The three tests no longer execute.' },
];

const argv = process.argv.slice(2);
const wants = (flag) => argv.includes(flag);
const groupArg = (() => {
  const i = argv.indexOf('--group');
  return i === -1 ? 'fast,service' : (argv[i + 1] ?? 'fast,service');
})();
const groups = groupArg === 'all' ? ['fast', 'service', 'slow'] : groupArg.split(',').map(s => s.trim());

const pad = (s, n) => String(s).padEnd(n);

function printExclusions() {
  console.log('\nNOT RUN — by design, every time:');
  for (const x of EXCLUDED) {
    console.log(`  ${pad(x.name, 28)} ${x.path}`);
    console.log(`  ${' '.repeat(28)} ${x.reason.replace(/(.{88}) /g, '$1\n' + ' '.repeat(29))}`);
  }
}

if (wants('--list')) {
  console.log('\nCHECK INVENTORY\n');
  console.log(`  ${pad('name', 24)}${pad('group', 10)}${pad('needs', 24)}${pad('measured', 11)}timeout`);
  for (const c of CHECKS) {
    console.log(`  ${pad(c.name, 24)}${pad(c.group, 10)}${pad(c.needs, 24)}${pad(c.measured, 11)}${c.timeoutMs / 1000}s`
                + (c.known ? `   known-failing: ${c.known}` : ''));
  }
  printExclusions();
  console.log(`\n${CHECKS.length} runnable, ${EXCLUDED.length} excluded.\n`);
  process.exit(0);
}

/** Run one check to completion. Never rejects — a failure is a result. */
function run(check) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(check.cmd, check.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ check, status: 'TIMEOUT', ms: Date.now() - started, out });
    }, check.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ check, status: 'FAIL', ms: Date.now() - started, out: `${out}\ncould not spawn: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ check, status: code === 0 ? 'ok' : 'FAIL', ms: Date.now() - started, out });
    });
  });
}

const selected = CHECKS.filter(c => groups.includes(c.group));
if (!selected.length) {
  console.error(`no checks in group(s) '${groupArg}'. Groups: fast, service, slow, all.`);
  process.exit(2);
}

console.log(`\nRunning ${selected.length} check(s) in group(s): ${groups.join(', ')}\n`);

const results = [];
for (const c of selected) {                    // sequential and cheapest-first:
  const r = await run(c);                      // a broken repo fails in under a
  results.push(r);                             // second, not after six minutes
  const mark = r.status === 'ok' ? ' ok  ' : r.status === 'TIMEOUT' ? 'TIME ' : 'FAIL ';
  console.log(`  ${mark} ${pad(c.name, 24)}${String(r.ms).padStart(7)} ms`
              + (r.status !== 'ok' && c.known ? `   (known: ${c.known})` : ''));
}

const failed = results.filter(r => r.status !== 'ok');

for (const r of failed) {
  const tail = r.out.trimEnd().split('\n').slice(-15).join('\n');
  console.log(`\n──── ${r.check.name}  ${r.status}  (${r.check.cmd} ${r.check.args.join(' ')}) ────`);
  console.log(tail || '(no output)');
}

printExclusions();

console.log(`\n${results.length - failed.length} of ${results.length} passed`
            + (failed.length ? `, ${failed.length} FAILED: ${failed.map(r => r.check.name).join(', ')}` : '')
            + '\n');

process.exit(failed.length ? 1 : 0);
