// ── Terrain — the hills and valleys we actually live in ──────────────────────
//
// Peter, 2026-08-05: "what I am looking at is the terrain, i.e the hills and
// valleys that surround me".
//
// Not a derived horizon line — the RELIEF itself, sampled as a polar grid
// centred on home and rendered under the radar so the shape of the ground and
// the distribution of nodes can be read together.
//
// WHY IT MATTERS HERE. A coarse 12-bearing probe on 2026-08-05 measured the
// line-of-sight horizon from our 35 m antenna at 0-5 km in every direction
// except due east (20 km). We are in a bowl. Every link we have — including a
// 42.9 km direct contact — is a diffraction path over a ridge. That is the
// single most important physical fact about this site and nothing in the
// dashboard showed it.
//
// ONE-TIME AND CACHED. Terrain does not change. The grid is keyed to the home
// position and antenna height it was computed from, so a stale grid is
// detectable rather than silently wrong — which matters because both of those
// were only just restored after being wiped.
//
// SRTM 30 m, BARE EARTH. Trees and buildings are NOT in it, and at 868 MHz they
// matter over the last kilometre. This shows the shape of the land, not the
// shape of the clutter on it; the real horizon is worse than this everywhere.

import db, { getConfig } from './db.js';

const DEFAULTS = {
  bearings:  180,   // every 2 degrees
  max_km:    60,    // beyond this, terrain stops mattering at our antenna height
  rings:     45,    // sample points per bearing, denser near home (see radiiKm)
  source:   'srtm30m',
};

export function terrainConfig() {
  return { ...DEFAULTS, ...(getConfig('terrain', {}) || {}) };
}

