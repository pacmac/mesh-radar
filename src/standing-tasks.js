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
import { beamWorthItKm } from './doors.js';
import { defineHook } from './hooks.js';
import { ownDeviceNums } from './node-filter.js';
import { discoveryConfig } from './config-api.js';

// first_run_ms — the miners sweep whole tables, so they wait for boot traffic
// to settle rather than competing with it. Basis: same settle window as the
// observatory's first recompute.
//
// Declared and overridable — Peter, 2026-08-04: "all timings need to be vars.
// some if not all will be selected to be configurables / knobs."
const TIMING_DEFAULTS = { first_run_ms: 60_000 };
const timing = () => ({ ...TIMING_DEFAULTS, ...(getConfig('standing_tasks_timing', {}) || {}) });


// 0xFFFFFFFF is the BROADCAST address, not a node. Without this the ghost-relay
// hook reports a phantom that cannot exist — measured 2026-08-03, it was 1 of the
// 3 "unknown" relays found.
const BROADCAST = 4294967295;

// Roles that relay for others, and therefore CAN be a door. CLIENT_MUTE is the
// explicit opposite — it never rebroadcasts, so it can never be one.
// Single home: node-kind.js — see the note there on why old firmware values stay.
import { RELAY_ROLES } from './node-kind.js';

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
  stranded: defineHook({
    name: 'stranded-positions', scope: 'store',
    purpose: 'finds nodes whose position we already hold in nodeinfo but never copied into nodes',
  }),
  anchorable: defineHook({
    name: 'anchorable-nodes', scope: 'store',
    purpose: 'finds unpositioned nodes whose distance is BOUNDED by a positioned door adjacent to them',
  }),
  corridors: defineHook({
    name: 'blocked-corridors', scope: 'store',
    purpose: 'finds record-beating nodes excluded ONLY by the ladder window, and says how far it would have to widen',
  }),
  stalled: defineHook({
    name: 'probing-stalled', scope: 'store',
    purpose: 'catches us receiving packets while sending almost none — a dead prober on a live mesh',
  }),
  changepoint: defineHook({
    name: 'rate-changepoint', scope: 'store',
    purpose: 'finds the DATE the answer rate stepped, so it can be matched against a deploy or a config change',
  }),
  dispatchers: defineHook({
    name: 'dispatcher-yield', scope: 'store',
    purpose: 'compares aimed missions against passive traces ON THE SAME NODES, so target selection cannot flatter either',
  }),
  calloutYield: defineHook({
    name: 'callout-yield', scope: 'store',
    purpose: 'reports what the public callouts actually bought — sent, answered, and the best two-way distance',
  }),
  relayCorridors: defineHook({
    name: 'relay-corridors', scope: 'store',
    purpose: 'learns which relay carries our traffic toward each bearing, so a node we have never reached can still be aimed at through a door',
  }),
  outboundRelay: defineHook({
    name: 'outbound-relay-identity', scope: 'store',
    purpose: 'names the nodes that ACKed packets WE sent — the only outbound-direction relay evidence we get, against a mesh that routes 62% asymmetrically',
  }),
  explorers: defineHook({
    name: 'explorers', scope: 'store',
    purpose: 'flags distant, consistent, multi-hop nodes that reach us and never answer — each one is evidence of a corridor we cannot yet see',
  }),
  newGround: defineHook({
    name: 'new-ground', scope: 'store',
    purpose: 'separates ground we TOOK from traffic we repeated — first-ever contacts against attempts, so a busy day that reached nothing new cannot read as progress',
  }),
};

/** WHERE WE ARE. Read once per run — it cannot change mid-sweep.
 *
 *  `home_pos` is NULL on this host (see the parked `radar-home-position-ssot`
 *  task), so a fallback is needed. It must be OUR OWN RADIO and nothing else.
 *
 *  The first version fell back to "the most recently heard positioned node",
 *  which is non-deterministic and silently wrong: on 2026-08-03 that happened to
 *  be our own OMNI, giving a plausible 179 km, but the next two candidates were
 *  Gozza_Mesh_2 in Bristol and mu7gci office in GUERNSEY. Picking either would
 *  have rebased every door distance on a stranger's location and produced
 *  confident nonsense that looked exactly like a measurement.
 *
 *  Returning null is the honest answer when we cannot place ourselves; the
 *  caller then reports doors without distances rather than inventing them. */
function homeLatLon() {
  // `home.lat` / `home.lon` FIRST — this is the same pair `inferences.js` reads
  // for every distance it publishes, so the hooks and the selector cannot
  // disagree about where we are. Missing it and falling straight to the radios
  // is why a reconciliation run reported "cannot place ourselves" while the
  // config held 51.0263296,-3.1588352 all along.
  const row = db.prepare(`
    SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') lon`).get();
  if (row && Number.isFinite(row.lat) && Number.isFinite(row.lon) && row.lat !== 0) return row;

  const h = getConfig('home_pos', null);
  if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon)) return h;
  const own = [...ownDeviceNums()];
  if (!own.length) return null;
  const r = db.prepare(
    `SELECT lat, lon FROM nodes
      WHERE num IN (${own.map(() => '?').join(',')})
        AND lat IS NOT NULL AND lat <> 0
      ORDER BY last_heard DESC LIMIT 1`).get(...own);
  return r && r.lat ? { lat: r.lat, lon: r.lon } : null;
}

