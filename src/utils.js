// Shared pure utilities — SSOT for calculations used by both backend and frontend.
// No Node.js-specific imports. Served to the browser via GET /utils.js (see index.js).

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
           - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Returns signal quality as a percentage (0–100).
// SNR weighted 60%, RSSI 40% — SNR is the better LoRa link indicator.
export function signalQuality(rssi, snr) {
  const hasRssi = rssi != null, hasSnr = snr != null;
  if (!hasRssi && !hasSnr) return 0;
  const snrScore  = hasSnr  ? Math.max(0, Math.min(1, (snr  + 20) / 30)) : null;
  const rssiScore = hasRssi ? Math.max(0, Math.min(1, (rssi + 120) / 70)) : null;
  if (snrScore != null && rssiScore != null) return Math.round((snrScore * 0.6 + rssiScore * 0.4) * 100);
  return Math.round((snrScore ?? rssiScore) * 100);
}

// Canonical Meshtastic node ID string from a numeric node num.
// e.g. 4198102964 → "!fa39f7b4"
export function numToNodeId(num) {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

// Numeric node num from a Meshtastic node ID string.
// e.g. "!fa39f7b4" → 4198102964
export function nodeIdToNum(id) {
  return parseInt((id ?? '').replace('!', ''), 16) || 0;
}
