import { Router } from 'express';
import { getCachedGeocode, setCachedGeocode, geocodeBacklog, stmts } from './db.js';

const router = Router();
let _geocodeQueue = Promise.resolve();

// Shared lookup — the WS geocode RPC (ws-relay) and the REST route (curl/
// debug only; browser GETs are blocked) both use this. Nominatim etiquette
// (1.1 s serial queue) is enforced here regardless of caller.
export async function lookupGeocode(num) {
  if (!num) return null;

  const cached = getCachedGeocode(num);
  if (cached) return cached;

  const pos = stmts.getNodePos.get(num, num);
  if (!pos?.lat || !pos?.lon) return null;

  const address = await (_geocodeQueue = _geocodeQueue.then(() =>
    new Promise(resolve => setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${pos.lat}&lon=${pos.lon}&format=jsonv2&zoom=18&addressdetails=1`;
        const r = await fetch(url, { headers: { 'User-Agent': 'node-dash/1.0', 'Accept-Language': 'en' } });
        const data = await r.json();
        const a = data.address || {};
        const road   = [a.house_number, a.road].filter(Boolean).join(' ');
        const place  = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.locality || '';
        const county = a.county || a.state_district || a.state || '';
        const seen   = new Set();
        const parts  = [road, place, a.postcode, county, a.country]
          .filter(p => p && !seen.has(p) && seen.add(p));
        resolve(parts.join(', ') || (data.display_name || '').split(',').slice(0, 3).join(', ') || `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`);
      } catch (_) {
        resolve(`${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`);
      }
    }, 1100))
  ));

  setCachedGeocode(num, address);
  return address;
}

// ─── Backfill ───────────────────────────────────────────────────────────────
//
// Names every positioned node we have never looked up, slowly.
//
// PACED AT 3 s, NOT AT THE QUEUE'S 1.1 s, and the gap is the point. lookupGeocode
// shares ONE serial queue with the interactive WS/REST callers, so firing 407
// nodes into it at once would put a user's geocode request behind up to seven
// minutes of backfill. Leaving room between items lets an interactive lookup
// slot in and answer at normal speed. The backfill is never in a hurry; the
// person waiting on a node page is.
//
// IDEMPOTENT AND RESUMABLE by construction: the backlog query asks for nodes
// with no cached address, so a restart picks up exactly where it stopped and a
// completed backfill finds nothing to do. No cursor, no state to corrupt.
const BACKFILL_GAP_MS = 3000;
let _backfillRunning = false;

export async function runGeocodeBackfill({ gapMs = BACKFILL_GAP_MS } = {}) {
  if (_backfillRunning) return { skipped: 'already running' };
  _backfillRunning = true;
  const todo = geocodeBacklog();
  let done = 0, failed = 0;
  if (todo.length) console.log(`[geocode] backfill: ${todo.length} positioned nodes without an address`);
  try {
    for (const num of todo) {
      try {
        const a = await lookupGeocode(num);
        if (a) done++; else failed++;
      } catch (e) {
        failed++;
        console.error(`[geocode] backfill ${num}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, gapMs));
    }
  } finally {
    _backfillRunning = false;
  }
  if (todo.length) console.log(`[geocode] backfill complete: ${done} named, ${failed} unresolved`);
  return { attempted: todo.length, done, failed };
}

/** Deferred so a long backfill cannot delay the port opening, and re-run daily
 *  because new nodes arrive with positions all the time. */
export function startGeocodeBackfill() {
  setTimeout(() => { runGeocodeBackfill().catch(e => console.error('[geocode] backfill failed:', e.message)); }, 20_000);
  setInterval(() => { runGeocodeBackfill().catch(e => console.error('[geocode] backfill failed:', e.message)); }, 24 * 3600_000);
}

router.get('/', async (req, res) => {
  const num = parseInt(req.query.num) || 0;
  res.json({ address: await lookupGeocode(num) });
});

export default router;