function bearingOf(a, b, c, d) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLon = rad(d - b);
  const y = Math.sin(dLon) * Math.cos(rad(c));
  const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(a, b, c, d) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(c - a), dLon = rad(d - b);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

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
  const days = Number(discoveryConfig().max_silence_days) || 14;
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

/** Positions we already hold and never used.
 *
 *  `nodeinfo` and `nodes` are two tables in the same database, and they disagree:
 *  11 recently-heard nodes on 2026-08-03 had a lat/lon in one and nothing in the
 *  other. Nothing discovers that on its own — it took a hand-run query, which is
 *  exactly the work a standing task exists to stop being manual.
 *
 *  This is a PLUMBING DIVERGENCE, not a discovery, and the hook says so rather
 *  than quietly copying the rows across. Why the two tables diverge is not yet
 *  known, and a hook that papered over it would destroy the evidence needed to
 *  find out.
 */
function runStrandedPositions() {
  const days = Number(discoveryConfig().max_silence_days) || 14;
  const rows = db.prepare(`
    SELECT n.num, i.lat, i.lon
      FROM nodes n
      JOIN nodeinfo i ON i.num = n.num
     WHERE (n.lat IS NULL OR n.lat = 0)
       AND i.lat IS NOT NULL AND i.lat <> 0
       AND n.last_heard > strftime('%s','now') - ? * 86400`).all(days);
  T.stranded.emit({
    severity: rows.length ? 'notice' : 'info',
    summary: rows.length
      ? `${rows.length} nodes have a position in nodeinfo that the nodes table never received`
      : 'nodeinfo and nodes agree on every recently-heard position',
    detail: { count: rows.length, max_silence_days: days, sample: rows.slice(0, 20).map(r => r.num) },
  });
}

/** Unpositioned nodes whose distance is BOUNDED by a door.
 *
 *  127 nodes are dropped from the discovery shortlist for having no position —
 *  the second-largest exclusion in the funnel after distance. Most are simply
 *  invisible. But some have a DOOR we can see: a relay adjacent to them in an
 *  answered traceroute, and that relay's own position bounds theirs to within
 *  one LoRa hop.
 *
 *  ADJACENCY IS NOT MEMBERSHIP. Only two positions in a route touch the target:
 *
 *    route_back[0]   the first hop of the reply — the target handed it to this node
 *    route[last]     the last outbound relay — this node handed it to the target
 *
 *  Everything else is adjacent to US or to another relay. Getting this wrong is
 *  not theoretical: a hand query on 2026-08-03 treated the whole chain as
 *  neighbours and reported Preston~Bowyer — 5.3 km away, on our own doorstep —
 *  as a neighbour of a node in Guernsey.
 *
 *  IT REPORTS A BOUND, NEVER A POSITION. The door's distance is what is known;
 *  the node's is not. Writing an estimate into the same column as a GPS fix
 *  would make every reach figure downstream a guess wearing a measurement's
 *  clothes, which is the one thing the board exists to prevent.
 */
function runAnchorableNodes() {
  const days = Number(discoveryConfig().max_silence_days) || 14;
  const home = homeLatLon();

  const unpos = db.prepare(`
    SELECT num FROM nodes
     WHERE (lat IS NULL OR lat = 0)
       AND last_heard > strftime('%s','now') - ? * 86400`).all(days);
  if (!unpos.length) {
    T.anchorable.emit({ summary: 'every recently-heard node has a position', detail: { count: 0 } });
    return;
  }
  const wanted = new Set(unpos.map(r => r.num));

  const positioned = new Map(
    db.prepare('SELECT num, lat, lon FROM nodes WHERE lat IS NOT NULL AND lat <> 0')
      .all().map(r => [r.num, r]));

  // Only answered traceroutes carry a route at all; a timeout reveals no doors.
  const doors = new Map();   // target num -> Set(door num)
  for (const r of db.prepare(`SELECT to_num, route, route_back FROM traceroute_history
                               WHERE status = 'ok'`).all()) {
    if (!wanted.has(r.to_num)) continue;
    const out  = J(r.route).filter(n => n !== BROADCAST);
    const back = J(r.route_back).filter(n => n !== BROADCAST);
    const adj  = [];
    if (out.length)  adj.push(out[out.length - 1]);
    if (back.length) adj.push(back[0]);
    for (const d of adj) {
      if (d === r.to_num) continue;
      if (!doors.has(r.to_num)) doors.set(r.to_num, new Set());
      doors.get(r.to_num).add(d);
    }
  }

  const found = [];
  for (const [num, ds] of doors) {
    const anchors = [...ds].filter(d => positioned.has(d));
    if (!anchors.length) continue;
    let best = null;
    for (const a of anchors) {
      const p = positioned.get(a);
      const km = home ? haversineKm(home.lat, home.lon, p.lat, p.lon) : null;
      if (km != null && (best == null || km > best.door_km)) best = { door: a, door_km: +km.toFixed(1) };
    }
    found.push({ num, doors: anchors.length, furthest_door: best?.door ?? null, door_km: best?.door_km ?? null });
  }
  found.sort((a, b) => (b.door_km ?? 0) - (a.door_km ?? 0));

  const far = found.filter(f => f.door_km != null);
  T.anchorable.emit({
    severity: found.length ? 'notice' : 'info',
    summary: found.length
      ? `${found.length} of ${unpos.length} unpositioned nodes sit one hop from a door we have placed`
        + (far.length ? ` — the furthest door is ${far[0].door_km} km out` : '')
      : `none of the ${unpos.length} unpositioned nodes has a positioned door`,
    detail: {
      unpositioned: unpos.length,
      anchorable: found.length,
      note: 'door distance BOUNDS the node, it does not place it — never usable as a reach figure',
      top: found.slice(0, 15),
    },
  });
}

