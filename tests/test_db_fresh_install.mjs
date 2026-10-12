// db.js's one-time geocode_cache carry-across backfill does `SELECT address FROM
// nodeinfo` unconditionally, but nodeinfo's own CREATE TABLE never had an address
// column (it only ever existed on a database that pre-dates the geocode_cache
// split, task referenced in db.js's own comment above the backfill). A genuinely
// fresh database throws "no such column: address" and node-dash never starts —
// confirmed live via deploy/install.sh's smoke test against a brand-new Pi
// install. idiot entry geocode-cache-backfill-breaks-fresh-database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'node-dash-fresh-db-'));
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

try {
  const dbPath = path.join(scratch, 'fresh.db'); // does NOT exist — a brand new DB file
  execFileSync('node', ['-e', "import('./src/db.js').then(() => process.exit(0))"],
    { cwd: REPO, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  ok(true, 'db.js loads cleanly against a brand new, empty database file');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`test_db_fresh_install: ${checks} checks passed`);
