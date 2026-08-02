// The catalogue — every value this system works out rather than is told.
//
// Peter, 2026-08-02: "the hooks should be a seperate file, so it's easy to see
// our calculated functions in 1 place, the file will grow as we think of new
// things to get / extract. so each will be a small func that does one thing."
//
// Read this file top to bottom and you have seen everything node-dash infers.
// That is the whole point of it being one file, and it is worth protecting: an
// inference that lives anywhere else is invisible.
//
// THIS FILE IS DOMAIN CODE. It knows what a bearing is, what a node is, what a
// relay is. The engine (observatory.js) knows none of that and must never learn
// — the split is what keeps the engine testable and reusable, and it is enforced
// by tests/test_observatory_boundary.mjs, which permits exactly two importers of
// the engine: the composition root, and this catalogue.
//
// ─── THE RULES EVERY INFERENCE OBEYS ────────────────────────────────────────
//
// 1. PURE. A function of the evidence it is handed and nothing else. No database
//    access inside, no clock, no randomness, no network.
//
//    This is not a style preference and it is the rule most likely to be broken
//    for convenience. An inference that reaches for the database itself cannot
//    be recomputed over history, cannot be tested without a database, and
//    silently destroys the retroactive property that is the entire reason the
//    registry exists (MESH_REACH_SPEC §7f). If an inference needs more evidence,
//    it DECLARES it and the runner fetches it.
//
// 2. SMALL, AND ONE THING. If it does two things it is two inferences.
//
// 3. `null` IS A REAL ANSWER. "Not enough evidence yet" is returned, never
//    thrown and never faked as a zero — a plausible wrong value is worse than an
//    absent one.
//
// 4. NO PROVENANCE BY HAND. The runner stamps what produced a value, when, from
//    how much evidence. An inference that writes its own provenance can launder
//    itself as a fact.
//
// 5. GRADUATION. When a function outgrows a page — peak-RSSI bearing estimation
//    with windowing and outlier rejection will — it moves to its own file and is
//    imported and registered here. This file stays the index either way.
//
// ─── THE CATALOGUE ──────────────────────────────────────────────────────────
//
//   relay.usage     the doors — traffic carried, targets behind, furthest reach
//   reach.target    per target: km, bearing, attempts, hits, verified
//   reach.ladder    one global fact: every moment the frontier moved
//   link.observed   every witnessed node-to-node hop, both ends placed
//   reach.mission   what to try next, and why — the memory the prober lacks
//
// All five are BATCH and spend no airtime at all: four read obs_v_traceroute, a
// view over five weeks of traceroute history that already existed, and
// reach.mission reads `nodes` LEFT JOINed to it so that targets never attempted
// are in the pool rather than invisible.
//
// This file was created EMPTY by task `observatory-inference-catalogue-boundary`
// so the boundary test was correct BEFORE anything pressed on it. Widening a
// boundary test to admit code that already exists is how boundaries die.
//
// STILL MISSING: the antenna-bearing estimator. Its capture half is not an
// inference — recording where the antenna pointed is an observation — and the
// estimate is blocked on DATA, not code: 305 recorded bearings span two distinct
// azimuths because the rotator has not moved (B54). An estimator over that would
// confidently place every unplaced node at 119°.
import { registerInference } from './observatory.js';