/** The corridor we are choosing not to walk.
 *
 *  Peter, 2026-08-03: "is that another case for new hooks?" It is, and the rule
 *  generalises: ANYTHING FOUND WITH A HAND-RUN QUERY IS A HOOK THAT DOES NOT
 *  EXIST YET. This was the third such find in one day.
 *
 *  What the hand query turned up, and nothing on the board would ever have said:
 *  five nodes BEYOND the 189.1 km record, three of them heard that day, all on
 *  the same bearing (~160°) — every one excluded because its step from proven
 *  ground was 37-47 km against a `window_km` of 25.
 *
 *  They were not a leap into the dark. Guernsey at ~181 km is proven ground: six
 *  Channel Islands nodes have answered, two of them that same day. Jersey is one
 *  hop past a WORKING corridor.
 *
 *  The selector was behaving exactly as designed and said nothing, because
 *  `skipped_beyond_window` is a single number that lumps a genuine next step in
 *  with 180-odd hopeless leaps. "Too far" and "further than we currently allow"
 *  are different claims and only one of them is a decision.
 *
 *  `widen_to` is the point of the whole hook: it turns an exclusion into a
 *  number someone can act on.
 */
function runBlockedCorridors() {
  const d       = discoveryConfig();
  const days    = Number(d.max_silence_days) || 14;
  const windowKm = Number(d.window_km) || 25;
  const CEILING = 250;   // matches inferences.js — beyond this a position is not evidence
  const home    = homeLatLon();
  if (!home) {
    T.corridors.emit({ summary: 'cannot place ourselves, so no corridor can be measured', detail: {} });
    return;
  }

  // PROVEN GROUND, by the selector's own definition — answered at least once and
  // positioned. Using a different definition here would let the hook disagree
  // with the very thing it is describing.
  const proven = db.prepare(`
    SELECT DISTINCT n.num, n.lat, n.lon
      FROM nodes n JOIN traceroute_history t ON t.to_num = n.num AND t.status = 'ok'
     WHERE n.lat IS NOT NULL AND n.lat <> 0`).all();
  if (!proven.length) {
    T.corridors.emit({ summary: 'nothing has answered yet, so there is no proven ground to step from', detail: {} });
    return;
  }
  // The bar: the furthest we have actually reached. Only nodes past it could
  // move the record, and only those are worth calling a corridor.
  let bestKm = 0;
  for (const p of proven) {
    const km = haversineKm(home.lat, home.lon, p.lat, p.lon);
    if (km > bestKm && km <= CEILING) bestKm = km;
  }

  const alive = db.prepare(`
    SELECT num, long_name, lat, lon, last_heard FROM nodes
     WHERE lat IS NOT NULL AND lat <> 0
       AND last_heard > strftime('%s','now') - ? * 86400`).all(days);

  const now = Math.floor(Date.now() / 1000);
  const found = [];
  for (const n of alive) {
    const km = haversineKm(home.lat, home.lon, n.lat, n.lon);
    if (km > CEILING || km <= bestKm) continue;          // not a record, or not evidence
    let step = Infinity;
    for (const p of proven) {
      const s = haversineKm(n.lat, n.lon, p.lat, p.lon);
      if (s < step) step = s;
    }
    if (step <= windowKm) continue;                       // already eligible; not blocked
    found.push({
      num: n.num, name: n.long_name || `!${n.num.toString(16)}`,
      km: +km.toFixed(1), step: +step.toFixed(1),
      bearing: Math.round(bearingOf(home.lat, home.lon, n.lat, n.lon)),
      silent_h: Math.round((now - Number(n.last_heard)) / 3600),
      widen_to: Math.ceil(step),
    });
  }
  // NEAREST STEP FIRST. The cheapest next move, not the biggest headline number
  // — ranking these by raw distance is the mistake that had discovery firing at
  // 234 km while a 20 km extension went untried.
  found.sort((a, b) => a.step - b.step);

  T.corridors.emit({
    severity: found.length ? 'notice' : 'info',
    summary: found.length
      ? `${found.length} alive nodes past our ${bestKm.toFixed(1)} km best are blocked only by the ${windowKm} km window`
        + ` — the nearest needs ${found[0].widen_to} km (${found[0].name} at ${found[0].km} km)`
      : `no node past our ${bestKm.toFixed(1)} km best is blocked by the ${windowKm} km window`,
    detail: {
      best_reached_km: +bestKm.toFixed(1),
      window_km: windowKm,
      max_silence_days: days,
      blocked: found.length,
      note: 'step is measured from PROVEN ground (answered at least once), not from home',
      top: found.slice(0, 12),
    },
  });
}

