// ── Empirical reach — how far we have ACTUALLY got, per bearing ─────────────
//
// Peter, 2026-08-05: "the honest version is empirical, not theoretical — yes
// that's what I meant", and then: "theoretical is irrelevant".
//
// He is right, and the link budget proves his point better than any argument.
// At 27 dBm into 12 dBi with a -131.5 dBm receiver the budget is ~158 dB, and
// free-space loss at 60 km is only ~127 dB. The theory says we should hear
// everything, everywhere, out to the edge of the terrain sample — 60 km on every
// bearing. We have exactly ONE proven direct link past 13 km. A reach overlay
// drawn from theory would contradict every measurement we hold, confidently.
//
// So this module contains no propagation model at all. It reports evidence.
//
// WHAT COUNTS AS PROOF OF A DIRECT RF LINK
//
//   first-hop   route[0] of a completed traceroute. Our transmission reached it
//               with no relay in between, and its reply came back. Two-way, and
//               it is the bulk of the evidence — 2071 traceroutes through T4
//               alone.
//   0-relay     a completed traceroute with an EMPTY route: the endpoint itself
//               answered directly.
//
// Both prove the UPLINK, which is the half that matters. Hearing a node proves
// only that it can reach us, and asymmetric paths are real.
//
// WHAT IS DELIBERATELY NOT COUNTED
//
//   - RSSI/SNR on a relayed packet. That describes the LAST hop, not our path
//     to the node (see the `signal-provenance-mixed-source` task).
//   - `hops == 0` from packet arithmetic. That is hop-count inference, not a
//     relay-identity test, and a relayed packet can satisfy it
//     (`direct-gate-relay-node`).
//
// A SECTOR WITH NO EVIDENCE IS NOT A SECTOR WITH ZERO REACH. It is unknown, and
// it is served as null so the radar can draw a gap rather than a false shoreline.

import db, { getConfig } from './db.js';

const DEFAULTS = { sector_deg: 30, max_plausible_km: 500 };

// 0xFFFFFFFF. Not a node, and it can never become one — it is the destination
// every broadcast carries, and it turns up in route[0] because a traceroute's
// route array is a list of addresses rather than a list of relays.
//
// This constant is here, at the top of the module that owns door identity, and
// NOT copied into each caller. It was copied before: doors.js filtered it in
// three places, the archived inferences.js `relay.usage` filtered it with the
// reasoning written down, and snapshot-api.js built its own query and did not —
// so /events published the broadcast as the fourth-busiest relay in the mesh.
// mesh-gw found that by reading our store, not us. See docs/modules/reach.md.
export const BROADCAST = 4294967295;

export function reachConfig() {
  return { ...DEFAULTS, ...(getConfig('reach', {}) || {}) };
}

const R_EARTH = 6371.0088;
const rad = d => d * Math.PI / 180;