// ─── relay.usage ────────────────────────────────────────────────────────────
//
// WHICH RELAYS CARRY OUR TRAFFIC, AND HOW MUCH OF THE MESH SITS BEHIND EACH.
// The doors of MESH_REACH_SPEC §7a: our reach is not a radius, it is a tree with
// a few load-bearing doors, and 57 relays carry every route we have ever
// completed. If T4 goes off air, 79 targets go with it — a fact worth seeing
// before it happens rather than after.
//
// EVIDENCE IS DECLARED, NOT FETCHED. The inference cannot query without
// destroying its own purity, and the engine cannot query on its behalf without
// learning what a route is. So the SQL lives here, with the inference that owns
// it, and the engine executes it understanding nothing.
//
// json_each expands the route ARRAY inside the JSON payload into one row per
// hop — so a nested array inside a JSON column inside a view over a table nobody
// migrated becomes a graph, in SQL, with no parsing in JavaScript. Verified on
// SQLite 3.53.2.
//
// BOTH DIRECTIONS. route_back is included because the way home is not the way
// out: 23 relays appear ONLY on return paths (§7b). They carried our traffic and
// nothing ever chose them.
//
// 0xffffffff IS EXCLUDED. The broadcast address appears in stored route fields
// and is not a node — it ranked eighth in the door list on first run, with 49
// targets "behind" it, which is meaningless. MESH_REACH_SPEC §7b flags it as a
// question about our own parsing rather than a relay to go and find; until that
// is settled it must not be presented as a door.
registerInference({
  key:  'relay.usage',
  deps: [],
  mode: 'batch',   // recomputed from all history; cheap enough at this size
  evidence: `
    SELECT j.value AS relay, o.entity AS target, n.lat AS lat, n.lon AS lon,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat') AS home_lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon') AS home_lon
    FROM obs_v_traceroute o
    LEFT JOIN nodes n ON n.num = CAST(o.entity AS INTEGER)
    , json_each(o.data ->> '$.route') j
    WHERE o.data ->> '$.status' = 'ok' AND j.value <> 4294967295
    UNION ALL
    SELECT j.value, o.entity, n.lat, n.lon,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat'),
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon')
    FROM obs_v_traceroute o
    LEFT JOIN nodes n ON n.num = CAST(o.entity AS INTEGER)
    , json_each(o.data ->> '$.route_back') j
    WHERE o.data ->> '$.status' = 'ok' AND j.value <> 4294967295
  `,
  /** Pure: rows in, facts out. No database, no clock, no randomness.
   *
   *  `targets` is what makes a relay a door — how much becomes unreachable if
   *  it stops. `uses` is how much traffic it has actually carried, which is a
   *  different question and the two disagree often enough to be worth keeping
   *  apart. */
  run(rows) {
    const byRelay = new Map();
    for (const r of rows) {
      const relay = String(r.relay);
      let e = byRelay.get(relay);
      if (!e) byRelay.set(relay, e = { uses: 0, targets: new Set(), furthest: null });
      e.uses += 1;
      if (r.target != null) e.targets.add(String(r.target));
      // FURTHEST TARGET BEHIND THIS DOOR — the reason a relay matters, as
      // opposed to how busy it is. A relay carrying a lot of local chatter and
      // one holding open the Cornwall corridor look identical in `uses`.
      // Suspect distances (>200 km, §12) are excluded here too, so a bad
      // self-reported position cannot make a door look more important than it is.
      if (r.lat != null && r.lon != null && r.home_lat != null && r.home_lon != null) {
        const km = greatCircleKm(r.home_lat, r.home_lon, r.lat, r.lon);
        if (km <= 200 && (e.furthest == null || km > e.furthest)) e.furthest = km;
      }
    }
    return [...byRelay].map(([entity, e]) => ({
      entity,
      value: {
        uses: e.uses,
        targets: e.targets.size,
        furthest_km: e.furthest == null ? null : Math.round(e.furthest * 10) / 10,
      },
      // No confidence offered: this is a count of what was observed, not an
      // estimate. A made-up 1.0 would imply a judgement nothing here made.
      confidence: null,
      evidence_count: e.uses,
    }));
  },
});

// ─── reach.target ───────────────────────────────────────────────────────────
//
// HOW FAR WE HAVE VERIFIABLY REACHED, PER TARGET. The headline this project
// resolves to (MESH_REACH_SPEC §1a: "at the end of all calculations the single
// important value will be in km").
//
// Home comes through the EVIDENCE, not from a config read inside run(). Reading
// it here would make the calculation impure and untestable without a database
// for the sake of two numbers. Carried on every row is mildly redundant and
// exactly correct.
//
// The distance is computed in run() rather than in SQL. SQLite has the trig
// (3.53.2 has radians/sin/asin/pi) so either would work, but an inference that
// only relabels its evidence is not really a calculation — and haversine over
// plain numbers is the easiest thing in the world to test.
const HAVERSINE_R_KM = 6371;
/** Initial great-circle bearing, degrees from true north. Pure. */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad)
          - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
function greatCircleKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return HAVERSINE_R_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

