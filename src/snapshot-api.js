// ── Snapshot board — Domain 1 ────────────────────────────────────────────────
//
// One screen answering: how far can we get · what is new · are we productive ·
// is the machine working. Everything here is DERIVED IN NODE; the browser
// renders and computes nothing (BROWSER_CONTRACT).
//
// INCREMENT 1 of 6: the hero band only. Peter, 2026-08-05: "you need to start
// filling with live data and validate that the static and live data correlate.
// suggest you do not do this in 1 shot."
//
// EVERY FIGURE CARRIES ITS WINDOW. The static mockup shipped an ALL-TIME 189.1 km
// under a 7D badge — the true 7-day figure was 176.2 km, and the page mixed
// all-time, 30-day and today in one view. A number without its window stated is
// how that happens, so `window_days` is returned alongside the values and the
// browser prints what it is given.
//
// PLAUSIBILITY GATE. Distances are capped at reach.js's max_plausible_km (500).
// One bad GPS fix — MLBR at 1681 km — is how a single row silently governs a
// whole display; clusters.js and the radar already gate on it and so does this.

import { Router } from 'express';
import db, { getConfig } from './db.js';

const router = Router();

const R_EARTH = 6371.0088;
const rad = d => d * Math.PI / 180;

function home() {
  const lat = Number(getConfig('home.lat')), lon = Number(getConfig('home.lon'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function km(h, lat, lon) {
  const p1 = rad(h.lat), p2 = rad(lat), dl = rad(lon - h.lon);
  const t = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(t));
}

/** Window in days. 0 means all-time, matching config-api's WINDOW_DAYS vocabulary. */
export function windowDays() {
  const n = Number(getConfig('observatory.window_days', 30));
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function sinceTs(days) {
  return days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
}

/** How far did we get — derived from WHAT WE HEARD, which is the whole record.
 *
 *  RECEIVE IS THE ONLY SOURCE OF TRUTH. Peter, 2026-08-05: *"active means
 *  transmit, passive means receive. if transmit was successful then receive will
 *  reflect it. no ambiguity at all."*
 *
 *  A successful transmit IS a reception — the reply arrives and the node lands in
 *  `nodes`. So transmitting cannot produce a node we have not heard, and reach
 *  derived from traceroute is a strict SUBSET of reach derived from reception.
 *  Measured: 115 traceroute-confirmed nodes, 113 of them also heard, **0** never
 *  heard, and 851 heard that traceroute never confirmed. That 0 is not a finding
 *  about the discovery engine; it is a tautology.
 *
 *  The previous version of this function derived everything from
 *  `traceroute_history` and therefore served 189.1 km while `nodes` already held
 *  285.8 km at zero hops. It reported LESS than the truth we already had, which
 *  is the one thing the model forbids: *"passive data is the ONLY real truth. it
 *  can be increased by active but can never be less than."*
 *
 *  HOPS ARE NOT A FILTER. The goal is distance — *"how far can we get"* — so a
 *  node heard at seven hops still counts as reach. Hops survive only as a QUALITY
 *  RANKING: 100 km direct beats 100 km through seven relays, expressed as
 *  `km_per_hop`. Served, so the browser ranks nothing itself.
 */
export function frontier(days = windowDays()) {
  const h = home();
  const maxKm = Number(getConfig('reach', {})?.max_plausible_km ?? 500);
  const empty = { window_days: days, furthest_km: null, furthest_node: null,
                  heard: 0, confirmed: 0, best_quality: null, scale_max_km: maxKm };
  if (!h) return { ...empty, ready: false, reason: 'no home position' };

  // THE FLOOR: everything we have heard. `hops` may be null — unknown hop count
  // is not zero hops, and it must not flatter the quality ranking.
  const rows = db.prepare(`
    SELECT n.num, n.short_name, n.lat, n.lon, n.hops, n.last_heard, n.rf_last_heard
      FROM nodes n
     WHERE n.lat IS NOT NULL AND n.lat != 0
       AND n.last_heard IS NOT NULL AND n.last_heard > ?`).all(sinceTs(days));

  // Traceroute CONFIRMS; it never establishes. Used only to mark which of the
  // heard nodes we have also completed a round trip with.
  const confirmed = new Set(
    db.prepare(`SELECT DISTINCT to_num FROM traceroute_history
                 WHERE status = 'ok' AND ts > ?`).all(sinceTs(days)).map(r => r.to_num));

  let far = null, farNode = null, best = null, bestNode = null;
  let heard = 0, confirmedHeard = 0, beyondScale = 0;

  for (const r of rows) {
    const d = km(h, r.lat, r.lon);
    if (!(d <= maxKm)) { beyondScale++; continue; }
    heard++;
    if (confirmed.has(r.num)) confirmedHeard++;
    if (far == null || d > far) { far = d; farNode = r.short_name; }
    // Quality: distance per leg. hops=0 means one leg (us -> them), so +1.
    if (r.hops != null && r.hops >= 0) {
      const q = d / (r.hops + 1);
      if (best == null || q > best) { best = q; bestNode = r.short_name; }
    }
  }

  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  return {
    ready: true,
    window_days: days,
    furthest_km: r1(far), furthest_node: farNode,
    heard, confirmed: confirmedHeard,
    best_quality_km_per_hop: r1(best), best_quality_node: bestNode,
    // NOT a plausibility gate, and not a claim that the excluded rows are junk.
    // It bounds the DISPLAY SCALE. The furthest excluded rows cluster coherently
    // in real places — six nodes in Galicia at ~1020-1067 km, Lisbon, Tenerife,
    // and MLBR in Poland, which this file previously libelled as a bad GPS fix.
    // Random corrupt coordinates do not cluster geographically.
    scale_max_km: maxKm, beyond_scale: beyondScale,
    caveat: 'Derived from receptions — every node here reached us, so it is alive and '
          + 'reachable. `confirmed` counts those a traceroute also round-tripped; that '
          + 'adds confidence, never distance. Hops rank quality (km_per_hop), they do '
          + 'not gate reach. Nodes beyond scale_max_km are excluded from the SCALE, not '
          + 'judged invalid — but note nothing here separates an RF path from an '
          + 'MQTT-carried one (see packet-provenance-capture), so distance alone does '
          + 'not prove radio reach.',
  };
}

router.get('/snapshot/frontier', (req, res) => {
  try {
    const d = req.query.days != null ? Number(req.query.days) : windowDays();
    res.json(frontier(Number.isFinite(d) && d >= 0 ? d : windowDays()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
