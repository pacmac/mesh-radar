// ── Clusters — places, not sets of nodes ─────────────────────────────────────
//
// Implements docs/CLUSTERS_SPEC.md. Read that first; this file is the mechanism,
// the spec is the reasoning and the evidence.
//
// A cluster is an ANCHOR (a fixed point on the ground) plus a RADIUS. Membership
// is DERIVED from the anchor and recomputed; the anchor is the identity. Peter
// chose this over a curated member list so that a friendly name survives nodes
// joining and leaving:
//
//   "I would think the anchor method with an auto gen short name i.e: cluster-a
//    and we have the ability to manually give it a friendly name"
//
// WHY CLUSTERS AT ALL. Measured 2026-08-04, leave-one-out over the 91 endpoints
// with both a position and a known door:
//
//   constant (always the commonest door)   48.4%
//   bearing sector (+/-22.5 deg)           65.9%
//   nearest neighbour / knn3               65.9%
//   CLUSTER MEMBERSHIP, 5 km linkage       74.5%   <- best
//
// Bearing is the wrong model here: three clusters are 100% pure and all of them
// route the "wrong" way — nodes at 355-2, 98-110 and 118-119 degrees all exit
// WEST through T4 at 274 degrees.

import db, { getConfig, setConfig, stmts } from './db.js';
import { provenDoors } from './node-kind.js';

// 5 km is not a taste. It is simultaneously the best door predictor (74.5%) and
// a 64% cut in radar marks (371 -> 134). One knob, defaulted from measurement.
const DEFAULTS = { radius_km: 5, min_members: 2, window_days: 14, ttl_sec: 120 };

export function clusterConfig() {
  return { ...DEFAULTS, ...(getConfig('clusters', {}) || {}) };
}