/** WHICH RELAY SERVES WHICH BEARING.
 *
 *  Peter, 2026-08-03: "if we dont have a route to that node, we can choose one
 *  that would be likely, given the locations of other nodes routing through it.
 *  another case for a worker / hook." And then the decision that makes it
 *  matter: "whatever happens I dont think we should be targeting remote nodes
 *  directly. that is pointless (pun intended)."
 *
 *  He is right, and the data is blunt about it. We aim the yagi at the target's
 *  bearing, but the mesh transmits to the FIRST HOP — and the first hop falls
 *  OUTSIDE the 35 degree beam ~87% of the time. We point at something we never
 *  talk to. Measured by distance band: 0-50 km 84%, 50-100 km 100%, 100-150 km
 *  100%, 150+ km 93%. It is wrong everywhere, not just close in.
 *
 *  This worker unblocks `aim-at-the-first-hop`, which was STOPPED because
 *  aiming at `route[0]` needs a prior success and the shortlist is
 *  never-answered by definition. A corridor map does not need the target's own
 *  route — only that some OTHER node in that direction has been routed before.
 *
 *  MEASURED, 70/30 time split over 2,734 answered routes — INCLUDING the
 *  baseline I first forgot to test, which changes the conclusion:
 *
 *    aim at the target (what we do today)      ~13% of first hops in beam
 *    nearest proven relay by bearing            13%   worthless, median 148 deg
 *    relay that SERVES that bearing             32% exact
 *    ALWAYS AIM AT THE COMMONEST DOOR           63% exact   <- twice as good
 *
 *  The bearing model is HALF as good as a constant. I reported it as "roughly
 *  doubles the hit rate" before testing against a constant baseline, which was
 *  the wrong comparator and made a weak model look strong.
 *
 *  THE REAL FINDING IS SIMPLER: there is ONE DOMINANT DOOR. `T4`, 5.3 km away,
 *  is the first hop for 63% of every route we have ever completed. It sits on
 *  bearing 274 deg and serves targets at 98 deg — a relay to our WEST is the way
 *  out to the EAST, which is why aiming anywhere near the target is hopeless.
 *
 *  AND THAT UNDERCUTS THE YAGI ENTIRELY. A door 5.3 km away needs no gain; the
 *  omni reaches it comfortably. So for most targets the yagi confers nothing
 *  whatever it points at, which is independent support for the standing
 *  recommendation to run DISC on the OMNI.
 *
 *  IT REPORTS, IT DOES NOT AIM. Changing where the beam points alters live RF on
 *  a shared band and needs its own before/after — the discipline that stopped
 *  the original task from being built on an argument. Publishing the prediction
 *  also lets it be scored against reality for free before anything moves.
 *
 *  HONEST LIMIT, published in the payload: trained and tested on SUCCESSES. The
 *  targets we actually probe have never answered and may be unreachable for
 *  reasons that have nothing to do with aim. 35% is a minority.
 */
function runRelayCorridors() {
  const home = homeLatLon();
  if (!home) {
    T.relayCorridors.emit({ summary: 'cannot place ourselves, so no corridor can be learned', detail: {} });
    return;
  }
  const pos = new Map(db.prepare('SELECT num, lat, lon FROM nodes WHERE lat IS NOT NULL AND lat <> 0')
    .all().map(r => [r.num, r]));

  // (relay -> bearings of the targets it carried). Only ANSWERED routes carry a
  // route at all, so this is the whole available evidence.
  const served = new Map();
  for (const r of db.prepare(`SELECT to_num, route FROM traceroute_history
                               WHERE status='ok' AND route <> '[]'`).all()) {
    const t = pos.get(r.to_num); if (!t) continue;
    const chain = J(r.route).filter(n => n !== BROADCAST);
    if (!chain.length) continue;
    const first = chain[0];
    if (!pos.has(first)) continue;
    if (!served.has(first)) served.set(first, []);
    served.get(first).push(bearingOf(home.lat, home.lon, t.lat, t.lon));
  }

  // Below 5 served targets the median bearing is noise, not a corridor.
  const MIN_SERVED = 5;
  const corridors = [];
  for (const [relay, arr] of served) {
    if (arr.length < MIN_SERVED) continue;
    const a = [...arr].sort((x, y) => x - y);
    const med = a[Math.floor(a.length / 2)];
    const p = pos.get(relay);
    const n = db.prepare('SELECT short_name, long_name FROM nodes WHERE num = ?').get(relay);
    corridors.push({
      relay, name: n?.short_name || n?.long_name || `!${relay.toString(16)}`,
      serves_bearing: Math.round(med),
      spread: Math.round(a[Math.floor(a.length * 0.9)] - a[Math.floor(a.length * 0.1)]),
      // THE RELAY'S OWN BEARING AND THE BEARING IT SERVES ARE DIFFERENT NUMBERS,
      // and that difference is the entire finding — a relay 5 km away on 040 deg
      // can be the door to a corridor at 200 deg.
      relay_bearing: Math.round(bearingOf(home.lat, home.lon, p.lat, p.lon)),
      relay_km: +haversineKm(home.lat, home.lon, p.lat, p.lon).toFixed(1),
      carried: arr.length,
    });
  }
  corridors.sort((x, y) => y.carried - x.carried);
  const totalRoutes = [...served.values()].reduce((a, b) => a + b.length, 0) || 1;

  if (corridors.length < 3) {
    T.relayCorridors.emit({
      summary: `only ${corridors.length} relays have carried ${MIN_SERVED}+ targets — too few to map corridors yet`,
      detail: { corridors, min_served: MIN_SERVED },
    });
    return;
  }

  T.relayCorridors.emit({
    severity: 'notice',
    summary: `"${corridors[0].name}" is the door for ${Math.round(100 * corridors[0].carried / totalRoutes)}% of completed routes`
      + ` — ${corridors[0].relay_km} km away on ${corridors[0].relay_bearing}°, serving ${corridors[0].serves_bearing}°`
      + ` (${corridors.length} relays mapped; aiming at the target hits the real first hop ~13% of the time)`,
    detail: {
      min_served: MIN_SERVED,
      skill: 'bearing model 32% exact vs 63% for ALWAYS picking the commonest door, and ~13% for aiming at the target (70/30 split, n=2734) — the bearing model is WORSE than a constant',
      dominant_door: 'one relay is the first hop for 63% of all completed routes; that, not the bearing map, is the actionable finding',
      limit: 'trained on ANSWERED routes only; the targets we probe have never answered and may be unreachable for reasons unrelated to aim',
      note: 'REPORTS ONLY — nothing here changes where the beam points',
      corridors,
    },
  });
}

