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

/** The hero band: how far did we actually get, inside this window.
 *
 *  TWO DIFFERENT CLAIMS, never merged — the mockup's first pass conflated them:
 *    contact  any completed traceroute, however many relays carried it
 *    direct   route[0] (we reached the first hop ourselves) or an empty route
 *             (the endpoint answered with no relay at all)
 *  "We talked to something 189 km away" and "we reached something 48 km away
 *  ourselves" are not the same sentence, and only the second describes our reach.
 */
export function frontier(days = windowDays()) {
  const h = home();
  const maxKm = Number(getConfig('reach', {})?.max_plausible_km ?? 500);
  const empty = { window_days: days, furthest_contact_km: null, furthest_contact_node: null,
                  furthest_direct_km: null, furthest_direct_node: null,
                  contacted: 0, direct: 0, doors_used: 0, max_plausible_km: maxKm };
  if (!h) return { ...empty, ready: false, reason: 'no home position' };

  const rows = db.prepare(`
    SELECT t.to_num, t.route, n.short_name, n.lat, n.lon
      FROM traceroute_history t JOIN nodes n ON n.num = t.to_num
     WHERE t.status = 'ok' AND t.ts > ?
       AND n.lat IS NOT NULL AND n.lat != 0`).all(sinceTs(days));

  const contacted = new Set(), direct = new Set(), doors = new Set();
  let fc = null, fcNode = null, fd = null, fdNode = null;

  for (const r of rows) {
    const d = km(h, r.lat, r.lon);
    if (!(d <= maxKm)) continue;                       // the gate, applied once
    contacted.add(r.to_num);
    if (fc == null || d > fc) { fc = d; fcNode = r.short_name; }

    let route = null;
    try { route = JSON.parse(r.route ?? 'null'); } catch { /* malformed */ }
    const relayed = Array.isArray(route) && route.length > 0;
    if (relayed) { if (route[0] != null) doors.add(Number(route[0])); }
    else {
      // no relay in the path: this one we reached ourselves
      direct.add(r.to_num);
      if (fd == null || d > fd) { fd = d; fdNode = r.short_name; }
    }
  }

  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  return {
    ready: true,
    window_days: days,
    furthest_contact_km: r1(fc), furthest_contact_node: fcNode,
    furthest_direct_km:  r1(fd), furthest_direct_node:  fdNode,
    contacted: contacted.size, direct: direct.size, doors_used: doors.size,
    max_plausible_km: maxKm,
    // Said out loud so a reader cannot mistake one for the other.
    caveat: 'furthest_contact_km may have been carried by relays; furthest_direct_km '
          + 'is a path with no relay at all. Only the second describes our own reach.',
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