// ── schema ───────────────────────────────────────────────────────────────────
// Guarded on table_xinfo, never table_info: table_info omits generated columns,
// so the guard re-ALTERs on every boot and the process crash-loops. That took
// node-dash and DEV1 down once already.
export function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clusters (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT    NOT NULL UNIQUE,
      friendly_name TEXT,
      lat           REAL    NOT NULL,
      lon           REAL    NOT NULL,
      radius_km     REAL,
      source        TEXT    NOT NULL DEFAULT 'auto-seed',
      created_at    INTEGER NOT NULL
    )`);
  const cols = db.prepare(`PRAGMA table_xinfo(clusters)`).all().map(r => r.name);
  if (!cols.includes('friendly_name')) db.exec(`ALTER TABLE clusters ADD COLUMN friendly_name TEXT`);
  if (!cols.includes('radius_km'))     db.exec(`ALTER TABLE clusters ADD COLUMN radius_km REAL`);
}

// ── geometry ─────────────────────────────────────────────────────────────────
const R_EARTH = 6371.0088;
const rad = d => d * Math.PI / 180;

export function haversineKm(aLat, aLon, bLat, bLon) {
  const p1 = rad(aLat), p2 = rad(bLat), dl = rad(bLon - aLon);
  const t = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(t));
}

function bearingDeg(aLat, aLon, bLat, bLon) {
  const p1 = rad(aLat), p2 = rad(bLat), dl = rad(bLon - aLon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function home() {
  const lat = Number(getConfig('home.lat')), lon = Number(getConfig('home.lon'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// A PLAUSIBILITY CEILING, for the same reason contribution() has one. The
// furthest "positioned" node in the store is 1681 km away, which is bad data
// rather than a contact — and one such row would blow up every hull and extent.
const MAX_PLAUSIBLE_KM = 500;

/** Positioned nodes heard inside the window, with distance and bearing from home. */
function candidateNodes(cfg, h) {
  const since = Math.floor(Date.now() / 1000) - cfg.window_days * 86400;
  const rows = db.prepare(`
    SELECT num, short_name, long_name, role, lat, lon, last_heard
      FROM nodes
     WHERE lat IS NOT NULL AND lat != 0 AND lon IS NOT NULL AND last_heard > ?`).all(since);
  const out = [];
  for (const n of rows) {
    const km = haversineKm(h.lat, h.lon, n.lat, n.lon);
    if (!(km <= MAX_PLAUSIBLE_KM)) continue;
    out.push({ ...n, _km: km, _az: bearingDeg(h.lat, h.lon, n.lat, n.lon) });
  }
  return out;
}

// ── seeding ──────────────────────────────────────────────────────────────────

function nextSlug(existing) {
  // cluster-a … cluster-z, then cluster-aa. Permanent once assigned; never reused
  // even if the cluster is deleted, so an old screenshot never names a new place.
  const used = new Set(existing.map(c => c.slug));
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let n = 1; n < 4; n++) {
    const gen = (pre) => {
      if (pre.length === n) return [pre];
      return letters.split('').flatMap(ch => gen(pre + ch));
    };
    for (const s of gen('')) {
      const slug = `cluster-${s}`;
      if (!used.has(slug)) return slug;
    }
  }
  return `cluster-${Date.now().toString(36)}`;
}

/** Single-linkage grouping at `radius_km`. Returns arrays of nodes. */
function linkageGroups(nodes, radiusKm) {
  const parent = new Map(nodes.map(n => [n.num, n.num]));
  const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon) <= radiusKm) {
        const a = find(nodes[i].num), b = find(nodes[j].num);
        if (a !== b) parent.set(a, b);
      }
    }
  }
  const groups = new Map();
  for (const n of nodes) {
    const k = find(n.num);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  return [...groups.values()];
}

/** Run the linkage and drop an anchor at each group's centroid.
 *
 *  ADDITIVE AND IDEMPOTENT: never deletes, never moves an existing anchor, and
 *  only proposes where no cluster already covers the group. Running it twice
 *  changes nothing the second time. */
export function seedClusters() {
  ensureSchema();
  const cfg = clusterConfig(), h = home();
  if (!h) return { created: 0, reason: 'no home position' };
  const nodes = candidateNodes(cfg, h);
  const existing = listAnchors();
  const created = [];
  for (const g of linkageGroups(nodes, cfg.radius_km)) {
    if (g.length < cfg.min_members) continue;
    const lat = g.reduce((s, n) => s + n.lat, 0) / g.length;
    const lon = g.reduce((s, n) => s + n.lon, 0) / g.length;
    // Already covered by an anchor? Then this group is that cluster; skip.
    const covered = existing.some(c => haversineKm(c.lat, c.lon, lat, lon) <= (c.radius_km ?? cfg.radius_km));
    if (covered) continue;
    const slug = nextSlug(existing.concat(created));
    const row = { slug, lat, lon, radius_km: null, source: 'auto-seed', created_at: Math.floor(Date.now() / 1000) };
    db.prepare(`INSERT INTO clusters (slug, friendly_name, lat, lon, radius_km, source, created_at)
                VALUES (@slug, NULL, @lat, @lon, @radius_km, @source, @created_at)`).run(row);
    created.push({ ...row, id: db.prepare('SELECT last_insert_rowid() id').get().id });
  }
  invalidate();
  return { created: created.length, clusters: created };
}

// ── anchors CRUD ─────────────────────────────────────────────────────────────

export function listAnchors() {
  ensureSchema();
  return db.prepare(`SELECT * FROM clusters ORDER BY id`).all();
}

export function createAnchor({ lat, lon, radius_km = null, friendly_name = null }) {
  ensureSchema();
  const slug = nextSlug(listAnchors());
  const info = db.prepare(`INSERT INTO clusters (slug, friendly_name, lat, lon, radius_km, source, created_at)
                           VALUES (?, ?, ?, ?, ?, 'manual', ?)`)
    .run(slug, friendly_name, Number(lat), Number(lon), radius_km == null ? null : Number(radius_km),
         Math.floor(Date.now() / 1000));
  invalidate();
  return db.prepare('SELECT * FROM clusters WHERE id = ?').get(info.lastInsertRowid);
}

export function updateAnchor(id, patch = {}) {
  ensureSchema();
  const cur = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!cur) return null;
  const next = {
    friendly_name: patch.friendly_name !== undefined ? (patch.friendly_name || null) : cur.friendly_name,
    lat:           patch.lat        !== undefined ? Number(patch.lat)        : cur.lat,
    lon:           patch.lon        !== undefined ? Number(patch.lon)        : cur.lon,
    radius_km:     patch.radius_km  !== undefined ? (patch.radius_km == null ? null : Number(patch.radius_km)) : cur.radius_km,
  };
  db.prepare(`UPDATE clusters SET friendly_name=@friendly_name, lat=@lat, lon=@lon, radius_km=@radius_km WHERE id=@id`)
    .run({ ...next, id });
  invalidate();
  return db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
}

export function deleteAnchor(id) {
  ensureSchema();
  const n = db.prepare('DELETE FROM clusters WHERE id = ?').run(id).changes;
  invalidate();
  return n > 0;
}

// ── derivation ───────────────────────────────────────────────────────────────

/** Convex hull (monotone chain) in lat/lon. Small member counts, so the O(n log n)
 *  cost is irrelevant and the shape is what the radar draws as the "blob". */
function hull(points) {
  if (points.length < 3) return points.slice();
  const p = points.slice().sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
  const build = (src) => {
    const st = [];
    for (const pt of src) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], pt) <= 0) st.pop();
      st.push(pt);
    }
    st.pop();
    return st;
  };
  return build(p).concat(build(p.slice().reverse()));
}

/** The dominant door among members that have one, and how pure that is.
 *
 *  PURITY IS THE POINT (CLUSTERS_SPEC §3.1): a cluster whose members all leave by
 *  one door is SOLVED; a mixed one is UNRESOLVED and is where probing belongs. */
function doorStats(members) {
  const counts = new Map();
  let routed = 0;
  for (const m of members) {
    const d = stmts.dominantDoorFor.get(m.num)?.door;
    if (d == null) continue;
    routed++;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  if (!routed) return { dominant_door: null, door_purity: null, routed_members: 0 };
  let best = null, bestN = 0;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return { dominant_door: best, door_purity: Math.round(1000 * bestN / routed) / 10, routed_members: routed };
}

let _cache = null, _cacheAt = 0;
export function invalidate() { _cacheAt = 0; }

/** Every cluster with derived membership, hull and stats. Cached: the radar asks
 *  for this on every payload and it is an O(n) sweep plus a query per member. */
export function clusters({ force = false } = {}) {
  ensureSchema();
  const cfg = clusterConfig();
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < cfg.ttl_sec * 1000) return _cache;

  const h = home();
  const anchors = listAnchors();
  if (!h || !anchors.length) {
    _cache = { clusters: [], loners: [], config: cfg, home: h };
    _cacheAt = now;
    return _cache;
  }
  const nodes = candidateNodes(cfg, h);
  const doors = provenDoors();

  // NEAREST ANCHOR WINS. A node inside two radii joins the closer one only, so
  // no node is in two clusters and no stat double-counts.
  const assigned = new Map(anchors.map(a => [a.id, []]));
  const loners = [];
  for (const n of nodes) {
    let bestId = null, bestD = Infinity;
    for (const a of anchors) {
      const d = haversineKm(a.lat, a.lon, n.lat, n.lon);
      if (d <= (a.radius_km ?? cfg.radius_km) && d < bestD) { bestD = d; bestId = a.id; }
    }
    if (bestId == null) loners.push(n); else assigned.get(bestId).push(n);
  }

  const out = anchors.map(a => {
    const members = assigned.get(a.id);
    const kms = members.map(m => m._km), azs = members.map(m => m._az);
    const ds = doorStats(members);
    // DRIFT: anchor to member centroid. The anchor never auto-recentres — it is
    // a place — so drift is surfaced and acting on it is an operator decision.
    let drift_km = null;
    if (members.length) {
      const cLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
      const cLon = members.reduce((s, m) => s + m.lon, 0) / members.length;
      drift_km = Math.round(10 * haversineKm(a.lat, a.lon, cLat, cLon)) / 10;
    }
    const snrs = members.map(m => m.snr).filter(v => v != null);
    return {
      id: a.id, slug: a.slug, friendly_name: a.friendly_name,
      name: a.friendly_name || a.slug,
      lat: a.lat, lon: a.lon,
      radius_km: a.radius_km ?? cfg.radius_km,
      source: a.source,
      member_count: members.length,
      members: members.map(m => m.num),
      doors_inside: members.filter(m => doors.has(Number(m.num))).map(m => m.num),
      extent_km:  members.length ? [Math.round(10 * Math.min(...kms)) / 10, Math.round(10 * Math.max(...kms)) / 10] : null,
      extent_deg: members.length ? [Math.round(Math.min(...azs)), Math.round(Math.max(...azs))] : null,
      centroid_km:  Math.round(10 * haversineKm(h.lat, h.lon, a.lat, a.lon)) / 10,
      centroid_deg: Math.round(bearingDeg(h.lat, h.lon, a.lat, a.lon)),
      drift_km,
      hull: hull(members.map(m => ({ lat: m.lat, lon: m.lon }))),
      best_snr: snrs.length ? Math.max(...snrs) : null,
      ...ds,
      // SERVED VERDICT — the browser renders this string, it does not compose it.
      // A cluster with no routed member is UNKNOWN, which is not the same as
      // unresolved: we have never reached it at all.
      verdict: ds.routed_members === 0 ? 'unknown'
             : ds.door_purity >= 80 ? 'solved'
             : ds.door_purity >= 50 ? 'mixed' : 'unresolved',
      verdict_tone: ds.routed_members === 0 ? 'neutral'
             : ds.door_purity >= 80 ? 'success'
             : ds.door_purity >= 50 ? 'warning' : 'error',
    };
  });

  _cache = {
    clusters: out,
    // LONERS ARE FIRST CLASS (spec §2.1) — an isolated node is often the most
    // interesting one, a candidate new door. Never bucketed into "other".
    loners: loners.map(n => n.num),
    config: cfg,
    home: h,
  };
  _cacheAt = now;
  return _cache;
}
