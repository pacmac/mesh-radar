import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { stmts } from './db.js';
import { getRotatorDeviceId } from './device-config.js';

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

export function handlePacketForRotator(event) {
  if (dashMode.value !== 1) return; // passive — do nothing
  if (!rotator.connected) return;

  // Only use packets received by the designated rotator radio
  const rotatorId = getRotatorDeviceId();
  if (rotatorId && event.device !== rotatorId) return;

  const packet = event.data?.packet;
  if (!packet?.from) return;

  // Skip self-heard packets (rotator radio hearing its own transmissions)
  if (rotatorId && packet.from === parseInt(rotatorId.slice(1), 16)) return;

  const portnum = packet.decoded?.portnum;

  let lat = null, lon = null;

  if (portnum === 'POSITION_APP') {
    const pos = packet.decoded?.position;
    if (pos?.latitude_i != null) {
      lat = pos.latitude_i / 1e7;
      lon = pos.longitude_i / 1e7;
    }
  } else if (portnum === 'NODEINFO_APP' || portnum === 'TELEMETRY_APP' || portnum === 'TEXT_MESSAGE_APP') {
    // Use stored position for any heard packet
    const row = stmts.getNodePos?.get(packet.from);
    if (row) { lat = row.lat; lon = row.lon; }
  }

  if (lat == null || lon == null) return;

  const az = bearingTo(lat, lon);
  if (az == null) return;

  console.log(`[rotator] active: from=${packet.from} az=${az.toFixed(1)}°`);
  rotator.move(az);
  rotator.emit('point_target', { point_target: packet.from, az });
}
