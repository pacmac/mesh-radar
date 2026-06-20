// rotator-logic.js — shared geo utilities used by active-tracker and node-list
// ACTV mode tracking logic lives in active-tracker.js

const HOME_LAT = process.env.HOME_LAT ? parseFloat(process.env.HOME_LAT) : null;
const HOME_LON = process.env.HOME_LON ? parseFloat(process.env.HOME_LON) : null;

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

export function bearingTo(lat2, lon2, lat1 = HOME_LAT, lon1 = HOME_LON) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
           - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function distanceKm(lat2, lon2, lat1 = HOME_LAT, lon1 = HOME_LON) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
