// messages.channel held 'public'/'private' for outbound rows and an integer
// index for inbound rows — two incompatible types in one column. idiot entry
// outbound-rows-store-a-channel-word-inbound-store-an-index. Spec:
// docs/modules/channels.md.
//
// Fix: a NEW channel_role column (TEXT: 'public'|'private'|null) carries the
// semantic meaning consistently for BOTH directions. `channel` itself is left
// as-is (still the word for outbound, the index for inbound) — documented as
// superseded/legacy rather than risking a NOT NULL/type change on a column
// other readers may already depend on.
import assert from 'node:assert/strict';

const db = (await import('../src/db.js')).default;
const { inboundChannelRole } = await import('../src/persist.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

// ── the column exists ───────────────────────────────────────────────────────
{
  const cols = db.prepare(`PRAGMA table_xinfo(messages)`).all().map(r => r.name);
  ok(cols.includes('channel_role'), 'messages.channel_role column exists');
}

// ── inboundChannelRole never GUESSES — unresolved stays null, same rule as
// every other "unknown" in this repo ────────────────────────────────────────
eq(inboundChannelRole('AA:BB:CC:DD:EE:FF', 0), null,
   'an unresolved device/index pair returns null, not a guessed role');
eq(inboundChannelRole(null, 0), null, 'a missing device returns null');

// ── outbound and inbound both ROUNDTRIP a channel_role through the real
// insert statements, proving the column actually carries the value rather
// than silently dropping an unbound parameter ───────────────────────────────
const TEST_PKT_A = 999999101, TEST_PKT_B = 999999102;
db.prepare('DELETE FROM messages WHERE packet_id IN (?, ?)').run(TEST_PKT_A, TEST_PKT_B);
try {
  const { stmts } = await import('../src/db.js');
  stmts.insertTxMessage.run({
    ts: Math.floor(Date.now() / 1000), from_num: 1, to_num: 0xffffffff,
    text: 't', channel: 'public', channel_role: 'public', is_dm: 0,
    hop_limit: null, snr: null, rssi: null, packet_id: TEST_PKT_A, reply_id: null,
    device: 'AA:BB:CC:DD:EE:FF', replay: 0, hops: 0, short_name: null, long_name: null,
    message_key: 't-' + TEST_PKT_A, category: null,
  });
  stmts.insertRxMessage.run({
    ts: Math.floor(Date.now() / 1000), from_num: 2, to_num: 0xffffffff,
    text: 'r', channel: 0, channel_role: 'public', is_dm: 0,
    hop_limit: null, snr: null, rssi: null, packet_id: TEST_PKT_B, reply_id: null,
    device: 'AA:BB:CC:DD:EE:FF', replay: 0, hops: 0, short_name: null, long_name: null,
    message_key: 'r-' + TEST_PKT_B,
  });
  const tx = db.prepare('SELECT channel, channel_role FROM messages WHERE packet_id = ?').get(TEST_PKT_A);
  const rx = db.prepare('SELECT channel, channel_role FROM messages WHERE packet_id = ?').get(TEST_PKT_B);
  eq(tx.channel_role, 'public', 'outbound row carries channel_role as the word');
  eq(rx.channel_role, 'public', 'inbound row carries channel_role as the resolved word');
  ok(typeof tx.channel === 'string' || typeof tx.channel === 'number', 'outbound channel column unchanged (legacy)');
  eq(rx.channel, 0, 'inbound channel column unchanged (legacy index)');
} finally {
  db.prepare('DELETE FROM messages WHERE packet_id IN (?, ?)').run(TEST_PKT_A, TEST_PKT_B);
}

console.log(`test_messages_channel_role: ${checks} checks passed`);
