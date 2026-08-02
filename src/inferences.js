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
// EMPTY, DELIBERATELY. Created by task
// `observatory-inference-catalogue-boundary` so the boundary is correct BEFORE
// there is an inference pressing on it. Widening a boundary test to admit code
// that already exists is how boundaries die; widening it first, with nothing
// waiting, makes it a decision instead of a consequence.
//
// The first entry is expected to be the antenna-bearing work (task
// `record-antenna-bearing-on-reception`, MESH_REACH_SPEC §7c/§7e). Note that its
// capture half is NOT an inference — recording where the antenna pointed is an
// observation. Only the estimate derived from many such observations belongs
// here.
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
    SELECT j.value                    AS relay,
           o.entity                   AS target,
           1                          AS uses
    FROM obs_v_traceroute o, json_each(o.data ->> '$.route') j
    WHERE o.data ->> '$.status' = 'ok' AND j.value <> 4294967295
    UNION ALL
    SELECT j.value, o.entity, 1
    FROM obs_v_traceroute o, json_each(o.data ->> '$.route_back') j
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
      if (!e) byRelay.set(relay, e = { uses: 0, targets: new Set() });
      e.uses += 1;
      if (r.target != null) e.targets.add(String(r.target));
    }
    return [...byRelay].map(([entity, e]) => ({
      entity,
      value: { uses: e.uses, targets: e.targets.size },
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
      return {
        entity: String(r.target),
        value: {
          km,
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
