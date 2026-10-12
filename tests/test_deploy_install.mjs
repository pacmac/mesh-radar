// node-dash had no install.sh/systemd unit, so a fresh host (e.g. a Pi) could not be
// deployed without hand-running npm install and improvising a service. idiot entry
// deploy-install-sh-for-pi. Spec: docs/modules/deploy_install.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..');
const INSTALL = path.join(REPO, 'deploy', 'install.sh');
const UNIT = path.join(REPO, 'deploy', 'node-dash.service.in');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

ok(existsSync(INSTALL), 'deploy/install.sh exists');
ok(existsSync(UNIT), 'deploy/node-dash.service.in exists');

const unit = readFileSync(UNIT, 'utf8');
ok(unit.includes('@@REPO@@'), 'unit template carries a @@REPO@@ placeholder');
ok(unit.includes('@@PORT@@'), 'unit template carries a @@PORT@@ placeholder');
ok(!unit.includes('/usr/share/pac/dev/projects/mt-radar/node-dash'),
   'unit template does not hardcode the dev box\'s own path');

// --check must write nothing and exit 0 on this very checkout.
const out = execFileSync('bash', [INSTALL, '--check'], { cwd: REPO, encoding: 'utf8' });
ok(/node/i.test(out), '--check reports the node runtime it found');
ok(!/REFUSED/.test(out), '--check does not refuse on a real checkout');

// ── fresh-clone simulation: a scratch copy with NO data/ at all, exactly what a
// real `git clone` produces since data/ is gitignored. Confirmed live on
// pimesh.home 2026-10-11: better-sqlite3 cannot create a missing PARENT
// directory (only the db file inside an existing one), so a fresh clone's
// smoke step died with "Cannot open database because the directory does not
// exist" before install.sh ever reached systemd — idiot entry
// install-sh-assumes-data-dir-exists.
//
// node_modules is SYMLINKED, not reinstalled — data/'s absence is what this
// tests, not npm — and --smoke-only is a test-only hook (never used by a real
// install) that runs just the smoke step, skipping npm install and the
// systemd unit entirely, so this never touches systemd on the dev box.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'node-dash-fresh-clone-'));
try {
  for (const f of ['package.json', 'src', 'deploy']) {
    cpSync(path.join(REPO, f), path.join(scratch, f), { recursive: true });
  }
  symlinkSync(path.join(REPO, 'node_modules'), path.join(scratch, 'node_modules'));
  // data/ deliberately NOT created — that is the whole point of this case.
  execFileSync('bash', [path.join(scratch, 'deploy', 'install.sh'), '--smoke-only'],
               { cwd: scratch, encoding: 'utf8' });
  ok(true, '--smoke-only passes on a fresh clone with no data/ directory');

  // better-sqlite3's WAL mode leaves -shm/-wal sidecar files beside the main db
  // file; install.sh only rm -f'd the main file, leaving these behind on every
  // run — confirmed left behind on pimesh.home. idiot entry
  // install-sh-leaves-smoke-wal-sidecars.
  const { readdirSync } = await import('node:fs');
  const leftovers = readdirSync(path.join(scratch, 'data')).filter(f => f.startsWith('.smoke-test.db'));
  ok(leftovers.length === 0, `no .smoke-test.db* sidecar files left behind, got: ${leftovers.join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`test_deploy_install: ${checks} checks passed`);
