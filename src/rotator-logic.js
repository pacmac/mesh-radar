// rotator-logic.js — shared geo utilities used by active-tracker and node-list
// ACTV mode tracking logic lives in active-tracker.js
// Home position is read dynamically from device-config (SQLite SSOT) via getHomePos().

import { getAllDeviceCfgs } from './device-config.js';

export function getHomePos() {
  const all = getAllDeviceCfgs();
  for (const cfg of Object.values(all)) {
    if (cfg?.is_primary && cfg.fixed_lat != null && cfg.fixed_lon != null) {
      return { lat: cfg.fixed_lat, lon: cfg.fixed_lon };
    }
  }
  return null;
}

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

export function bearingTo(lat2, lon2, lat1, lon1) {
  if (lat1 == null || lon1 == null) {
    const hp = getHomePos();
    if (!hp) return null;
    lat1 = hp.lat; lon1 = hp.lon;
  }
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
           - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function distanceKm(lat2, lon2, lat1, lon1) {
  if (lat1 == null || lon1 == null) {
    const hp = getHomePos();
    if (!hp) return null;
    lat1 = hp.lat; lon1 = hp.lon;
  }
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
