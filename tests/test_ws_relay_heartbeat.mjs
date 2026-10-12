// ws-relay's WS server had no ping/pong heartbeat anywhere. A half-open client
// (laptop sleep, flaky wifi, a NAT dropping the session without a clean FIN)
// leaves ws.readyState stuck at 1 (OPEN) forever server-side — every broadcast
// still sends into a socket nothing on the wire will ever drain, and the
// per-connection 'close' cleanup (listener removal, timers) never fires because
// 'close' never fires. Root-caused as the leading suspect for node-dash RSS
// growing ~100MB -> 777MB over ~15h on the Pi deployment, which then livelocked
// the whole process under SQLite WAL-lock contention. idiot entry
// ws-relay-no-dead-peer-detection. Spec: docs/modules/ws-relay.md.
//
// Tested at the level of OUR logic (the sweep that decides who is dead), not
// the `ws` package's wire protocol — duck-typed fakes, same style as this
// repo's other unit tests (e.g. test_node_filter_device_agnostic.mjs calling
// passesFilter() directly).
import assert from 'node:assert/strict';

const mod = await import('../src/ws-relay.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

ok(typeof mod.pruneDeadConnections === 'function',
   'ws-relay.js exports a pruneDeadConnections sweep — no heartbeat mechanism existed before this fix');

function fakeWs() {
  return { isAlive: true, terminate() { this.terminated = true; }, ping() { this.pinged = true; } };
}

// A connection that answered the last ping (isAlive left true by the pong
// handler since the previous sweep) survives: it gets marked due for the next
// check and pinged again, never terminated.
{
  const alive = fakeWs();
  mod.pruneDeadConnections([alive]);
  ok(!alive.terminated, 'a responsive connection (isAlive=true) is not terminated');
  ok(alive.pinged, 'a responsive connection is pinged to arm the next check');
  ok(alive.isAlive === false, 'isAlive is reset to false so the NEXT sweep requires a fresh pong');
}

// A connection that did not answer the PREVIOUS ping (pong never arrived, so
// isAlive is still false going into this sweep) is the zombie case this fix
// exists for — it must be terminated, which forces the real 'close' event the
// rest of ws-relay.js already correctly cleans up after, but which a silent
// dead peer would otherwise never trigger.
{
  const dead = fakeWs();
  dead.isAlive = false;
  mod.pruneDeadConnections([dead]);
  ok(dead.terminated, 'a connection that missed the previous pong is terminated this sweep');
  ok(!dead.pinged, 'a terminated connection is not also pinged');
}

// Mixed set: only the zombie is pruned, the live one is left running.
{
  const alive = fakeWs();
  const dead  = fakeWs();
  dead.isAlive = false;
  mod.pruneDeadConnections([alive, dead]);
  ok(!alive.terminated && dead.terminated, 'the sweep prunes exactly the dead connection, leaving the live one alone');
}

// Structural check: both WS servers wire isAlive + pong into their connection
// handlers, and both run the sweep on an interval. A fix that only wrote
// pruneDeadConnections but never called it from attachWsRelay would pass the
// unit tests above yet leak exactly as before.
const src = await (await import('node:fs/promises')).readFile(
  new URL('../src/ws-relay.js', import.meta.url), 'utf8');
ok(/ws\.isAlive\s*=\s*true/.test(src), "the main connection handler marks new sockets isAlive");
ok(/on\(['"]pong['"]/.test(src), "a 'pong' handler exists to clear isAlive back to true");
ok(/pruneDeadConnections\(\s*wss\.clients/.test(src), 'the sweep is actually run against wss.clients, not just defined');
ok(/pruneDeadConnections\(\s*wssDevice\.clients/.test(src), 'the sweep also covers the per-device wssDevice server (attachDeviceClient has the identical leak: 8 listeners on shared singleton emitters, never removed for a zombie since removal is wired only to close)');

console.log(`ws-relay heartbeat: ${checks} checks passed`);
