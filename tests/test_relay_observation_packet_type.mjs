// relay_observation captured relay/hop provenance but nothing about WHAT was
// heard — no portnum, no packet_id, no signal. "What did we hear from X"
// was unanswerable from this table alone. Relayed from fun via mesh-gw,
// idiot entry relay-observation-keeps-no-packet-type. Spec:
// docs/modules/relay-observation.md.
import assert from 'node:assert/strict';

const { handleEvent } = await import('../src/persist.js');
const db = (await import('../src/db.js')).default;

const TEST_PACKET_ID = 999999201;
const TEST_FROM = 88123456;

function cleanup() {
  db.prepare('DELETE FROM relay_observation WHERE packet_id = ?').run(TEST_PACKET_ID);
}

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.equal(a, b, w); checks++; };

cleanup();
try {
  handleEvent({
    type: 'packet',
    __ble_addr: 'AA:BB:CC:DD:EE:FF',
    data: {
      packet: {
        from: TEST_FROM,
        to: 0xffffffff,
        id: TEST_PACKET_ID,
        channel: 0,
        relay_node: 42,
        hop_limit: 3,
        hop_start: 3,
        rx_time: Math.floor(Date.now() / 1000),
        rx_rssi: -77,
        rx_snr: 4.25,
        decoded: {
          portnum: 3,
          portnum_name: 'POSITION_APP',
        },
      },
    },
  });

  const row = db.prepare('SELECT * FROM relay_observation WHERE packet_id = ?').get(TEST_PACKET_ID);
  ok(row != null, 'a decoded packet is captured in relay_observation');
  if (row) {
    eq(row.portnum_name, 'POSITION_APP', 'portnum_name is captured from packet.decoded');
    eq(row.packet_id, TEST_PACKET_ID, 'packet_id is captured');
    eq(row.rx_snr, 4.25, 'rx_snr is captured');
  }

  // ── an encrypted-only packet (no `decoded` at all) must not throw, and
  // portnum_name must stay null rather than be assumed ──────────────────────
  const TEST_PACKET_ID_2 = TEST_PACKET_ID + 1;
  db.prepare('DELETE FROM relay_observation WHERE packet_id = ?').run(TEST_PACKET_ID_2);
  try {
    handleEvent({
      type: 'packet',
      __ble_addr: 'AA:BB:CC:DD:EE:FF',
      data: {
        packet: {
          from: TEST_FROM,
          to: 0xffffffff,
          id: TEST_PACKET_ID_2,
          relay_node: 42,
          hop_limit: 3,
          hop_start: 3,
          rx_time: Math.floor(Date.now() / 1000),
          rx_snr: 2,
          // no `decoded` — encrypted, never reaches the decoded gate below.
        },
      },
    });
    const row2 = db.prepare('SELECT * FROM relay_observation WHERE packet_id = ?').get(TEST_PACKET_ID_2);
    ok(row2 != null, 'an undecoded (encrypted-only) packet is still captured');
    if (row2) eq(row2.portnum_name, null, 'portnum_name stays null for an undecoded packet');
  } finally {
    db.prepare('DELETE FROM relay_observation WHERE packet_id = ?').run(TEST_PACKET_ID_2);
  }

  console.log(`test_relay_observation_packet_type: ${checks} checks passed`);
} finally {
  cleanup();
}
