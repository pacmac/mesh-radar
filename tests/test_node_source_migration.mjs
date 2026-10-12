// node_filters.node_source's one-time migration: a stale 'both'/'omni'/'yagi'
// value (meaningful only under the old hardcoded two-bucket filter) must
// reset to 'all' rather than silently matching no device MAC and filtering
// the node list to nothing. idiot entry node-source-filter-hardcodes-omni-yagi.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..');
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

for (const legacy of ['both', 'omni', 'yagi']) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'node-dash-source-migration-'));
  const dbPath = path.join(scratch, 'test.db');
  try {
    // Seed a pre-migration database: just the config table, holding the
    // legacy value, as if written by an older version of this app.
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    seed.prepare(`INSERT INTO config (key, value) VALUES ('node_filters.node_source', ?)`)
      .run(JSON.stringify(legacy));
    seed.close();

    execFileSync('node', ['-e', "import('./src/db.js').then(() => process.exit(0))"],
      { cwd: REPO, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

    const check = new Database(dbPath, { readonly: true });
    const row = check.prepare(`SELECT value FROM config WHERE key = 'node_filters.node_source'`).get();
    check.close();
    ok(JSON.parse(row.value) === 'all', `legacy value '${legacy}' migrates to 'all' (got ${row.value})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`test_node_source_migration: ${checks} checks passed`);