/** A DEAD PROBER ON A LIVE MESH.
 *
 *  Between 28 July and 1 August we sent **14 traceroutes** — against roughly a
 *  thousand a day either side — while still RECEIVING 2,256 messages. The mesh
 *  was fine. We had stopped asking, and nothing anywhere said so; the gap was
 *  only found by plotting a daily series five days later.
 *
 *  Receiving is the control. Silence on both sides is a quiet mesh and not our
 *  problem; hearing plenty while sending nothing is OUR fault, every time.
 */
function runProbingStalled() {
  const now = Math.floor(Date.now() / 1000);
  // LIVENESS COMES FROM relay_observation, NOT messages. `messages` holds TEXT
  // packets only — 29 in 6 h against 9,794 relay observations — so a threshold
  // built on it would sit near zero and could call a real stall "healthy".
  // relay_observation records EVERY received packet, which is what "is the mesh
  // talking to us" actually means.
  const rx = db.prepare('SELECT COUNT(*) n FROM relay_observation WHERE ts > ?').get(now - 6 * 3600).n;
  const tx = db.prepare('SELECT COUNT(*) n FROM traceroute_history WHERE ts > ?').get(now - 6 * 3600).n;
  // Judged against the configured cadence, not a guessed number: interval_sec
  // implies a rate, and a tenth of it is unambiguously broken rather than slow.
  const interval = Number(discoveryConfig().interval_sec) || 180;
  const expected = Math.floor((6 * 3600) / interval);
  const floor = Math.max(1, Math.floor(expected / 10));

  const stalled = rx > 200 && tx < floor;
  T.stalled.emit({
    severity: stalled ? 'fault' : 'info',
    summary: stalled
      ? `PROBING STALLED — ${tx} traceroutes in 6h while hearing ${rx} packets (expected ~${expected})`
      : `probing healthy — ${tx} traceroutes in 6h, ${rx} packets heard`,
    detail: { traceroutes_6h: tx, packets_heard_6h: rx, expected, floor, interval_sec: interval },
  });
}

/** WHEN did the rate change, not whether.
 *
 *  A slope is arguable; a STEP has a date, and a date can be matched against a
 *  deploy, a config write or a firmware change. The close-range answer rate fell
 *  from 35-45% to ~11% on 2026-07-17 and never recovered — found by eye, five
 *  days after the fact, and still unexplained.
 *
 *  Compares the last 7 days against the 7 before, then walks the daily series to
 *  name the day it broke. Days below MIN_ATT are skipped rather than plotted as
 *  zero: a gap means "not known" and a zero means "nothing worked".
 */
function runRateChangepoint() {
  const MIN_ATT = 30;
  const rows = db.prepare(`
    SELECT date(ts,'unixepoch') d, COUNT(*) n, SUM(status='ok') ok
      FROM traceroute_history
     WHERE ts > strftime('%s','now') - 30*86400
       AND ts > (SELECT MIN(ts) FROM traceroute_history WHERE status <> 'ok')
     GROUP BY d ORDER BY d`).all().filter(r => r.n >= MIN_ATT);
  if (rows.length < 8) {
    T.changepoint.emit({ summary: `only ${rows.length} days carry enough attempts to compare`, detail: { days: rows.length } });
    return;
  }
  const pct = rows.map(r => ({ d: r.d, p: 100 * r.ok / r.n, n: r.n }));
  // Largest drop between the mean before a day and the mean from it onward.
  let best = null;
  for (let i = 3; i < pct.length - 2; i++) {
    const a = pct.slice(0, i), b = pct.slice(i);
    const ma = a.reduce((s, x) => s + x.p, 0) / a.length;
    const mb = b.reduce((s, x) => s + x.p, 0) / b.length;
    const drop = ma - mb;
    if (!best || drop > best.drop) best = { drop, at: pct[i].d, before: ma, after: mb };
  }
  const real = best && best.drop >= 10;
  T.changepoint.emit({
    severity: real ? 'notice' : 'info',
    summary: real
      ? `answer rate stepped down on ${best.at} — ${best.before.toFixed(1)}% before, ${best.after.toFixed(1)}% since`
      : `no step in the answer rate over ${pct.length} comparable days (largest shift ${best ? best.drop.toFixed(1) : 0} pts)`,
    detail: { ...best, days_compared: pct.length, min_attempts_per_day: MIN_ATT,
              note: 'a STEP has a date and can be matched to a deploy or config change; a slope cannot' },
  });
}

/** AIMED MISSIONS vs PASSIVE, ON THE SAME NODES.
 *
 *  The raw split flatters passive, because missions deliberately pick harder
 *  targets. Measured 2026-08-03: raw 4.2% vs 10.9%, but on the 68 nodes tried by
 *  BOTH in the same day it was 9.1% vs 12.4% — selection explained most of the
 *  gap and not all of it.
 *
 *  Like-for-like is the only honest form of this comparison, and it is the
 *  control this project has had to apply by hand three times.
 */
