import { Router } from 'express';
import { getCachedGeocode, setCachedGeocode, stmts } from './db.js';

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

router.get('/', async (req, res) => {
  const num = parseInt(req.query.num) || 0;
  res.json({ address: await lookupGeocode(num) });
});

export default router;
