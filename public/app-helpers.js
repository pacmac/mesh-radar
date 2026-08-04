// Browser-only utilities shared across mixin modules.
// haversine/bearing/signalQuality come from /utils.js (classic script) → window globals.

export const haversine     = (...a) => window.haversine(...a);
export const bearing       = (...a) => window.bearing(...a);
export const signalQuality = (...a) => window.signalQuality(...a);
export const numToNodeId   = (...a) => window.numToNodeId(...a);
export const nodeIdToNum   = (...a) => window.nodeIdToNum(...a);

// ── Tones and bands ────────────────────────────────────────────────────────
//
// The ONE thing this layer is allowed to decide: how a semantic tone looks.
// Mapping `success` to a CSS class is presentation. Deciding that 12 dB is
// "Good" is not, and no longer happens anywhere in public/ — the server serves
// either a per-row verdict or the band table itself.
//
// BROWSER_CONTRACT: "if a display differs based on a condition, that condition
// is evaluated in Node.js."
export const TONE = {
  success: { cls: 'text-success',         badge: 'badge-success', colour: 'oklch(var(--su))' },
  info:    { cls: 'text-info',            badge: 'badge-info',    colour: 'oklch(var(--in))' },
  warning: { cls: 'text-warning',         badge: 'badge-warning', colour: 'oklch(var(--wa))' },
  error:   { cls: 'text-error',           badge: 'badge-error',   colour: 'oklch(var(--er))' },
  muted:   { cls: 'text-base-content/30', badge: 'badge-ghost',   colour: 'oklch(var(--bc)/0.15)' },
};
export const toneCls    = t => (TONE[t] ?? TONE.muted).cls;
export const toneBadge  = t => (TONE[t] ?? TONE.muted).badge;
export const toneColour = t => (TONE[t] ?? TONE.muted).colour;

/** Look a value up in a SERVED band table. The bands and their order come from
 *  the server; this walks them. `min: null` is the catch-all — JSON cannot
 *  carry -Infinity, so the server emits null and it always matches.
 *
 *  Returns null when the table has not arrived yet, so callers render a muted
 *  placeholder rather than inventing a band. */
export function bandFor(value, bands) {
  if (!Array.isArray(bands) || !bands.length) return null;
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  return bands.find(b => b.min == null || v >= b.min) ?? bands[bands.length - 1];
}

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

// Traceroute SNR arrives ALREADY IN dB, with null for hops the firmware could
// not measure. The quarter-dB decoder that used to live here has moved to
// src/snr.js — a backend-only module — because the Meshtastic wire format is gw
// API knowledge and CLAUDE.md Domain 2 says the browser has none of it.
// Peter, 2026-08-04: "that is a blant violation of the UI rule."
// Nothing in public/ may divide by 4 or test for -128 again.

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

// geocodeNode moved to the WS RPC (wsGeocode in app-ws.js) — settings-via-ws

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
  { id: 'portnum:TEXT_MESSAGE_APP',   label: 'Messages' },
  { id: 'portnum:POSITION_APP',       label: 'Position' },
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