registerInference({
  key:  'reach.target',
  deps: [],
  mode: 'batch',
  evidence: `
    SELECT o.entity                                                   AS target,
           COUNT(*)                                                   AS attempts,
           SUM(CASE WHEN o.data ->> '$.status' = 'ok' THEN 1 ELSE 0 END) AS hits,
           MAX(CASE WHEN o.data ->> '$.status' = 'ok' THEN o.ts END)  AS last_ok,
           MAX(o.ts)                                                  AS last_attempt,
           n.lat                                                      AS lat,
           n.lon                                                      AS lon,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat') AS home_lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon') AS home_lon
    FROM obs_v_traceroute o
    LEFT JOIN nodes n ON n.num = CAST(o.entity AS INTEGER)
    GROUP BY o.entity
  `,
  /** Pure. Rows in, facts out.
   *
   *  A TARGET WITH NO HIT IS STILL RECORDED, with verified:false and its attempt
   *  count. MESH_REACH_SPEC §4: silence is censored data, so the stored fact is
   *  "verified reach >= X", never "unreachable". 335 targets have never once
   *  answered across 5,046 attempts and dropping them would hide the most
   *  important number in the project.
   *
   *  A TARGET WITH NO POSITION GETS km:null, not 0. It was still reached; we
   *  simply cannot say how far. Only 84 of 104 verified targets have a position,
   *  so this is common and must not read as "zero kilometres". */
  run(rows) {
    return rows.map(r => {
      const km = (r.lat != null && r.lon != null && r.home_lat != null && r.home_lon != null)
        ? Math.round(greatCircleKm(r.home_lat, r.home_lon, r.lat, r.lon) * 10) / 10
        : null;
      const bearing = (r.lat != null && r.lon != null && r.home_lat != null && r.home_lon != null)
        ? Math.round(bearingDeg(r.home_lat, r.home_lon, r.lat, r.lon))
        : null;
      return {
        entity: String(r.target),
        value: {
          km,
          // Bearing FROM US to the target, computed from stored positions. Not
          // to be confused with the antenna bearing recorded on a reception
          // (docs/modules/observations.md) — that one is a measurement, this is
          // geometry. Keeping the two apart matters: one can verify the other.
          bearing,
          attempts:     r.attempts,
          hits:         r.hits,
          verified:     r.hits > 0,
          last_ok:      r.last_ok ?? null,
          last_attempt: r.last_attempt ?? null,
          // §12: a self-reported position can be wrong, and a km headline will
          // launder it into a record. EA1HTF claims 1003 km and arrives at
          // -44 dBm. Flagged here so nothing downstream has to remember.
          suspect: km != null && km > 200,
        },
        confidence: null,
        evidence_count: r.attempts,
      };
    });
  },
});

// ─── reach.ladder ───────────────────────────────────────────────────────────
//
// EVERY MOMENT THE FRONTIER MOVED. One fact, entity 'global', because a ladder
// is a property of the whole record rather than of any node.
//
// It is the product's narrative (MESH_REACH_SPEC §1a) and it says something
// uncomfortable that a single headline number hides: the whole climb from 5 km
// to 95 km happened in about eighteen hours on 24 June, then 181.6 km the next
// morning — and the frontier has moved 7.5 km in the five weeks since. A system
// that iterates without learning plateaus, and this is the shape of the plateau.
//
// SUSPECT DISTANCES ARE EXCLUDED from the ladder, not merely flagged. A record
// is a claim, and §12 is explicit that a km headline will launder a bad
// self-reported position into one. A flag on a row nobody reads is not a guard.
registerInference({
  key:  'reach.ladder',
  deps: [],
  mode: 'batch',
  evidence: `
    SELECT o.ts                                                       AS ts,
           o.entity                                                   AS target,
           n.lat                                                      AS lat,
           n.lon                                                      AS lon,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat') AS home_lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon') AS home_lon
    FROM obs_v_traceroute o
    JOIN nodes n ON n.num = CAST(o.entity AS INTEGER)
    WHERE o.data ->> '$.status' = 'ok' AND n.lat IS NOT NULL AND n.lon IS NOT NULL
    ORDER BY o.ts
  `,
  /** Pure. A running maximum over hits in time order. */
  run(rows) {
    let best = 0;
    const rungs = [];
    for (const r of rows) {
      if (r.home_lat == null || r.home_lon == null) continue;
      const km = Math.round(greatCircleKm(r.home_lat, r.home_lon, r.lat, r.lon) * 10) / 10;
      if (km > 200) continue;                 // §12 — excluded, not flagged
      if (km <= best) continue;
      best = km;
      rungs.push({ ts: r.ts, target: String(r.target), km });
    }
    if (!rungs.length) return null;           // null is a real answer
    return [{
      entity: 'global',
      value: { rungs, record_km: best, record_at: rungs[rungs.length - 1].ts },
      confidence: null,
      evidence_count: rows.length,
    }];
  },
});