function home() {
  const lat = Number(getConfig('home.lat')), lon = Number(getConfig('home.lon'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function geo(h, lat, lon) {
  const p1 = rad(h.lat), p2 = rad(lat), dl = rad(lon - h.lon);
  const t = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R_EARTH * Math.asin(Math.sqrt(t));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { km, deg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}

/** Which nodes our traffic leaves through, most-used first — THE door query.
 *
 *  A "door" is the first hop of a completed traceroute: the node our transmission
 *  reached with no relay in between. It is the only place door identity exists,
 *  because `route` is populated on success only.
 *
 *  Singular on purpose. There were three implementations of this, two of them
 *  live and disagreeing about whether the broadcast address is a relay, and the
 *  cost of that was not a wrong number on a card — it was that the knowledge
 *  which resolved it had already been written down twice and could not be found
 *  from the code that needed it.
 *
 *  `since` is a unix seconds bound; omit it for all of history. Callers get plain
 *  rows — `{num, uses, name}` — and decide their own presentation. Percentages,
 *  truncation and labels are a consumer's business, not this function's.
 */
export function doorUsage({ since = null } = {}) {
  const rows = since == null
    ? db.prepare(`
        SELECT json_extract(t.route,'$[0]') num, COUNT(*) uses,
               COALESCE(n.short_name, '?') name
          FROM traceroute_history t
          LEFT JOIN nodes n ON n.num = json_extract(t.route,'$[0]')
         WHERE t.status = 'ok' AND json_array_length(t.route) > 0
         GROUP BY 1 ORDER BY uses DESC, num ASC`).all()
    : db.prepare(`
        SELECT json_extract(t.route,'$[0]') num, COUNT(*) uses,
               COALESCE(n.short_name, '?') name
          FROM traceroute_history t
          LEFT JOIN nodes n ON n.num = json_extract(t.route,'$[0]')
         WHERE t.status = 'ok' AND json_array_length(t.route) > 0 AND t.ts > ?
         GROUP BY 1 ORDER BY uses DESC, num ASC`).all(since);

  // `num ASC` above is not decoration. Ties in `uses` are common in a small mesh,
  // and SQLite's order within a tie is not guaranteed, so a ranking could change
  // between two calls over the SAME window — which makes "the top door" a thing
  // no caller can reason about or test.
  return rows.filter(d => d.num != null && d.num !== BROADCAST);
}

/** Every node we have PROVEN a direct RF link to, with the evidence for it. */
export function provenLinks() {
  const h = home();
  if (!h) return [];
  const out = new Map();
  const place = (num, evidence, count) => {
    const n = db.prepare('SELECT short_name, lat, lon FROM nodes WHERE num = ?').get(num);
    if (!n || n.lat == null || n.lat === 0) return;
    const g = geo(h, n.lat, n.lon);
    if (!(g.km <= reachConfig().max_plausible_km)) return;
    const prev = out.get(num);
    // first-hop evidence outranks 0-relay only in count; keep the larger count
    if (!prev || count > prev.count) {
      out.set(num, { num, name: n.short_name, km: Math.round(g.km * 10) / 10,
                     deg: Math.round(g.deg), evidence, count });
    }
  };
  for (const r of db.prepare(`
      SELECT json_extract(route,'$[0]') num, COUNT(*) n FROM traceroute_history
       WHERE status='ok' AND json_array_length(route) > 0 GROUP BY 1`).all()) {
    // Same route[0] source as doorUsage, so the same exclusion. It has never
    // actually leaked here, but only because `place()` needs a `nodes` row with a
    // position and 0xFFFFFFFF has none — an accident of the store, not a rule.
    // The day something writes that row, this becomes a proven RF link to the
    // broadcast address.
    if (r.num != null && r.num !== BROADCAST) place(r.num, 'first-hop', r.n);
  }
  for (const r of db.prepare(`
      SELECT to_num num, COUNT(*) n FROM traceroute_history
       WHERE status='ok' AND json_array_length(route) = 0 GROUP BY 1`).all()) {
    if (r.num != null && !out.has(r.num)) place(r.num, '0-relay', r.n);
  }
  return [...out.values()].sort((a, b) => b.km - a.km);
}

/** Nodes we have HEARD directly — reception evidence, weaker than a proven link.
 *
 *  Peter, 2026-08-05: "based on what has actually been CONTACTED or heard."
 *
 *  Kept SEPARATE from provenLinks() rather than merged, because it proves a
 *  different thing: hearing a node shows the DOWNLINK only. Asymmetric paths are
 *  real, and a reach shape that silently mixes "we can talk to it" with "it can
 *  talk to us" would overstate what we can actually do. */
export function heardDirect() {
  const h = home();
  if (!h) return [];
  const out = [];
  for (const r of db.prepare(`
      SELECT n.num, n.short_name, n.lat, n.lon, MAX(s.snr) snr, COUNT(*) n
        FROM signal_history s JOIN nodes n ON n.num = s.num
       WHERE s.hops = 0 AND n.lat IS NOT NULL AND n.lat != 0
       GROUP BY n.num`).all()) {
    const g = geo(h, r.lat, r.lon);
    if (!(g.km <= reachConfig().max_plausible_km)) continue;
    out.push({ num: r.num, name: r.short_name, km: Math.round(g.km * 10) / 10,
               deg: Math.round(g.deg), evidence: 'heard', count: r.n, snr: r.snr });
  }
  return out.sort((a, b) => b.km - a.km);
}

/** Furthest proven direct link per sector. Null where we have no evidence. */
export function reachBySector() {
  const cfg = reachConfig();
  const links = provenLinks();
  const n = Math.round(360 / cfg.sector_deg);
  const sectors = Array.from({ length: n }, (_, i) => ({
    from_deg: i * cfg.sector_deg,
    to_deg: (i + 1) * cfg.sector_deg,
    mid_deg: i * cfg.sector_deg + cfg.sector_deg / 2,
    // null, NOT zero — no evidence is not evidence of no reach
    furthest_km: null, node: null, links: 0, evidence: null,
    // Separate series: heard = downlink only, and its hops=0 gate is unverified.
    heard_km: null, heard_node: null,
  }));
  // PROVEN AND HEARD ARE NOT MERGED.
  //
  // The first cut concatenated them and produced 143.2 km "achieved" on a bearing
  // where our furthest PROVEN link is 48.4 km. The 143 km came from
  // signal_history.hops = 0 — which this very file documents as untrustworthy
  // (hop arithmetic, not a relay-identity test; a relayed packet satisfies it).
  // I wrote the warning and then merged the data anyway.
  //
  // They are two different claims and are served as two series. Proven is the
  // shape; heard is a weaker overlay on it, and the radar draws it as such.
  for (const l of links) {
    const s = sectors[Math.floor(l.deg / cfg.sector_deg) % n];
    s.links++;
    if (s.furthest_km == null || l.km > s.furthest_km) {
      s.furthest_km = l.km; s.node = l.name; s.evidence = l.evidence;
    }
  }
  for (const l of heardDirect()) {
    const s = sectors[Math.floor(l.deg / cfg.sector_deg) % n];
    if (s.heard_km == null || l.km > s.heard_km) { s.heard_km = l.km; s.heard_node = l.name; }
  }
  const known = sectors.filter(s => s.furthest_km != null);
  return {
    ready: true,
    sector_deg: cfg.sector_deg,
    sectors,
    proven_links: links.length,
    sectors_with_evidence: known.length,
    sectors_total: n,
    furthest_km: known.length ? Math.max(...known.map(s => s.furthest_km)) : null,
    // The whole point: this is a map of what we have PROVEN, and most of it is
    // unproven. Anything reading it as coverage is reading it wrong.
    caveat: 'furthest_km is PROVEN direct links only; null sectors are unknown, not unreachable. '
          + 'heard_km is a separate, WEAKER series: downlink only, and gated on signal_history.hops=0, '
          + 'which is hop arithmetic rather than a relay-identity test — treat it as indicative.',
  };
}
