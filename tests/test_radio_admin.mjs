// radio-admin: the phone app's method, asserted.
//
// REPLACES tests/test_op_manager.mjs, whose only subject was `channel_config` —
// one of the five radio-config ops deleted on 2026-08-18. A test for a deleted op
// is not a test.
//
// Every assertion here corresponds to something established by reading the
// Meshtastic firmware or the official Android app, and to a defect that actually
// shipped. See docs/modules/radio-admin.md.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DEV = '!testdev0';
const BACKUP_DIR = path.join(process.cwd(), 'backups', DEV);

const sent = [];
let backupCalls = 0;

globalThis.fetch = async (url, options = {}) => {
  const p = decodeURIComponent(new URL(url).pathname);
  if (p.endsWith('/radio_backup')) {
    backupCalls++;
    return new Response(JSON.stringify({ version: 1, node_id: DEV, config: {}, channels: [] }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  sent.push({ path: p, body: JSON.parse(options.body || '{}') });
  return new Response(JSON.stringify({ sent: true, fields: ['x'] }),
                      { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { setConfig, setChannel, setOwner, stamp } =
  await import(`../src/radio-admin.js?t=${Date.now()}`);

let checks = 0;
const eq = (a, b, w) => { assert.deepEqual(a, b, w); checks++; };
const ok = (c, w) => { assert.ok(c, w); checks++; };

// ── the stamp is 24-HOUR ────────────────────────────────────────────────────
// Peter wrote "yymmddhis", the PHP format where `h` is the 12-hour clock. Saves
// at 09:15:00 and 21:15:00 would render identically, collide, and sort wrongly.
// A record that sorts wrongly is not a record.
eq(stamp(new Date(2026, 7, 18, 21, 15, 0)), '260818211500', '21:15 renders as 21, not 09');
ok(stamp(new Date(2026, 7, 18, 9, 15, 0)) !== stamp(new Date(2026, 7, 18, 21, 15, 0)),
   'morning and evening saves must not collide');

// ── a write takes a backup FIRST, then sends ────────────────────────────────
// Peter: "before EVERY save". Skipping any save breaks the chain, and a chain
// with holes is not a record.
const before = sent.length;
const r = await setConfig(DEV, 'lora', { hop_limit: 5 });
eq(backupCalls, 1, 'exactly one backup taken for one save');
eq(sent.length, before + 1, 'exactly one admin message sent');
ok(r.backup && fs.existsSync(r.backup), 'the save returns the backup path and the file exists');

// ── the AdminMessage is composed correctly ──────────────────────────────────
const cfg = sent.at(-1);
ok(cfg.path.endsWith('/admin'), 'writes go to the admin pass-through, not the cooked PUT surface');
eq(cfg.body.message, { set_config: { lora: { hop_limit: 5 } } }, 'set_config wraps the section');

// ── want_response is FALSE on setters ───────────────────────────────────────
// AdminControllerImpl.kt: setters call sendAdmin(destNum, packetId) and
// CommandSender.sendAdmin defaults wantResponse = false. Only the GETTERS pass
// true. We match the app; we do not wait on an ack it does not wait on.
eq(cfg.body.want_response, false, 'setters do not request a response — the app does not');

// ── THE THREE FIELDS THAT MUST NEVER APPEAR ─────────────────────────────────
const asText = JSON.stringify(sent);
ok(!asText.includes('session_passkey'),
   'never send a session passkey — mesh-gw owns it. Peter: "that secret is theirs to keep"');
ok(!asText.includes('reboot_seconds'),
   'never command a reboot for a config write — the FIRMWARE decides (AdminModule.cpp), '
 + 'and reboot_seconds is a separate operator action');
ok(!asText.includes('begin_edit_settings') && !asText.includes('commit_edit_settings'),
   'no edit transaction: the app uses none, and commit_edit_settings reboots '
 + 'unconditionally (saveChanges defaults shouldReboot=true after clearing the flag), '
 + 'so it would CAUSE a reboot the firmware would otherwise skip');

// ── channel index 0 is expressible ──────────────────────────────────────────
// The 2026-08-16 outage was a PRIMARY channel nobody meant to touch. Index 0 must
// survive being passed, and must never be reached by a falsy default.
await setChannel(DEV, 0, { name: '' });
eq(sent.at(-1).body.message, { set_channel: { index: 0, settings: { name: '' } } },
   'channel index 0 (PRIMARY) round-trips intact');

await setOwner(DEV, { short_name: 'AB', long_name: 'A B' });
eq(sent.at(-1).body.message, { set_owner: { short_name: 'AB', long_name: 'A B' } },
   'set_owner passes the user through unchanged');

eq(backupCalls, 3, 'one backup per save, no save without one');

fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
console.log(`${checks} checks — admin pass-through, no passkey, no reboot, no transaction, backup per save.`);
process.exit(0);