// ─── link.observed ──────────────────────────────────────────────────────────
//
// EVERY NODE-TO-NODE HOP WE HAVE EVER WITNESSED, with both endpoints placed.
// MESH_REACH_SPEC §7e — Peter: "when we have found a node that is relaying, we
// can see which node was relayed to it and therefore it's location… to stretch
// the 'spiderweb' overlay on a map… we will end up with the data for a mesh
// map."
//
// A route is a CHAIN OF EDGES, not a pair of endpoints, and we have been storing
// them since June without reading them that way: `us -> T4 -> fir -> TE 5 ->
// L5-3 -> Ives` is five observed links.
//
// BOTH DIRECTIONS, because the way home is not the way out — 23 relays appear
// only on return paths.
//
// The chain is assembled in run() rather than by a self-join on hop index. The
// SQL for that is a CTE joined to itself on idx+1 per route, which is harder to
// read and no faster at this size — and the terminators (us at one end, the
// target at the other) have to be spliced on in code anyway.
registerInference({
  key:  'link.observed',
  deps: [],
  mode: 'batch',
  evidence: `
    SELECT o.id                              AS route,
           CAST(o.entity AS INTEGER)         AS target,
           tn.lat                            AS target_lat,
           tn.lon                            AS target_lon,
           j.key                             AS idx,
           CAST(j.value AS INTEGER)          AS node,
           hn.lat                            AS lat,
           hn.lon                            AS lon,
           0                                 AS reversed,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat') AS home_lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon') AS home_lon
    FROM obs_v_traceroute o
    LEFT JOIN nodes tn ON tn.num = CAST(o.entity AS INTEGER)
    , json_each(o.data ->> '$.route') j
    LEFT JOIN nodes hn ON hn.num = CAST(j.value AS INTEGER)
    WHERE o.data ->> '$.status' = 'ok' AND j.value <> 4294967295
    UNION ALL
    SELECT o.id, CAST(o.entity AS INTEGER), tn.lat, tn.lon,
           j.key, CAST(j.value AS INTEGER), hn.lat, hn.lon, 1,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat'),
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon')
    FROM obs_v_traceroute o
    LEFT JOIN nodes tn ON tn.num = CAST(o.entity AS INTEGER)
    , json_each(o.data ->> '$.route_back') j
    LEFT JOIN nodes hn ON hn.num = CAST(j.value AS INTEGER)
    WHERE o.data ->> '$.status' = 'ok' AND j.value <> 4294967295
    ORDER BY route, reversed, idx
  `,
  /** Pure. Chains in, links out.
   *
   *  Each link is keyed on its sorted node pair, so A->B and B->A are ONE link
   *  observed twice rather than two links. Direction is a property of a
   *  traversal, not of a radio path.
   *
   *  A link is emitted only when BOTH ends are placed — an unplaceable endpoint
   *  cannot be drawn, and inventing a position for it is exactly the laundering
   *  §12 warns about. Links with a missing end are counted and reported so the
   *  omission is visible rather than silent. */
  run(rows) {
    const US = 646426545;   // our OMNI; the chain's near terminator
    const chains = new Map();
    for (const r of rows) {
      const key = `${r.route}:${r.reversed}`;
      let c = chains.get(key);
      if (!c) chains.set(key, c = { target: r.target, target_lat: r.target_lat,
                                    target_lon: r.target_lon, reversed: r.reversed,
                                    home_lat: r.home_lat, home_lon: r.home_lon, hops: [] });
      c.hops.push({ node: r.node, lat: r.lat, lon: r.lon });
    }

    const links = new Map();
    let unplaceable = 0;
    for (const c of chains.values()) {
      const us     = { node: US, lat: c.home_lat, lon: c.home_lon };
      const target = { node: c.target, lat: c.target_lat, lon: c.target_lon };
      // Outbound runs us -> hops -> target; the return leg runs the other way.
      const chain = c.reversed ? [target, ...c.hops, us] : [us, ...c.hops, target];
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i], b = chain[i + 1];
        if (a.node === b.node) continue;
        if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) { unplaceable++; continue; }
        const [lo, hi] = a.node < b.node ? [a, b] : [b, a];
        const id = `${lo.node}-${hi.node}`;
        const e = links.get(id);
        if (e) { e.count++; continue; }
        links.set(id, {
          count: 1,
          a: lo.node, b: hi.node,
          a_lat: lo.lat, a_lon: lo.lon,
          b_lat: hi.lat, b_lon: hi.lon,
          km: Math.round(greatCircleKm(lo.lat, lo.lon, hi.lat, hi.lon) * 10) / 10,
        });
      }
    }
    if (!links.size) return null;
    void unplaceable;
    return [...links].map(([id, v]) => ({
      entity: id,
      value: v,
      confidence: null,
      evidence_count: v.count,
    }));
  },
});

