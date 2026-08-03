// standing-tasks — hooks that mine the data we already hold.
//
// Task `hooks-standing-tasks`. Peter, 2026-08-03: "those hooks should be assigned
// to tasks, i.e search the node data for unknown nodes, search the node for nodes
// that show a different reply path than the send, search the nodes for nodes
// mentioned in a traceroute but not anywhere in our radar."
//
// These are `store` scope: triggered by a cadence rather than by a probe, and
// they produce FINDINGS rather than probe steps. They cost no airtime — every
// answer is already in the database, unread.
//
// FINDING NOTHING IS ALSO A RESULT. "82 route members checked, 0 unknown" is
// evidence the mesh is mapped; silence is indistinguishable from the hook being
// broken, which is exactly how the passive tracer failed for 9.5 hours.

import db, { getConfig } from './db.js';
import { defineHook } from './hooks.js';

// 0xFFFFFFFF is the BROADCAST address, not a node. Without this the ghost-relay
// hook reports a phantom that cannot exist — measured 2026-08-03, it was 1 of the
// 3 "unknown" relays found.
const BROADCAST = 4294967295;

const J = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };

const T = {
  unknown: defineHook({
    name: 'unknown-nodes', scope: 'store',
    purpose: 'finds nodes we could probe but never have — positioned, recently heard, never traced',
  }),
  ghosts: defineHook({
    name: 'ghost-relays', scope: 'store',
    purpose: 'finds relays that carried our traffic but appear nowhere in our node table',
  }),
  asym: defineHook({
    name: 'asymmetric-paths', scope: 'store',
    purpose: 'measures how often a reply returns by a different path than the send',
  }),
};

/** Nodes we could probe but never have.
 *
 *  "Unknown" needed pinning before a hook could honestly claim to implement it —
 *  no position / no nodeinfo / never traced / never heard are four different
 *  populations (330 / 250 / 460 / 905 of 940 on 2026-08-03) with four different
 *  actions. Vague terms are what made `from_num` cost three wrong readings.
 *
 *  This is the ACTIONABLE one: we know where it is, it is alive, and we have
 *  never asked. 58 such nodes on 2026-08-03.
 */
function runUnknownNodes() {
  const days = Number((getConfig('discovery', {}) || {}).max_silence_days) || 14;
  const rows = db.prepare(`
    SELECT n.num, n.lat, n.lon, n.last_heard
      FROM nodes n
     WHERE n.lat IS NOT NULL AND n.lat <> 0
       AND n.last_heard > strftime('%s','now') - ? * 86400
       AND n.num NOT IN (SELECT to_num FROM traceroute_history WHERE to_num IS NOT NULL)
     ORDER BY n.last_heard DESC`).all(days);
  T.unknown.emit({
    severity: rows.length ? 'notice' : 'info',
    summary: rows.length
      ? `${rows.length} nodes are placed and were heard within ${days} days but have never been traced`
      : `every placed node heard within ${days} days has been traced at least once`,
    detail: { count: rows.length, max_silence_days: days, sample: rows.slice(0, 20).map(r => r.num) },
  });
}

/** Relays that carried our traffic and are in no node table.
 *
 *  They demonstrably relayed for us, so they exist and are reachable — and we
 *  hold nothing about them. Small but real: 2 genuine on 2026-08-03, after
 *  excluding the broadcast address.
 */
function runGhostRelays() {
  const rows = db.prepare(`SELECT route, route_back FROM traceroute_history WHERE status='ok'`).all();
  const seen = new Set();
  for (const r of rows) for (const n of [...J(r.route), ...J(r.route_back)]) if (n !== BROADCAST) seen.add(n);
  const known = new Set(db.prepare('SELECT num FROM nodes').all().map(r => r.num));
  const ghosts = [...seen].filter(n => !known.has(n));
  T.ghosts.emit({
    severity: ghosts.length ? 'notice' : 'info',
    summary: ghosts.length
      ? `${ghosts.length} of ${seen.size} relays seen in routes are not in our node table`
      : `all ${seen.size} relays seen in routes are known to us`,
    detail: { checked: seen.size, unknown: ghosts },
  });
}

/** How often the reply comes back a different way than the send went out.
 *
 *  64% on 2026-08-03 (1,819 of 2,833). Not a curiosity: `route_back` describes
 *  relays the outbound path never touched, so it roughly doubles the relay
 *  information already stored — and it means "aim at the first hop" has to
 *  specify the OUTBOUND first hop. Any model treating a path as a stable
 *  corridor is wrong two thirds of the time.
 */
function runAsymmetricPaths() {
  const rows = db.prepare(`
    SELECT route, route_back FROM traceroute_history
     WHERE status='ok' AND route <> '[]' AND route_back <> '[]'`).all();
  let sym = 0, asym = 0;
  for (const r of rows) {
    const f = J(r.route).filter(x => x !== BROADCAST);
    const b = J(r.route_back).filter(x => x !== BROADCAST).reverse();
    if (!f.length || !b.length) continue;
    if (f.length === b.length && f.every((v, i) => v === b[i])) sym++; else asym++;
  }
  const total = sym + asym;
  T.asym.emit({
    summary: total
      ? `${asym} of ${total} answered routes return by a different path (${Math.round(100 * asym / total)}%)`
      : 'no answered routes with both directions recorded yet',
    detail: { symmetric: sym, asymmetric: asym, pct: total ? Math.round(100 * asym / total) : null },
  });
}

const TASKS = [runUnknownNodes, runGhostRelays, runAsymmetricPaths];

/** Run every standing task once, isolated. One throwing must not stop the rest —
 *  a broken analysis should cost its own finding, never the others'. */
export function runStandingTasks() {
  for (const fn of TASKS) {
    try { fn(); }
    catch (e) { console.error(`[standing-tasks] ${fn.name} failed: ${e.message}`); }
  }
}

/** Cadence. These read history rather than the wire, so they gain nothing from
 *  running often — hourly by default, and once shortly after boot so a fresh
 *  start has findings without waiting an hour. */
export function startStandingTasks() {
  const mins = Math.min(1440, Math.max(5, Number(getConfig('standing_tasks.every_min', 60)) || 60));
  setTimeout(runStandingTasks, 60_000);
  setInterval(runStandingTasks, mins * 60_000);
}
