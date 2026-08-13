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
  { name: 'observatory_boundary',   group: 'fast',    cmd: 'node',    args: ['tests/test_observatory_boundary.mjs'], needs: '—',                measured: '40 ms',    timeoutMs: 30_000 },
  { name: 'channel_write',          group: 'fast',    cmd: 'node',    args: ['tests/test_channel_write.mjs'],     needs: '—',                   measured: '30 ms',    timeoutMs: 30_000 },
  { name: 'op_manager',             group: 'fast',    cmd: 'node',    args: ['tests/test_op_manager.mjs'],        needs: '—',                   measured: '140 ms',   timeoutMs: 30_000 },
  { name: 'coulomb',                group: 'fast',    cmd: 'node',    args: ['tests/test_coulomb.mjs'],           needs: '—',                   measured: '158 ms',   timeoutMs: 30_000 },

  { name: 'check_snapshot',         group: 'service', cmd: 'node',    args: ['scripts/check_snapshot.mjs'],       needs: 'node-dash up',        measured: '3.9 s',    timeoutMs: 30_000 },
  { name: 'check_contract',         group: 'service', cmd: 'node',    args: ['scripts/check_contract.mjs'],       needs: 'node-dash up',        measured: '5.1 s',    timeoutMs: 60_000 },
  // Fails today for B92 (the ~13.2 MB WS connect replay disconnects any client
  // on default frame limits — five of its six failures are that one cause) and
  // B93 (typed traceroute event unhandled in index.js). The ledger ids are
  // printed beside the failure so the reader knows the cause is recorded. It
  // still counts as a failure: annotating why is not excusing it.
  { name: 'node_api',               group: 'service', cmd: 'python3', args: ['tests/test_node.py'],               needs: 'node-dash up',        measured: '~35 s',    timeoutMs: 180_000, known: 'B92, B93' },

  { name: 'page_snapshot',          group: 'slow',    cmd: 'python3', args: ['tests/test_page_snapshot.py'],      needs: 'node-dash + browser', measured: 'minutes',  timeoutMs: 600_000 },
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
