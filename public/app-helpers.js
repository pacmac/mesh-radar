// Browser-only utilities shared across mixin modules.
// haversine/bearing/signalQuality come from /utils.js (classic script) → window globals.

export const haversine     = (...a) => window.haversine(...a);
export const bearing       = (...a) => window.bearing(...a);
export const signalQuality = (...a) => window.signalQuality(...a);
export const numToNodeId   = (...a) => window.numToNodeId(...a);
export const nodeIdToNum   = (...a) => window.nodeIdToNum(...a);

export async function fetchJSON(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.detail || data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export function nextFrame() { return new Promise(resolve => requestAnimationFrame(resolve)); }

export function rssiPercent(rssi) {
  if (rssi == null) return null;
  return Math.max(0, Math.min(100, Math.round((rssi + 120) / 70 * 100)));
}

export function ageColor(lastHeard, maxAge = 3600) {
  if (!lastHeard) return 'rgba(255,255,255,0.25)';
  const ageSec = Math.max(0, Date.now() / 1000 - lastHeard);
  const t = Math.min(ageSec / maxAge, 1);
  const hue = 55 - t * 55;
  const lit  = 82 - t * 32;
  return `hsl(${hue}, 92%, ${lit}%)`;
}

export function svgElem(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  return el;
}

const DAISY_COLOR_VAR = { primary:'--p', secondary:'--s', accent:'--a', neutral:'--n', info:'--in', success:'--su', warning:'--wa', error:'--er' };

export function themeColor(name) {
  const v = DAISY_COLOR_VAR[name];
  if (!v) return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  return raw ? `oklch(${raw})` : null;
}

export async function geocodeNode(num) {
  if (!num) return null;
  try {
    const { address } = await fetchJSON(`/geocode?num=${num}`);
    return address ?? null;
  } catch (_) { return null; }
}

// Human-readable labels for Meshtastic packet portnums.
export const PORTNUM_LABELS = {
  TEXT_MESSAGE_APP:     'Text Message',
  POSITION_APP:         'Position',
  NODEINFO_APP:         'Node Info',
  TELEMETRY_APP:        'Telemetry',
  TRACEROUTE_APP:       'Traceroute',
  ROUTING_APP:          'Routing',
  ADMIN_APP:            'Admin',
  RANGE_TEST_APP:       'Range Test',
  DETECTION_SENSOR_APP: 'Detection Sensor',
  STORE_FORWARD_APP:    'Store & Forward',
  MAP_REPORT_APP:       'Map Report',
  PAXCOUNTER_APP:       'Paxcounter',
  PRIVATE_APP:          'Private App',
};

// Feed filter options — each `id` encodes the filter key used in feedHidden.
// portnum:X hides packet events with that portnum.
// event:X   hides events of that type.
export const FEED_FILTER_OPTIONS = [
  { id: 'portnum:POSITION_APP',      label: 'Position' },
  { id: 'portnum:NODEINFO_APP',       label: 'Node Info pkt' },
  { id: 'portnum:TELEMETRY_APP',      label: 'Telemetry' },
  { id: 'portnum:ROUTING_APP',        label: 'Routing' },
  { id: 'portnum:TRACEROUTE_APP',     label: 'Traceroute' },
  { id: 'portnum:RANGE_TEST_APP',     label: 'Range Test' },
  { id: 'portnum:ADMIN_APP',          label: 'Admin' },
  { id: 'portnum:MAP_REPORT_APP',     label: 'Map Report' },
  { id: 'portnum:PRIVATE_APP',        label: 'Private App' },
  { id: 'event:node_update',          label: 'Node Update' },
  { id: 'event:node_info',            label: 'Node Info' },
  { id: 'event:telemetry_update',     label: 'Telemetry Update' },
  { id: 'event:tilt_update',          label: 'Tilt Update' },
  { id: 'event:config_complete_id',   label: 'Sync Complete' },
  { id: 'event:reconnecting',         label: 'Reconnecting' },
];

export function summarizeEvent(ev) {
  switch (ev.type) {
    case 'packet': {
      const pkt = ev.data?.packet;
      const portnum = pkt?.decoded?.portnum || '?';
      const label = PORTNUM_LABELS[portnum] || portnum;
      return `${label} from !${(pkt?.from ?? 0).toString(16)}`;
    }
    case 'node_info': {
      const u = ev.data?.node_info?.user;
      return u ? `${u.long_name} (${u.id})` : 'node update';
    }
    case 'config_complete_id': return 'NodeDB sync complete';
    case 'mqttClientProxyMessage': return ev.data?.mqttClientProxyMessage?.topic || '';
    default: return '';
  }
}