function runDispatcherYield() {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const side = (aimed) => db.prepare(`
    SELECT to_num, COUNT(*) n, SUM(status='ok') ok FROM traceroute_history
     WHERE ts > ? AND rotator_az IS ${aimed ? 'NOT NULL' : 'NULL'} GROUP BY to_num`).all(since);
  const m = new Map(side(true).map(r => [r.to_num, r]));
  const p = new Map(side(false).map(r => [r.to_num, r]));
  let mn = 0, mo = 0, pn = 0, po = 0, both = 0;
  for (const [num, a] of m) {
    const b = p.get(num); if (!b) continue;
    both++; mn += a.n; mo += a.ok; pn += b.n; po += b.ok;
  }
  if (both < 5 || !mn || !pn) {
    T.dispatchers.emit({ summary: `only ${both} nodes were tried by both dispatchers — too few to compare`, detail: { both } });
    return;
  }
  const mr = 100 * mo / mn, pr = 100 * po / pn;
  T.dispatchers.emit({
    severity: mr < pr * 0.75 ? 'notice' : 'info',
    summary: `on the same ${both} nodes: aimed ${mr.toFixed(1)}% (${mo}/${mn}) vs passive ${pr.toFixed(1)}% (${po}/${pn})`,
    detail: { shared_nodes: both, aimed_pct: +mr.toFixed(1), passive_pct: +pr.toFixed(1),
              note: 'LIKE-FOR-LIKE — the raw split flatters passive because missions pick harder targets' },
  });
}

/** WHAT THE PUBLIC CALLOUTS ACTUALLY BOUGHT.
 *
 *  Callouts spend social capital rather than airtime, so their yield has to be
 *  visible or the cost is invisible too. `calloutStats()` existed and nothing
 *  ever emitted it.
 *
 *  0 of 6 proves nothing — at a 6/day ceiling this needs weeks — and the summary
 *  says so rather than reading as a verdict.
 */
function runCalloutYield() {
  const r = db.prepare(`
    SELECT COUNT(*) sent, SUM(replied_ts IS NOT NULL) answered, MAX(reply_km) best_km
      FROM callout_log WHERE ts > strftime('%s','now') - 30*86400`).get();
  const sent = r.sent || 0, answered = r.answered || 0;
  if (!sent) {
    T.calloutYield.emit({ summary: 'no callouts sent in 30 days', detail: { sent: 0 } });
    return;
  }
  T.calloutYield.emit({
    severity: answered ? 'notice' : 'info',
    summary: answered
      ? `${answered} of ${sent} callouts answered — best two-way ${r.best_km} km`
      : `${sent} callouts sent, none answered yet`
        + (sent < 30 ? ' (too few to read anything into)' : ' — worth questioning the wording or the audience'),
    detail: { sent, answered, best_two_way_km: r.best_km ?? null,
              note: 'a reply is two-way contact at a known distance — the strongest reach evidence there is' },
  });
}

// Every other relay signal we hold is INBOUND — relay_byte says who relayed TO
// us, and this mesh routes 62% asymmetrically, so every door claim in doors.js
// is an inference from the wrong direction. message_status_event is the
// exception: mesh-gw's `relayed` status names a node that handled a packet WE
// sent, by full node number, with none of the low-byte ambiguity.
//
// THE TRAP: on a BROADCAST that node is OUR OWN RADIO. FloodingRouter.cpp
// generates the implicit ack locally when the sender hears its own packet
// rebroadcast (measured: relayed from_num 646426545 = !2687afb1 = our OMNI).
// Counting those would manufacture discoveries out of our own transmissions, so
// they are excluded — and reported separately, so the exclusion is visible.
function runOutboundRelayIdentity() {
  const rows = db.prepare(`
    SELECT from_num, COUNT(*) n, MAX(ts) last_ts
      FROM message_status_event
     WHERE from_num IS NOT NULL
     GROUP BY from_num`).all();

  // ownDeviceNums() returns an EMPTY SET until index.js registers the mac->num
  // resolver at startup, so on its own it is not safe to hang a correctness
  // guard on: unregistered, every self-ack is promoted to a discovery. Caught in
  // testing, where this worker reported our own OMNI as a third-party relay.
  // Union it with a durable source that needs no registration — packets our own
  // radios originated are marked TRANSPORT_INTERNAL on arrival.
  const ours = new Set([
    ...ownDeviceNums(),
    ...db.prepare(`SELECT DISTINCT from_num n FROM relay_observation
                    WHERE transport = 'TRANSPORT_INTERNAL'`).all().map(r => r.n),
  ]);
  const selfAcks = rows.filter(r => ours.has(r.from_num));
  const third    = rows.filter(r => !ours.has(r.from_num));

  if (!third.length) {
    // Silence is indistinguishable from a broken worker — say it plainly.
    T.outboundRelay.emit({
      severity: 'info',
      summary: selfAcks.length
        ? `no third-party outbound relays yet — all ${selfAcks.length} identities are our own radios self-acking broadcasts`
        : 'no outbound relay identities captured yet',
      detail: { third_party: 0, self_acks: selfAcks.length, rows_scanned: rows.length },
    });
    return;
  }

  const home = homeLatLon();
  const doors = new Set();
  for (const r of db.prepare(`SELECT route FROM traceroute_history
                               WHERE status='ok' AND route <> '[]'`).all()) {
    const chain = J(r.route).filter(n => n !== BROADCAST);
    if (chain.length) doors.add(chain[0]);
  }

  const found = third.map(r => {
    const node = db.prepare('SELECT short_name, long_name, lat, lon FROM nodes WHERE num = ?').get(r.from_num);
    const positioned = node && node.lat != null && node.lat !== 0;
    const km = (positioned && home) ? +haversineKm(home.lat, home.lon, node.lat, node.lon).toFixed(1) : null;
    return {
      num: r.from_num,
      name: node?.short_name || node?.long_name || null,
      known: !!node,
      already_a_door: doors.has(r.from_num),
      km,
      // ASKED, not repeated. This was a literal 40 duplicating doors.js, so an
      // antenna upgrade would have moved one and not the other. beamWorthItKm()
      // derives it from the rotator's configured gain.
      worth_the_beam: km != null ? km >= beamWorthItKm() : null,
      acks: r.n,
    };
  });

  const fresh = found.filter(f => !f.already_a_door);
  T.outboundRelay.emit({
    severity: fresh.length ? 'notice' : 'info',
    summary: fresh.length
      ? `${fresh.length} of ${found.length} nodes that ACKed our sends are NOT known doors — outbound evidence for a relay we have never routed through`
      : `${found.length} outbound relay identities, all already known doors`,
    detail: { third_party: found.length, self_acks: selfAcks.length, nodes: found },
  });
}

