// A mesh-gw firmware NodeDB-replay packet (packet.replay=true) carries a
// synthetic rx_rssi of 0 and relay_node of 0 (docs/gw/API_SSE.md's `replay`
// field) — not a real reception. Unfiltered, it passed isDirectPacket() and
// was stored in signal_history as a genuine direct reading of 0 dBm.
// Relayed from fun via mesh-gw as "rssi 0.0 where mesh-gw sent null"; the
// precise cause is this unfiltered flag, not a null-to-0 coercion anywhere
// in node-dash's own code (checked: persist.js/db.js already null-guard via
// fin()/_fin()). idiot entry
// signal-history-stores-replay-packets-as-direct-receptions.
import assert from 'node:assert/strict';

const { handleEvent } = await import('../src/persist.js');
const db = (await import('../src/db.js')).default;

const TEST_PACKET_ID = 999999301;

function cleanup() {
  db.prepare('DELETE FROM signal_history WHERE packet_id = ?').run(TEST_PACKET_ID);
  db.prepare('DELETE FROM relay_observation WHERE packet_id = ?').run(TEST_PACKET_ID);
}

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

cleanup();
try {
  handleEvent({
    type: 'packet',
    __ble_addr: 'AA:BB:CC:DD:EE:FF',
    data: {
      packet: {
        from: 1234,
        to: 0xffffffff,
        id: TEST_PACKET_ID,
        channel: 0,
        relay_node: 0,
        hop_limit: 3,
        hop_start: 3,
        rx_time: Math.floor(Date.now() / 1000) - 3600, // stale, as real replays are
        rx_rssi: 0,     // the synthetic marker, not a reading
        rx_snr: 0,
        replay: true,   // mesh-gw's firmware NodeDB-replay flag
        decoded: {
          portnum: 4,
          portnum_name: 'NODEINFO_APP',
        },
      },
    },
  });

  const row = db.prepare('SELECT * FROM signal_history WHERE packet_id = ?').get(TEST_PACKET_ID);
  ok(row == null, 'a replay packet writes no signal_history row');

  console.log(`test_signal_history_replay_gate: ${checks} checks passed`);
} finally {
  cleanup();
}