export function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terrain_grid (
      bearing_deg INTEGER NOT NULL,
      km          REAL    NOT NULL,
      elev_m      REAL,
      PRIMARY KEY (bearing_deg, km)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS terrain_meta (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      home_lat    REAL, home_lon REAL, home_alt REAL, antenna_m REAL,
      bearings    INTEGER, max_km REAL, rings INTEGER,
      source      TEXT, sampled_at INTEGER, points INTEGER
    )`);
}

const R_EARTH = 6371.0088;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Point at `d` km along `brg` from (lat,lon). */
export function destination(lat, lon, brg, d) {
  const b = rad(brg), p1 = rad(lat), l1 = rad(lon), dr = d / R_EARTH;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(p1),
                             Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), deg(l2)];
}

/** Sample radii, denser near home. The near field decides whether we get out at
 *  all — a 200 m knoll at 1 km blocks more than a 300 m hill at 30 km — so
 *  linear spacing would waste most samples where they matter least. */
export function radiiKm(maxKm, rings) {
  const out = [];
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    out.push(Math.round(maxKm * t * t * 100) / 100);   // quadratic: dense near 0
  }
  return out;
}

export function homeSite() {
  const lat = Number(getConfig('home.lat')), lon = Number(getConfig('home.lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const alt = Number(getConfig('home.alt'));
  return { lat, lon, alt: Number.isFinite(alt) ? alt : null };
}

export function meta() {
  ensureSchema();
  return db.prepare('SELECT * FROM terrain_meta WHERE id = 1').get() ?? null;
}

/** Is the stored grid still valid for the current site?
 *
 *  Terrain does not move, but the ORIGIN does — and both home.lat/lon and the
 *  antenna height were wiped and restored on 2026-08-05. A grid computed from a
 *  position 450 m away would look plausible and be wrong, so the check is
 *  explicit rather than trusting that nobody moved anything. */
export function isStale() {
  const m = meta(), h = homeSite();
  if (!m || !h) return true;
  const moved = Math.abs(m.home_lat - h.lat) > 1e-6 || Math.abs(m.home_lon - h.lon) > 1e-6;
  const cfg = terrainConfig();
  return moved || m.bearings !== cfg.bearings || m.max_km !== cfg.max_km || m.rings !== cfg.rings;
}

/** The whole grid, as bearings -> elevations, plus the radii they map to. */
export function grid() {
  ensureSchema();
  const m = meta();
  if (!m) return { ready: false, reason: 'not sampled yet', meta: null };
  const radii = radiiKm(m.max_km, m.rings);
  const byBearing = new Map();
  for (const r of db.prepare('SELECT bearing_deg, km, elev_m FROM terrain_grid ORDER BY bearing_deg, km').all()) {
    if (!byBearing.has(r.bearing_deg)) byBearing.set(r.bearing_deg, []);
    byBearing.get(r.bearing_deg).push(r.elev_m);
  }
  const bearings = [...byBearing.keys()].sort((a, b) => a - b);
  const elevs = bearings.map(b => byBearing.get(b));
  const flat = elevs.flat().filter(v => v != null);
  return {
    ready: true,
    stale: isStale(),
    meta: m,
    radii_km: radii,
    bearings_deg: bearings,
    // elevation[bearingIndex][radiusIndex], metres. Null where the source had no
    // data (sea, or outside coverage) — never zero, which would draw as land.
    elev_m: elevs,
    min_m: flat.length ? Math.min(...flat) : null,
    max_m: flat.length ? Math.max(...flat) : null,
    home: homeSite(),
  };
}

// ── sampling ─────────────────────────────────────────────────────────────────

const API = 'https://api.opentopodata.org/v1/';
const BATCH = 100;      // opentopodata's per-request limit
const GAP_MS = 1100;    // its published rate limit is 1 call/sec — stay under it

async function fetchElevations(points, source) {
  const locs = points.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join('|');
  const res = await fetch(`${API}${source}?locations=${encodeURIComponent(locs)}`);
  if (!res.ok) throw new Error(`elevation source ${res.status}`);
  const j = await res.json();
  return j.results.map(r => (typeof r.elevation === 'number' ? r.elevation : null));
}

let _running = false;
export function isSampling() { return _running; }

/** Sample the polar grid and store it. Long-running: ~80 requests at 1.1 s.
 *
 *  Deliberately NOT run automatically at boot. It calls a third-party service,
 *  and a service call is not something a restart should trigger by itself. */
export async function sample({ onProgress = null } = {}) {
  if (_running) throw new Error('already sampling');
  ensureSchema();
  const cfg = terrainConfig(), h = homeSite();
  if (!h) throw new Error('no home position');
  _running = true;
  const started = Date.now();
  try {
    const radii = radiiKm(cfg.max_km, cfg.rings);
    const step = 360 / cfg.bearings;
    const points = [];
    for (let i = 0; i < cfg.bearings; i++) {
      const brg = Math.round(i * step);
      for (const km of radii) points.push({ brg, km, ll: destination(h.lat, h.lon, brg, km) });
    }
    const ins = db.prepare('INSERT OR REPLACE INTO terrain_grid (bearing_deg, km, elev_m) VALUES (?,?,?)');
    const insMany = db.transaction(rows => { for (const r of rows) ins.run(r.brg, r.km, r.elev); });

    let done = 0;
    for (let i = 0; i < points.length; i += BATCH) {
      const chunk = points.slice(i, i + BATCH);
      const elev = await fetchElevations(chunk.map(p => p.ll), cfg.source);
      insMany(chunk.map((p, k) => ({ brg: p.brg, km: p.km, elev: elev[k] })));
      done += chunk.length;
      onProgress?.({ done, total: points.length });
      if (i + BATCH < points.length) await new Promise(r => setTimeout(r, GAP_MS));
    }
    db.prepare(`INSERT OR REPLACE INTO terrain_meta
      (id, home_lat, home_lon, home_alt, antenna_m, bearings, max_km, rings, source, sampled_at, points)
      VALUES (1, ?,?,?,?,?,?,?,?,?,?)`)
      .run(h.lat, h.lon, h.alt, null, cfg.bearings, cfg.max_km, cfg.rings, cfg.source,
           Math.floor(Date.now() / 1000), points.length);
    return { points: points.length, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    _running = false;
  }
}