// Is the mesh still yielding nodes we have NEVER reached, or are we re-tracing
// the same few more often? Every other panel counts traffic; none separates
// ground taken from ground repeated. If first-ever contacts go to zero while
// attempts sit at 1140/day, we are spending airtime on nodes we already own.
//
// Reported AGAINST THE DENOMINATOR, because 4-of-1140 and 4-of-12 are opposite
// findings and the raw count cannot tell them apart.
//
// Counts more than the frontier chart can draw: frontier.reach needs a position
// (a bar needs a height), but new ground does not — a first-ever answer from an
// unpositioned node is still a node we had never reached. Measured 2026-08-03:
// 6 first-ever that day, only 2 plottable.
function runNewGround() {
  const days = Number(getConfig('observatory.window_days', 7)) || 7;
  const from = Math.floor(Date.now() / 1000) - days * 86400;

  const att = db.prepare(`SELECT COUNT(*) n, SUM(status='ok') ok
                            FROM traceroute_history WHERE ts >= ?`).get(from);
  const attempts = att?.n || 0;

  // First-ever answer per node across ALL history; those landing in the window
  // are the ground taken. Unfiltered by position, deliberately.
  const fresh = db.prepare(`
    WITH firsts AS (SELECT to_num, MIN(ts) t FROM traceroute_history
                     WHERE status='ok' GROUP BY to_num)
    SELECT f.to_num, f.t, n.short_name, n.long_name, n.lat, n.lon
      FROM firsts f LEFT JOIN nodes n ON n.num = f.to_num
     WHERE f.t >= ? ORDER BY f.t`).all(from);

  // The prior bar: furthest verified BEFORE this window opened. A new contact
  // beyond it is one that actually moved the frontier.
  const home = homeLatLon();
  let priorBest = 0;
  if (home) {
    for (const r of db.prepare(`
      SELECT n.lat, n.lon FROM traceroute_history t JOIN nodes n ON n.num = t.to_num
       WHERE t.status='ok' AND t.ts < ? AND n.lat IS NOT NULL AND n.lat <> 0`).all(from)) {
      const km = haversineKm(home.lat, home.lon, r.lat, r.lon);
      if (km <= 250 && km > priorBest) priorBest = km;
    }
  }

  let moved = 0, unpositioned = 0;
  const named = [];
  for (const f of fresh) {
    const positioned = home && f.lat != null && f.lat !== 0;
    if (!positioned) { unpositioned++; named.push({ name: f.short_name || f.long_name || null, km: null }); continue; }
    const km = haversineKm(home.lat, home.lon, f.lat, f.lon);
    if (km > 250) { unpositioned++; named.push({ name: f.short_name || f.long_name || null, km: null }); continue; }
    if (km > priorBest) moved++;
    named.push({ name: f.short_name || f.long_name || null, km: +km.toFixed(1) });
  }

  if (!fresh.length) {
    // THE FINDING THIS WORKER EXISTS FOR. Silence here would be
    // indistinguishable from a broken worker, and "0 of 1140" is the alarm.
    T.newGround.emit({
      severity: attempts > 200 ? 'notice' : 'info',
      summary: `no new ground in ${days}d — 0 first-ever contacts from ${attempts} attempts`,
      detail: { window_days: days, attempts, first_ever: 0, moved_frontier: 0 },
    });
    return;
  }

  T.newGround.emit({
    severity: moved ? 'notice' : 'info',
    summary: `${fresh.length} first-ever contact${fresh.length === 1 ? '' : 's'} in ${days}d `
           + `from ${attempts} attempts`
           + (moved ? ` — ${moved} moved the frontier past ${priorBest.toFixed(1)} km` : ' — none moved the frontier'),
    detail: { window_days: days, attempts, answered: att?.ok || 0,
              first_ever: fresh.length, moved_frontier: moved,
              unpositioned, prior_best_km: +priorBest.toFixed(1), nodes: named },
  });
}

