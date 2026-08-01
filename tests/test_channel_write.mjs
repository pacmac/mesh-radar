// channelWriteBody: what a channel PUT is allowed to contain.
//
// THIS TEST USED TO ASSERT THE BUG. Its first case read "a channel replacement
// must preserve locked/omitted settings such as PSK" and passed a `current` that
// had a psk in it — the safe half of the story. The unsafe half, the one that
// cost Peter ten days off the air, is a `current` with NO psk, because `current`
// is mesh-gw's channel cache and that cache is stale until the radio reconnects.
// Measured 2026-08-01: the radio held `AQ==` while the cache held nothing, so a
// save would have written an empty key. See docs/modules/app-config.md → "A
// channel PUT never carries a PSK the operator did not supply".
//
// The rule under test now: the PSK must be supplied in THIS edit, or the write
// is refused. Omitted and deliberately-empty are different answers.
import assert from 'node:assert/strict';

const { channelWriteBody } = await import('../public/app-config.js');

const cachedWithKey = {
  role: 'PRIMARY',
  settings: { channel_num: 0, psk: 'AQIDBA==', name: 'mesh', uplink_enabled: true },
};

// The case that mattered: cache has no psk (stale), operator edits something
// else and saves. Refused — it must not invent a key, empty or otherwise.
const cachedWithoutKey = {
  role: 'PRIMARY',
  settings: { channel_num: 0, uplink_enabled: true },
};
assert.throws(
  () => channelWriteBody(cachedWithoutKey, { role: 'PRIMARY', name: 'renamed' }),
  /Unlock the PSK field/,
  'a stale cache with no PSK must NOT produce a write that silently empties the key',
);

// Refused even when the cache does hold a key — a cached value is not evidence
// of what the radio holds, so it is never the source for the write.
assert.throws(
  () => channelWriteBody(cachedWithKey, { role: 'SECONDARY', name: 'renamed', uplink_enabled: false }),
  /Unlock the PSK field/,
  'a locked PSK must never be backfilled from the cache, even when the cache has one',
);

// Unlocked and supplied: the write goes through, the operator's key is used, the
// rest of the edit overlays the cached settings, and role stays outside settings.
assert.deepEqual(
  channelWriteBody(cachedWithKey, {
    role: 'SECONDARY', psk: 'BQYHCA==', name: 'renamed', uplink_enabled: false,
  }),
  {
    role: 'SECONDARY',
    settings: { channel_num: 0, psk: 'BQYHCA==', name: 'renamed', uplink_enabled: false },
  },
  'an explicitly supplied PSK is written, and role is separated from settings',
);

// Unlocked and deliberately cleared: allowed. An unencrypted channel is a legal
// Meshtastic configuration; what was missing was the operator SAYING so.
assert.equal(
  channelWriteBody(cachedWithKey, { role: 'PRIMARY', psk: '' }).settings.psk, '',
  'an explicitly emptied PSK is a valid choice and must not be blocked',
);

// A DISABLED slot has no key to protect — the five unused channels stay
// one-click editable.
assert.deepEqual(
  channelWriteBody({}, { role: 'DISABLED', channel_num: 0, name: '' }),
  { role: 'DISABLED', settings: { channel_num: 0, name: '' } },
);

console.log('PASS channelWriteBody refuses an unsupplied PSK, accepts an explicit one, separates role');
