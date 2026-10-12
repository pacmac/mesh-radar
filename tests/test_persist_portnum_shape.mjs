// persist.js must recognise a text message using mesh-gw's REAL live event
// shape, not the string shape it used to be.
//
// LIVE-CAPTURED 2026-09-10, straight off ws://localhost:8001/events:
//   portnum=3 (number) portnum_name="POSITION_APP"
//   portnum=6 (number) portnum_name="ADMIN_APP"
//   portnum=67 (number) portnum_name="TELEMETRY_APP"
// portnum is an INTEGER on every live event; the name lives in portnum_name.
// `if (portnum === 'TEXT_MESSAGE_APP')` compares a number to a string and is
// permanently false — this is why zero inbound text messages were recorded
// for 18.4 days (2026-08-23 onward) while nodeinfo/position/telemetry (which
// arrive via their OWN typed WS events, never touching this comparison) kept
// working throughout. Spec: docs/modules/persist.md.
import assert from 'node:assert/strict';

const { handleEvent } = await import('../src/persist.js');
const db = (await import('../src/db.js')).default;

const TEST_PACKET_ID = 999999001; // distinctive, cleaned up below
const TEST_TEXT = '__test_persist_portnum_shape__';

function cleanup() {
  db.prepare('DELETE FROM messages WHERE packet_id = ?').run(TEST_PACKET_ID);
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
        hop_limit: 3,
        hop_start: 3,
        rx_time: Math.floor(Date.now() / 1000),
        rx_rssi: -90,
        rx_snr: 5,
        decoded: {
          // THE REAL LIVE SHAPE — integer portnum, name alongside.
          portnum: 1,
          portnum_name: 'TEXT_MESSAGE_APP',
          payload: Buffer.from(TEST_TEXT, 'utf8').toString('base64'),
        },
      },
    },
  });

  const row = db.prepare('SELECT * FROM messages WHERE packet_id = ?').get(TEST_PACKET_ID);
  ok(row != null, 'a live-shaped TEXT_MESSAGE_APP packet is recorded in messages');
  if (row) ok(row.text === TEST_TEXT, 'the recorded text matches the payload sent');

  console.log(`test_persist_portnum_shape: ${checks} checks passed`);
} finally {
  cleanup();
}