// EXPLORERS. Peter, 2026-08-04: "whatever the logic that calculates or flags
// this as an important node, should flag this node as being an explorer."
//
// An explorer's traffic reliably crosses a long distance and several hops to
// reach us, while it never answers anything we send. That is evidence a CORRIDOR
// exists in its direction — the node is the far end of a working path, and the
// relays along that path are the prize. PUCK arrives through our own ordinary
// doors (fir, T4) after ~4 hops, so the interesting 3 hops are upstream and
// completely unobserved.
//
// Ranked by TRAFFIC, not distance, because the defining quality is consistency:
// a node heard once at 240 km is a fluke, not an explorer.
function runExplorers() {
  const minKm      = Number(getConfig('explorers.min_km', 40)) || 40;
  const minHops    = Number(getConfig('explorers.min_hops', 2)) || 2;
  const minTraffic = Number(getConfig('explorers.min_traffic', 20)) || 20;
  const days       = Number(getConfig('observatory.window_days', 7)) || 7;
  const home = homeLatLon();
  if (!home) {
    T.explorers.emit({ severity: 'info', summary: 'cannot place ourselves — no explorer ranking possible', detail: {} });
    return;
  }

  // Our own radios are excluded by TRANSPORT, never by name.
  const ours = new Set(db.prepare(`SELECT DISTINCT from_num n FROM relay_observation
                                    WHERE transport = 'TRANSPORT_INTERNAL'`).all().map(r => r.n));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const rows = db.prepare(`
    SELECT n.num, n.short_name, n.long_name, n.lat, n.lon, n.last_heard,
           (SELECT COUNT(*) FROM messages m          WHERE m.from_num = n.num AND m.ts > ?) msgs,
           (SELECT COUNT(*) FROM relay_observation r WHERE r.from_num = n.num) pkts,
           (SELECT MAX(hop_start - hop_limit) FROM relay_observation r
             WHERE r.from_num = n.num AND r.hop_start IS NOT NULL) max_hops,
           (SELECT COUNT(*) FROM traceroute_history t WHERE t.to_num = n.num AND t.status='ok') answered,
           (SELECT COUNT(*) FROM traceroute_history t WHERE t.to_num = n.num) tried,
           n.role
      FROM nodes n
     WHERE n.lat IS NOT NULL AND n.lat <> 0 AND n.last_heard > ?`).all(since, since);

  const found = [];
  for (const r of rows) {
    if (ours.has(r.num)) continue;
    if (r.answered > 0) continue;                       // it answered — a contact, not an explorer
    const km = haversineKm(home.lat, home.lon, r.lat, r.lon);
    if (km < minKm || km > 250) continue;               // 250 = MQTT plausibility ceiling
    if ((r.max_hops ?? 0) < minHops) continue;          // a neighbour is not an explorer
    // Traffic counts messages AND packets: a node can be consistently present
    // without ever sending text.
    const traffic = (r.msgs || 0) + (r.pkts || 0);
    if (traffic < minTraffic) continue;
    // ROLE CHANGES WHAT A NON-ANSWER MEANS. Peter, 2026-08-04: "repeaters are
    // gold dust to us" — a relay-capable node is a DOOR CANDIDATE, while a
    // CLIENT_MUTE cannot relay for anyone by configuration and never will be,
    // however close or chatty it is. Silence from a router is worth chasing;
    // silence from a mute client is the node working as designed.
    const role = r.role || null;
    const relay_capable = RELAY_ROLES.has(role);
    found.push({ num: r.num, name: r.short_name || r.long_name || `!${(r.num >>> 0).toString(16)}`,
                 km: +km.toFixed(1), hops: r.max_hops, traffic, tried: r.tried,
                 role, relay_capable, can_never_relay: role === 'CLIENT_MUTE' });
  }
  // Relay-capable first, then by traffic: a router we cannot reach is a missing
  // door, which is worth more than a chatty client that could never be one.
  found.sort((a, b) => (b.relay_capable - a.relay_capable) || (b.traffic - a.traffic));

  if (!found.length) {
    T.explorers.emit({ severity: 'info',
      summary: `no explorers — nothing beyond ${minKm} km reaches us consistently`,
      detail: { min_km: minKm, min_hops: minHops, min_traffic: minTraffic, window_days: days } });
    return;
  }
  const furthest = found.reduce((a, b) => (b.km > a.km ? b : a));
  const relays = found.filter(f => f.relay_capable);
  T.explorers.emit({
    severity: relays.length ? 'notice' : 'info',
    summary: relays.length
      ? `${relays.length} RELAY-CAPABLE explorers of ${found.length} — furthest ${relays[0].km >= furthest.km ? relays[0].name : furthest.name} `
        + `at ${Math.max(relays[0].km, furthest.km)} km; ${relays[0].name} is a ${relays[0].role} tried ${relays[0].tried}x, never answered`
      : `${found.length} explorers, none relay-capable — furthest ${furthest.name} at ${furthest.km} km`,
    detail: { min_km: minKm, min_hops: minHops, min_traffic: minTraffic, window_days: days,
              count: found.length, relay_capable: relays.length, nodes: found.slice(0, 20) },
  });
}

const TASKS = [runUnknownNodes, runGhostRelays, runAsymmetricPaths,
               runStrandedPositions, runAnchorableNodes, runBlockedCorridors,
               runRelayCorridors, runProbingStalled, runRateChangepoint,
               runDispatcherYield, runCalloutYield, runOutboundRelayIdentity,
               runNewGround, runExplorers];

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
  setTimeout(runStandingTasks, timing().first_run_ms);
  setInterval(runStandingTasks, mins * 60_000);
}
