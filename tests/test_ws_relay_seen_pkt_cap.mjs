// _seenLivePktIds (dedup set for live TEXT_MESSAGE_APP events + outbound
// message_status acks) had no size cap — only ever cleared on a bridge
// reconnect, so on a stable multi-hour/day connection it grows by one entry
// per packet id forever. Its sibling _seenTiltPktIds already caps at 500 with
// FIFO eviction (ws-relay.js, tilt dedup) — the same pattern just wasn't
// applied here. idiot entry ws-relay-seenlivepktids-unbounded.
// Spec: docs/modules/ws-relay.md.
import assert from 'node:assert/strict';

const mod = await import('../src/ws-relay.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

ok(typeof mod._addSeenLivePktId === 'function',
   '_seenLivePktIds has a capped-insert helper (no such export existed before this fix)');
ok(typeof mod._seenLivePktIdsSize === 'function',
   'the set exposes its size for this test — no other way to observe module-private state');

const CAP = 500;
for (let i = 0; i < CAP + 50; i++) mod._addSeenLivePktId(1_000_000 + i);

ok(mod._seenLivePktIdsSize() <= CAP, `after inserting ${CAP + 50} distinct ids, the set never exceeds its cap (saw ${mod._seenLivePktIdsSize()})`);

console.log(`ws-relay _seenLivePktIds cap: ${checks} checks passed`);
