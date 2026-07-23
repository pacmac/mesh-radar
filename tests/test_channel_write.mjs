import assert from 'node:assert/strict';

const { channelWriteBody } = await import('../public/app-config.js');

const current = {
  role: 'PRIMARY',
  settings: {
    channel_num: 0,
    psk: 'AQIDBA==',
    name: 'mesh',
    uplink_enabled: true,
  },
};

assert.deepEqual(
  channelWriteBody(current, {
    role: 'SECONDARY',
    name: 'renamed',
    uplink_enabled: false,
  }),
  {
    role: 'SECONDARY',
    settings: {
      channel_num: 0,
      psk: 'AQIDBA==',
      name: 'renamed',
      uplink_enabled: false,
    },
  },
  'a channel replacement must preserve locked/omitted settings such as PSK',
);

assert.deepEqual(
  channelWriteBody({}, { role: 'DISABLED', channel_num: 0, name: '' }),
  {
    role: 'DISABLED',
    settings: { channel_num: 0, name: '' },
  },
);

console.log('PASS channelWriteBody preserves omitted settings and separates role');
