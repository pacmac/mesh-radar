import assert from 'node:assert/strict';

const requests = [];
let responseStatus = 200;

globalThis.fetch = async (url, options) => {
  requests.push({
    method: options.method,
    url: new URL(url).pathname,
    body: JSON.parse(options.body || '{}'),
  });
  const body = responseStatus === 200
    ? { verified: true }
    : { error: 'simulated gateway rejection' };
  return new Response(JSON.stringify(body), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { OpManager } = await import(`../src/op-manager.js?channel-test=${Date.now()}`);
const manager = new OpManager(() => {});

async function waitForTerminal(opId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const op = manager._ops.get(opId);
    if (op?.state === 'success' || op?.state === 'error') return op;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`operation ${opId} did not reach a terminal state`);
}

const acceptedId = manager.submit('channel_config', '!2687afb1', {
  index: 4,
  values: { role: 'DISABLED', settings: { name: 'BackendContractTest' } },
});
const accepted = await waitForTerminal(acceptedId);
assert.equal(accepted.state, 'success');
assert.deepEqual(requests, [{
  method: 'PUT',
  url: '/!2687afb1/channels/4',
  body: { role: 'DISABLED', settings: { name: 'BackendContractTest' } },
}]);

responseStatus = 503;
const rejectedId = manager.submit('channel_config', '!2687afb1', {
  index: 4,
  values: { role: 'DISABLED', settings: {} },
});
const rejected = await waitForTerminal(rejectedId);
assert.equal(rejected.state, 'error');
assert.match(rejected.error, /Write failed HTTP 503/);
assert.equal(requests.length, 2);
assert.ok(requests.every(request => request.method === 'PUT'), 'channel_config must not issue a GET');

console.log('PASS channel_config: one PUT, no stale GET, truthful 2xx/non-2xx terminal states');
process.exit(0);
