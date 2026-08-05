// ── Node kind — what a node IS to us ─────────────────────────────────────────
//
// One classification, computed here, rendered by the browser. BROWSER_CONTRACT:
// "if a display differs based on a condition, that condition is evaluated in
// Node.js". The radar draws a different icon per kind; it must not decide which.
//
// WHY THIS EXISTS. Peter, 2026-08-04:
//
//   "the current dash is saturated with every node plotted the same with no
//    indication of whether it is a target, a relay / router"
//
// FOUR KINDS, and the precedence between them is the whole design:
//
//   own       one of our own radios. Never drawn as mesh infrastructure.
//   door      we have PROVEN we can transmit to it directly — it has appeared
//             as the first hop of a completed traceroute. This is the only
//             kind backed by evidence rather than by declaration.
//   router    the node DECLARES a relay role in its nodeinfo.
//   endpoint  everything else. A destination, not a way through.
//
// DOOR BEATS ROUTER, deliberately. Measured 2026-08-04: of the 13 relays we can
// provably reach, 8 do not declare a router role at all — and of 28 declared
// ROUTERs only 12 have ever carried a hop for us. A relay we have actually
// transmitted through is a more useful thing to see on a radar than one that
// merely says it is a router. Declaration is a hint; a completed route is a fact.
//
// The role enum is NOT a fixed truth either. Peter, 2026-08-05, listing the
// current firmware set: CLIENT, CLIENT_MUTE, TRACKER, LOST_AND_FOUND, SENSOR,
// TAK, TAK_TRACKER, ROUTER, ROUTER_LATE, CLIENT_BASE — no ROUTER_CLIENT, no
// REPEATER. Both still appear in our node table because those nodes run OLD
// FIRMWARE, so they stay in the set below: this classifies what we OBSERVE, and
// we observe several firmware generations at once. It is not a list of roles to
// offer as a choice.

import { stmts, getConfig } from './db.js';
import { ownDeviceNums } from './node-filter.js';

// SINGLE DECLARATION. This Set was hand-copied into four files —
// doors.js:40, standing-tasks.js:39, observatory-ws.js:190 and :831 — each one a
// separate opportunity to disagree with the others. Same failure as the seven
// private copies of the discovery defaults. One home; the others import it.
export const RELAY_ROLES = new Set(['ROUTER', 'ROUTER_LATE', 'ROUTER_CLIENT', 'REPEATER']);

export function isRelayRole(role) {
  return RELAY_ROLES.has(String(role || '').toUpperCase());
}

// ── proven doors ─────────────────────────────────────────────────────────────
//
// A door is a node that has been the FIRST HOP of a completed traceroute, which
// means our transmission reached it with no relay in between. That proves the
// UPLINK, not merely that we have heard it — hearing proves only the downlink,
// and asymmetric paths are real.
//
// Cached: node_list is emitted often and this is a full scan of the history.
// The TTL is a declared knob, not a literal — nothing here is a magic number.
const DOOR_CACHE_DEFAULTS = { ttl_sec: 300 };
function doorTtlMs() {
  const c = { ...DOOR_CACHE_DEFAULTS, ...(getConfig('node_kind', {}) || {}) };
  const s = Number(c.ttl_sec);
  return (Number.isFinite(s) && s >= 0 ? s : DOOR_CACHE_DEFAULTS.ttl_sec) * 1000;
}

let _doors = null;
let _doorsAt = 0;

/** Set of node nums we have provably transmitted to directly. */
export function provenDoors({ force = false } = {}) {
  const now = Date.now();
  if (!force && _doors && (now - _doorsAt) < doorTtlMs()) return _doors;
  const s = new Set();
  try {
    for (const r of stmts.provenDoorNums.all()) {
      if (r.num != null) s.add(Number(r.num));
    }
  } catch (err) {
    // A failed lookup must not silently reclassify every door as an endpoint —
    // keep the last good set rather than publishing a wrong one.
    if (_doors) return _doors;
    console.error(`[node-kind] proven doors query failed: ${err.message}`);
  }
  _doors = s;
  _doorsAt = now;
  return s;
}

/** Drop the cache — call when a traceroute completes, so a NEW door shows up
 *  on the radar immediately rather than up to ttl_sec later. */
export function invalidateDoors() { _doorsAt = 0; _rolesAt = 0; }

// ── roles ────────────────────────────────────────────────────────────────────
//
// THE LIVE NODE CACHE CARRIES NO ROLE. nodeinfo writes the role to the `nodes`
// table; the in-memory row that reaches node_list does not have it. Measured
// 2026-08-05: all 73 rows in a live node_list had role null, while the store held
// roles for 214 nodes — so `router` was unreachable and Peter saw no router icons
// at all, which is exactly what he reported.
//
// Resolved from the store, cached on the same TTL as the door set.
let _roles = null, _rolesAt = 0;

export function rolesByNum({ force = false } = {}) {
  const now = Date.now();
  if (!force && _roles && (now - _rolesAt) < doorTtlMs()) return _roles;
  const m = new Map();
  try {
    for (const r of stmts.allNodeRoles.all()) m.set(Number(r.num), r.role);
  } catch (err) {
    if (_roles) return _roles;
    console.error(`[node-kind] role lookup failed: ${err.message}`);
  }
  _roles = m;
  _rolesAt = now;
  return m;
}

// ── classification ───────────────────────────────────────────────────────────

/** `own` | `door` | `router` | `endpoint`. Precedence in that order. */
export function nodeKind(num, role, { doors = null, own = null, roles = null } = {}) {
  const n = Number(num);
  const o = own ?? ownDeviceNums();
  if (o.has(n)) return 'own';
  const d = doors ?? provenDoors();
  if (d.has(n)) return 'door';
  // Fall back to the STORE when the caller's row has no role. The live cache
  // never carries one, so without this the router branch is dead code.
  const r = role || (roles ?? rolesByNum()).get(n);
  if (isRelayRole(r)) return 'router';
  return 'endpoint';
}

/** Classify a whole list in one pass — resolves the door set and our own nums
 *  ONCE rather than per node. node_list carries hundreds of rows. */
export function classifyAll(nodes) {
  const doors = provenDoors(), own = ownDeviceNums(), roles = rolesByNum();
  return nodes.map(n => ({ ...n, node_kind: nodeKind(n.num, n.role, { doors, own, roles }) }));
}

/** Counts per kind — for the layer toggles to show what each one holds, and so
 *  an empty layer reads as "none of these" rather than as a broken filter. */
export function kindCounts(nodes) {
  const out = { own: 0, door: 0, router: 0, endpoint: 0 };
  const doors = provenDoors(), own = ownDeviceNums(), roles = rolesByNum();
  for (const n of nodes) out[nodeKind(n.num, n.role, { doors, own, roles })]++;
  return out;
}
