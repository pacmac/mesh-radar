// doors — where the packet ACTUALLY leaves from, as opposed to where the target is.
//
// Peter, 2026-08-03: "whatever happens I dont think we should be targeting
// remote nodes directly. that is pointless (pun intended)." Then: "we are now
// aiming at DOORS or, if all doors are comfortably in sight of OMNI using OMNI?"
//
// He is right on both counts and the measurements are blunt:
//
//   aiming at the target puts the real first hop OUTSIDE the 35 deg beam ~87%
//   of the time — 0-50km 84%, 50-100km 100%, 100-150km 100%, 150km+ 93%.
//
// A DOOR is the relay our packet leaves through. Two ways to know one:
//
//   1. KNOWN   — this target answered before, so route[0] of that success is
//                literally the node that carried it. Best evidence there is.
//   2. DOMINANT — no route for this target, so use the relay that carries most
//                of our traffic. Measured 63% exact on held-out routes, against
//                32% for a bearing-matched relay and ~13% for aiming at the
//                target. The simple constant beat the clever model.
//
// AND THE STING: the dominant door is 5.3 km away. A yagi confers nothing at
// 5.3 km — the omni reaches it comfortably — so for most missions the beam is
// irrelevant wherever it points. `doorNeedsBeam()` is what lets the runner say
// so instead of solemnly rotating to no purpose.

import db from './db.js';
import { haversine, bearing as bearingOf } from './utils.js';

const BROADCAST = 4294967295;
const J = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };

// Beyond this a door is far enough that pointing gain plausibly matters. Inside
// it, the omni reaches the door and the rotator is theatre. Chosen as roughly
// the furthest DIRECT contact either radio has ever made (omni 43.0 km), so it
// is anchored to measured reach rather than picked.
const BEAM_WORTH_IT_KM = 40;

function home() {
  const r = db.prepare(`
    SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') lon`).get();
  return (r && Number.isFinite(r.lat) && r.lat !== 0) ? r : null;
}

/** The relay that carried this target's traffic, if it ever answered.
 *  Most recent success wins — a corridor can move. */
export function knownDoor(num) {
  const r = db.prepare(`
    SELECT route FROM traceroute_history
     WHERE to_num = ? AND status = 'ok' AND route <> '[]'
     ORDER BY ts DESC LIMIT 1`).get(num);
  if (!r) return null;
  const chain = J(r.route).filter(n => n !== BROADCAST);
  if (!chain.length) return null;
  return chain[0];
}

/** The relay that carries the most of our completed routes.
 *
 *  A CONSTANT, not a model. The bearing-matched alternative scored 32% against
 *  this one's 63% on the same held-out split — picking the busiest door beats
 *  reasoning about direction, because most traffic genuinely does leave the
 *  same way. */
export function dominantDoor() {
  const counts = new Map();
  for (const r of db.prepare(`SELECT route FROM traceroute_history
                               WHERE status='ok' AND route <> '[]'`).all()) {
    const chain = J(r.route).filter(n => n !== BROADCAST);
    if (!chain.length) continue;
    counts.set(chain[0], (counts.get(chain[0]) || 0) + 1);
  }
  let best = null, bestN = 0, total = 0;
  for (const [n, c] of counts) { total += c; if (c > bestN) { bestN = c; best = n; } }
  if (best == null) return null;
  return { num: best, carried: bestN, share: total ? bestN / total : 0 };
}

/** The set of nodes that have ever been a first hop, keyed by their LOW BYTE.
 *
 *  This is what makes relay_node usable. The byte alone names ~4.64 candidate
 *  nodes across the 946 we know; restricted to nodes that have actually served
 *  as a door it is 17 doors over 16 bytes, with one collision (byte 4) that the
 *  route count settles 2039 to 10.
 */
function doorsByByte() {
  const byByte = new Map();
  for (const r of db.prepare(`SELECT route FROM traceroute_history
                               WHERE status='ok' AND route <> '[]'`).all()) {
    const chain = J(r.route).filter(n => n !== BROADCAST);
    if (!chain.length) continue;
    const num = chain[0], b = num & 0xff;
    const seen = byByte.get(b) || new Map();
    seen.set(num, (seen.get(num) || 0) + 1);
    byByte.set(b, seen);
  }
  // collapse each byte to its most-used door
  const out = new Map();
  for (const [b, seen] of byByte) {
    let best = null, bestN = 0;
    for (const [num, c] of seen) if (c > bestN) { bestN = c; best = num; }
    out.set(b, best);
  }
  return out;
}

/** The door this target's packets REACH US through.
 *
 *  MeshPacket field 19 (`relay_node`), stored per received packet as
 *  `relay_byte` — populated even for nodes that have never answered a
 *  traceroute, which is exactly the population `knownDoor` cannot serve.
 *
 *  Direction caveat, deliberately not hidden: this is the INBOUND relay. The
 *  door we aim at is outbound and routing is 62% asymmetric, so this is
 *  evidence, not proof. Measured 83.0% micro / 71.7% macro against the
 *  dominant-door constant's 49.1% / 41.3% on the same rows, no leakage.
 */
export function relayDoor(num) {
  const r = db.prepare(`
    SELECT relay_byte, COUNT(*) c FROM relay_observation
     WHERE from_num = ? AND relay_byte <> 0
     GROUP BY relay_byte ORDER BY c DESC, relay_byte LIMIT 1`).get(num);
  if (!r) return null;
  const door = doorsByByte().get(r.relay_byte);
  return door == null ? null : { num: door, byte: r.relay_byte, seen: r.c };
}

/** Where to point for this target, and whether pointing is worth anything.
 *
 *  Returns { az, door, source, km, needsBeam, why } or null when we cannot
 *  place a door at all — in which case the caller should NOT fall back to the
 *  target's bearing, because that is the behaviour being replaced.
 */
export function doorAim(targetNum) {
  const h = home();
  if (!h) return null;

  const pos = (n) => db.prepare('SELECT lat, lon, short_name, long_name FROM nodes WHERE num = ?').get(n);

  // Evidence order, strongest first: this target's own answered route, then the
  // relay its packets actually reach us through, then the global constant.
  let door = knownDoor(targetNum), source = 'known';
  if (door == null) {
    const rd = relayDoor(targetNum);
    if (rd) { door = rd.num; source = 'relay'; }
  }
  if (door == null) {
    const d = dominantDoor();
    if (!d) return null;
    door = d.num; source = 'dominant';
  }
  const p = pos(door);
  if (!p?.lat || p.lat === 0) return null;

  const km = haversine(h.lat, h.lon, p.lat, p.lon);
  return {
    az: Math.round(bearingOf(h.lat, h.lon, p.lat, p.lon)),
    door,
    name: p.short_name || p.long_name || `!${door.toString(16)}`,
    source,
    km: +km.toFixed(1),
    // The honest part. A door inside the omni's proven reach does not need a
    // 9 dBi beam, and saying so is more useful than rotating for appearances.
    needsBeam: km >= BEAM_WORTH_IT_KM,
    why: source === 'known'  ? 'this target answered through it before'
       : source === 'relay'  ? 'this target reaches us through it (inbound relay, unproven outbound)'
       :                       'carries most of our completed routes',
  };
}

export { BEAM_WORTH_IT_KM };