// ─── reach.mission ──────────────────────────────────────────────────────────
//
// WHICH TARGET TO TRY NEXT, AND WHY. The memory MESH_REACH_SPEC §2 says the
// prober does not have: "the machine is not selecting; it is iterating."
//
// Peter, 2026-08-02: "why is everything blocked by something else meaning that
// this will never be completed?" — a fair challenge, and the honest answer is
// that §9 was mis-framed. It was treated as a block on the whole Missions
// panel. It is not. node-dash ALREADY dispatches traceroutes itself
// (traceroute.js:128, passive-tracer.js:122 — 21,793 over five weeks, from both
// radios). No new authority is needed to govern sending that is already
// happening ungoverned. Only the BROADCAST CALLOUT is contested, and that is
// one instrument of three.
//
// This inference spends no airtime whatsoever. It ranks; it does not send.
//
// EVIDENCE STARTS FROM `nodes`, NOT FROM THE TRACEROUTE VIEW, and that is the
// whole point. A LEFT JOIN is the difference between "which of the targets we
// have tried deserves another go" and "what have we never looked at". Measured
// 2026-08-02: 213 positioned nodes have NEVER been attempted once, 39 of them
// beyond the 189.1 km record — while 423 attempts went to a single node with no
// position that has never answered. The pool the prober never saw is where the
// information is.
registerInference({
  key:  'reach.mission',
  deps: [],
  mode: 'batch',
  evidence: `
    SELECT n.num                                                      AS target,
           n.lat                                                      AS lat,
           n.lon                                                      AS lon,
           n.last_heard                                               AS last_heard,
           COUNT(th.id)                                               AS attempts,
           SUM(CASE WHEN th.status = 'ok' THEN 1 ELSE 0 END)          AS hits,
           MAX(CASE WHEN th.status = 'ok' THEN th.ts END)             AS last_ok,
           MAX(th.ts)                                                 AS last_attempt,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lat') AS home_lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key = 'home.lon') AS home_lon,
           (SELECT MAX(strftime('%s','now'))) 					      AS now_ts
    FROM nodes n
    LEFT JOIN traceroute_history th ON th.to_num = n.num
    WHERE n.lat IS NOT NULL AND n.lon IS NOT NULL AND n.lat <> 0
      AND n.num NOT IN (
        SELECT DISTINCT from_num FROM traceroute_history WHERE from_num IS NOT NULL
      )
    GROUP BY n.num
  `,
  /** Pure: rows in, facts out. `now_ts` arrives IN the evidence rather than
   *  being read from a clock here. The catalogue may not call one at all — the
   *  boundary test greps for it, so ages are computed against a timestamp SQL
   *  supplied, which also means a recompute over history stays repeatable.
   *
   *  OUR OWN RADIOS ARE EXCLUDED VIA `from_num`, not via `nodes.device`. A
   *  mission to traceroute the radio doing the tracerouting is not a mission,
   *  but the first attempt used `n.device IS NULL` and that is a different
   *  thing entirely: `device` is the MAC of the radio that HEARD the node, so
   *  it is set on 903 nodes and the filter cut the pool from 601 to 3, with a
   *  0 km "record" to match. `from_num` is the addressee of a traceroute reply
   *  and is only ever one of ours — measured: TA2o, TA2y, GARG, nothing else.
   *
   *  EVERY MISSION CARRIES ITS REASON AS A STRING, written here. The browser
   *  must not assemble an explanation out of numbers (BROWSER_CONTRACT), and a
   *  ranked list with no stated reason is a magic number wearing a table. */
  run(rows) {
    if (!rows.length) return null;
    const now = Number(rows[0].now_ts) || 0;
    const HOME = { lat: rows[0].home_lat, lon: rows[0].home_lon };
    if (HOME.lat == null || HOME.lon == null) return null;

    // 24 hours. Peter's "not so much as to become a nuisance" (§1) with a
    // number attached: a target tried today is not a candidate today, however
    // attractive it looks. This is the only rate rule the selector owns — a
    // real budget belongs to whatever dispatches, which is not this.
    const COOLDOWN = 86_400;
    // §12: beyond this a self-reported position is not evidence, it is a
    // claim. 250 rather than the record's 200 because a MISSION may legitimately
    // aim past the current frontier — the point is to beat it — but a node
    // claiming 1,681 km is not a target, it is a bad coordinate.
    const CEILING_KM = 250;

    const scored = [];
    const skipped = { cooling: 0, suspect: 0, exhausted: 0 };

    // The record is computed from the same rows, not passed in: an inference
    // that took the record as a dependency would rank against a stale one on
    // the run where the record itself moved.
    //
    // PROVEN GROUND, not just the record number. Every node we have actually
    // reached is a place a packet of ours has demonstrably arrived, and the
    // set of them is the shape of what we can do — the single furthest one is a
    // summary of it, not a substitute for it.
    let record = 0;
    const proven = [{ lat: HOME.lat, lon: HOME.lon }];   // we are, trivially, reachable
    for (const r of rows) {
      if (!r.hits) continue;
      const km = greatCircleKm(HOME.lat, HOME.lon, r.lat, r.lon);
      if (km > 200) continue;                            // §12 — a claim, not evidence
      proven.push({ lat: r.lat, lon: r.lon });
      if (km > record) record = km;
    }

    /** How far past the nearest node we have ACTUALLY REACHED.
     *
     *  THE METRIC THAT MATTERS, and raw distance from home is not it. Peter,
     *  2026-08-02: "what I am expecting to see is the 189km increase, if it's
     *  not then we are not making use of all of that data we have?"
     *
     *  He was right and this is the correction. Ranked by distance from home,
     *  the runner spent every attempt on 233-234 km nodes in Cheshire and
     *  Bedfordshire — about 100 km past anything we have ever touched, in
     *  corridors where no path has ever been demonstrated. Meanwhile Sen1 sits
     *  208 km out and just 21 km past Ives, which we verify at 187.7 km, and
     *  GA3 sits 213 km out and 37 km past the Guernsey relays.
     *
     *  On the headline number those are 25 km apart. As propositions they are
     *  nothing alike: one extends a working corridor by a hop, the other is a
     *  leap into the dark. The step is what separates them, and it is computable
     *  from data we have held for five weeks. */
    const stepKm = (lat, lon) => {
      let best = Infinity;
      for (const q of proven) {
        const d = greatCircleKm(lat, lon, q.lat, q.lon);
        if (d < best) best = d;
      }
      return best;
    };

    for (const r of rows) {
      const km = Math.round(greatCircleKm(HOME.lat, HOME.lon, r.lat, r.lon) * 10) / 10;
      if (km > CEILING_KM) { skipped.suspect++; continue; }
      const attempts = Number(r.attempts) || 0;
      const hits     = Number(r.hits) || 0;
      const lastAtt  = r.last_attempt ? Number(r.last_attempt) : null;
      const ageDays  = lastAtt ? Math.floor((now - lastAtt) / 86_400) : null;
      if (lastAtt != null && (now - lastAtt) < COOLDOWN) { skipped.cooling++; continue; }

      let cls = null, reason = null, rank = 0;

      // SMALLEST STEP FIRST, not greatest distance. A 21 km extension of a
      // proven corridor outranks a 100 km leap into a direction we have never
      // reached, even though the leap has the bigger headline number.
      const step = Math.round(stepKm(r.lat, r.lon) * 10) / 10;
      const stepScore = Math.max(0, 300 - step * 2);

      if (attempts === 0 && km > record) {
        cls = 'unknown-record';
        reason = `never attempted — ${Math.round(step)} km past the nearest node we have reached, and would beat the ${Math.round(record)} km record`;
        rank = 1000 + stepScore;
      } else if (attempts === 0) {
        cls = 'unknown';
        reason = 'never attempted — one try tells us more than a repeat anywhere';
        rank = 700 + stepScore;
      } else if (hits === 0 && km > record) {
        cls = 'record';
        reason = `${attempts} attempt${attempts === 1 ? '' : 's'}, no reply yet — ${Math.round(step)} km past the nearest node we have reached, would beat the ${Math.round(record)} km record`;
        // Diminishing: the twentieth silent attempt is worth less than the
        // second. §4 says silence proves nothing, not that it is free.
        rank = 1000 + stepScore - Math.min(120, attempts * 6);
      } else if (hits > 0 && km > 100 && ageDays != null && ageDays >= 7) {
        cls = 'reconfirm';
        reason = `verified ${hits}/${attempts}, untried for ${ageDays} days — is the corridor still open?`;
        rank = 300 + km;
      } else if (hits === 0 && attempts >= 40) {
        skipped.exhausted++;
        continue;
      } else {
        continue;
      }

      scored.push({
        entity: String(r.target),
        value: {
          km, cls, reason, attempts, hits,
          // How far past proven ground. The panel shows it because it is the
          // number that says whether an attempt is a step or a leap.
          step_km: step,
          // THE BEARING TRAVELS WITH THE MISSION. Without it the runner cannot
          // aim, and an unaimed YAGI is a worse antenna than an omni — the
          // first discovery run fired a 234 km attempt at whatever azimuth the
          // garage alarm had left the beam on.
          bearing: bearingDeg(HOME.lat, HOME.lon, r.lat, r.lon) == null ? null
                   : Math.round(bearingDeg(HOME.lat, HOME.lon, r.lat, r.lon)),
          last_attempt: lastAtt,
          last_ok: r.last_ok ? Number(r.last_ok) : null,
          age_days: ageDays,
          rank: Math.round(rank),
        },
        confidence: null,
        evidence_count: attempts,
      });
    }

    scored.sort((a, b) => b.value.rank - a.value.rank);

    // A PORTFOLIO, NOT A SORT. Ranked purely by score the shortlist came back as
    // twenty rows of "never attempted, and would beat the 189 km record" —
    // technically the highest information gain, and useless as a mission list.
    // One class swamping the panel hides the record attempts already in flight
    // and the frontier corridors going stale, and those are different kinds of
    // work that want doing in parallel.
    //
    // So each class gets a quota and keeps its own internal ranking. The quotas
    // are a judgement about balance, stated here rather than buried in a score:
    // most effort on ground never covered, real effort on beating the record,
    // and a standing tax on re-confirming what we already hold.
    // REBALANCED once the step metric existed. The old split gave eight slots
    // to `unknown-record` — targets never attempted and beyond the record —
    // and every one of them went to a 100 km leap, crowding out the handful of
    // candidates that sit a short hop past a working corridor. `record` and
    // `unknown-record` now share the same rank scale, so the split is about
    // breadth of evidence rather than about which class wins.
    const QUOTA = { 'unknown-record': 6, 'record': 6, 'reconfirm': 4, 'unknown': 4 };
    const used = {};
    const top = [];
    for (const m of scored) {
      const c = m.value.cls;
      if ((used[c] = (used[c] || 0)) >= (QUOTA[c] ?? 0)) continue;
      used[c]++;
      top.push(m);
    }

    // THE EXCLUSIONS ARE PUBLISHED, not silent. A shortlist that quietly drops
    // most of the pool reads as "these are the only options", and §4's whole
    // point is that what we chose not to look at matters as much as what we did.
    top.push({
      entity: 'global',
      value: {
        cls: 'summary',
        record_km: Math.round(record * 10) / 10,
        candidates: scored.length,
        shown: top.length,
        skipped_cooling: skipped.cooling,
        skipped_suspect: skipped.suspect,
        skipped_exhausted: skipped.exhausted,
      },
      confidence: null,
      evidence_count: rows.length,
    });
    return top;
  },
});
